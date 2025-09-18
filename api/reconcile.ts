// api/reconcile.ts
import { config } from 'dotenv';
config({ path: '.env' }); // or '.env'

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchRecentRaindrops,
  fetchRaindropDetail,
  getCollectionTitleById,
  type RaindropItem
} from '../lib/raindrop.js';
import {
  listAllNotionRows,
  updateCollectionOnly,
  markDeleteDetected,
  clearDeleteFlags,
  archivePage
} from '../lib/notion.js';

// helpers
function envInt(name: string, def: number) {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}
function toBool(s?: string) {
  if (!s) return false;
  return ['1', 'true', 'yes', 'on'].includes(s.toLowerCase());
}
function hoursSince(iso?: string) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return ms / 36e5;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const RAINDROP_COLLECTION_ID = process.env.RAINDROP_COLLECTION_ID!;
    if (!RAINDROP_COLLECTION_ID) throw new Error('Missing RAINDROP_COLLECTION_ID');

    const PER_PAGE = envInt('PER_PAGE', 50);
    const MAX_PAGES = envInt('MAX_PAGES', 200); // wider for nightly
    const DELETE_MODE = (process.env.DELETE_MODE || 'archive').toLowerCase(); // 'archive' | 'off'
    const DELETE_GRACE_HOURS = envInt('DELETE_GRACE_HOURS', 24);
    const dryRun = toBool(
      (Array.isArray(req.query.dryRun) ? req.query.dryRun[0] : req.query.dryRun) || '0'
    );

    // 1) Enumerate ALL Raindrop IDs in the collection
    const raindropIds = new Set<number>();
    let pagesFetched = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const items: RaindropItem[] = await fetchRecentRaindrops(RAINDROP_COLLECTION_ID, PER_PAGE, page);
      pagesFetched++;
      if (!items.length) break;
      for (const it of items) raindropIds.add(it._id);
      if (items.length < PER_PAGE) break;
    }

    // 2) Enumerate ALL Notion rows (with Raindrop ID)
    const notionRows = await listAllNotionRows();

    const moved: number[] = [];
    const deleteDetected: number[] = [];
    const deleteArchivedNow: number[] = [];
    const skippedLocked: number[] = [];
    const clearedFlags: number[] = [];

    // 3) Compute Notion − Raindrop and resolve each missing ID
    for (const row of notionRows) {
      if (raindropIds.has(row.raindropId)) {
        // still present — if previously flagged deleted, clear flags
        if (row.deletedFlag) {
          if (!dryRun) await clearDeleteFlags(row.pageId);
          clearedFlags.push(row.raindropId);
        }
        continue;
      }

      // Check the item directly to distinguish "moved" vs "deleted"
      const detail = await fetchRaindropDetail(row.raindropId);

      if (detail.exists && !detail.removed) {
        // MOVED to another collection — update the Collection field
        const newTitle = detail.collectionId
          ? await getCollectionTitleById(detail.collectionId).catch(() => undefined)
          : undefined;

        if (!row.locked) {
          if (!dryRun) await updateCollectionOnly(row.pageId, newTitle);
          moved.push(row.raindropId);
          // and clear delete flags if set
          if (row.deletedFlag) {
            if (!dryRun) await clearDeleteFlags(row.pageId);
            clearedFlags.push(row.raindropId);
          }
        } else {
          skippedLocked.push(row.raindropId);
        }
        continue;
      }

      // Truly missing or removed in Raindrop → deletion flow with grace
      if (!row.deletedFlag || !row.deleteDetectedAt) {
        // first detection
        if (!dryRun) await markDeleteDetected(row.pageId, new Date().toISOString(), !row.locked);
        deleteDetected.push(row.raindropId);
      } else {
        const ageHours = hoursSince(row.deleteDetectedAt);
        if (ageHours >= DELETE_GRACE_HOURS) {
          if (DELETE_MODE === 'archive' && !row.locked) {
            if (!dryRun) await archivePage(row.pageId);
            deleteArchivedNow.push(row.raindropId);
          } else {
            // report-only or locked
            skippedLocked.push(row.raindropId);
          }
        } else {
          // still in grace window — nothing to do
          deleteDetected.push(row.raindropId);
        }
      }
    }

    res.status(200).json({
      dryRun,
      deleteMode: DELETE_MODE,
      graceHours: DELETE_GRACE_HOURS,
      raindropCollectionId: RAINDROP_COLLECTION_ID,
      pagesFetchedFromRaindrop: pagesFetched,
      totals: {
        notionRows: notionRows.length,
        raindropIds: raindropIds.size
      },
      results: {
        moved,                 // updated Collection in Notion
        deleteDetected,        // flagged or still within grace
        deleteArchivedNow,     // archived this run (post-grace)
        clearedFlags,          // items reappeared; flags cleared
        skippedLocked          // locked rows we didn’t modify
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Error' });
  }
}
