// api/sync.ts
import { config } from 'dotenv';
config({ path: '.env.local' }); // or '.env'

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  fetchRecentRaindrops,
  fetchRaindropsBySearch,
  getCollectionTitleById,
  type RaindropItem
} from '../lib/raindrop.js';
import {
  getPagesByRaindropIds,
  createFromRaindrop,
  updateFromRaindrop
} from '../lib/notion.js';


// --- helpers ---
function getQP(q: Record<string, string | string[] | undefined>, key: string) {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}
function toBool(s?: string) {
  if (!s) return false;
  return ['1', 'true', 'yes', 'on'].includes(s.toLowerCase());
}
function toIntInRange(s: string | undefined, def: number, min: number, max: number) {
  const n = s ? parseInt(s, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function newerThan(a?: string, b?: string) {
  if (!a) return false;
  if (!b) return true;
  return new Date(a).getTime() > new Date(b).getTime();
}
function isoDateOnly(d: Date) {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

// env knobs with defaults
function envInt(name: string, def: number) {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Allow POST (Notion button) or GET (cron/manual)
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method not allowed' });
    }
    
    // Vercel cron requests include this header
    const isCron = req.headers['x-vercel-cron'] === '1';
    
    // Require token only for POSTs that are NOT cron
    const requireToken = req.method === 'POST' && !isCron;
    
    if (requireToken && process.env.TRIGGER_TOKEN) {
        const headerToken = req.headers['x-webhook-token'] as string | undefined;
        const queryToken =
        typeof req.query.token === 'string' ? req.query.token : undefined;
        const token = headerToken ?? queryToken;
        if (token !== process.env.TRIGGER_TOKEN) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
    }
    try {
        const RAINDROP_COLLECTION_ID = process.env.RAINDROP_COLLECTION_ID!;
    if (!RAINDROP_COLLECTION_ID) throw new Error('Missing RAINDROP_COLLECTION_ID');

    // debug knobs (still supported)
    const limitQP = toIntInRange(getQP(req.query, 'limit'), 50, 1, 500);
    const dryRun = toBool(getQP(req.query, 'dryRun'));

    // scan knobs
    const LOOKBACK_HOURS = envInt('LOOKBACK_HOURS', 48);
    const OVERLAP_MINUTES = envInt('OVERLAP_MINUTES', 15);
    const PER_PAGE = envInt('PER_PAGE', 50);
    const MAX_PAGES = envInt('MAX_PAGES', 10);
    const CONSECUTIVE_HITS_STOP = envInt('CONSECUTIVE_HITS_STOP', 50);

    // time window
    const now = new Date();
    const since = new Date(now.getTime() - (LOOKBACK_HOURS * 60 + OVERLAP_MINUTES) * 60 * 1000);
    const sinceDateOnly = isoDateOnly(since);

    // Resolve default collection title once
    const defaultCollectionTitle =
      (await getCollectionTitleById(RAINDROP_COLLECTION_ID).catch(() => undefined)) ?? undefined;

    // ---- PASS A: recent by created desc with stop rules ----
    const passAItems = new Map<number, RaindropItem>();
    let consecutiveExisting = 0;
    let pagesFetchedA = 0;
    let stopReasonA: string | null = null;

    // Allow a dev-time limit (if user passed ?limit=) to cap the first page, else use PER_PAGE
    const perPageA = limitQP && limitQP < PER_PAGE ? limitQP : PER_PAGE;

    for (let page = 0; page < MAX_PAGES; page++) {
      const pageItems = await fetchRecentRaindrops(RAINDROP_COLLECTION_ID, perPageA, page);
      pagesFetchedA++;

      if (pageItems.length === 0) {
        stopReasonA = 'no-more-items';
        break;
      }

      // We need existence info to advance "consecutive existing" safely.
      const existingMap = await getPagesByRaindropIds(pageItems.map((i) => i._id));

      for (const it of pageItems) {
        const createdOld = new Date(it.created) < since;

        if (existingMap.has(it._id)) {
          consecutiveExisting++;
        } else {
          consecutiveExisting = 0;
        }

        // Only keep items inside our time window (new creates by created)
        if (!createdOld) {
          passAItems.set(it._id, it);
        }

        // Stop condition: once we’re past the window *and* have many consecutive hits, bail
        if (createdOld && consecutiveExisting >= CONSECUTIVE_HITS_STOP) {
          stopReasonA = 'time-window-and-consecutive-existing';
          break;
        }
      }

      if (stopReasonA) break;

      // If this page returned less than requested, likely at the end
      if (pageItems.length < perPageA) {
        stopReasonA = 'short-final-page';
        break;
      }

      // If user forced a small limit via ?limit=, stop after first page
      if (limitQP && limitQP <= PER_PAGE) {
        stopReasonA = 'debug-limit';
        break;
      }
    }

    // ---- PASS B: union of updated items (and created since for completeness) ----
    // We'll run two searches and union the results by ID.
    // Use YYYY-MM-DD date-only filter for robustness.
    const passBItems = new Map<number, RaindropItem>();
    let pagesFetchedB = 0;

    // lastUpdate since
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageItems = await fetchRaindropsBySearch(
        RAINDROP_COLLECTION_ID,
        `lastUpdate:>${sinceDateOnly}`,
        PER_PAGE,
        page,
        '-created'
      );
      pagesFetchedB++;
      if (pageItems.length === 0) break;
      for (const it of pageItems) passBItems.set(it._id, it);
      if (pageItems.length < PER_PAGE) break;
    }

    // created since (some APIs evaluate search differently; grab both and union)
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageItems = await fetchRaindropsBySearch(
        RAINDROP_COLLECTION_ID,
        `created:>${sinceDateOnly}`,
        PER_PAGE,
        page,
        '-created'
      );
      pagesFetchedB++;
      if (pageItems.length === 0) break;
      for (const it of pageItems) passBItems.set(it._id, it);
      if (pageItems.length < PER_PAGE) break;
    }

    // ---- UNION: candidates from both passes ----
    const candidates = new Map<number, RaindropItem>();
    for (const [id, it] of passAItems) candidates.set(id, it);
    for (const [id, it] of passBItems) candidates.set(id, it);

    // If user passed ?limit=, keep it a hard cap for safety/debug
    const candidateList = Array.from(candidates.values()).slice(0, limitQP || candidates.size);

    // Build a batched existence/metadata map from Notion for all candidates
    const existingMapAll = await getPagesByRaindropIds(candidateList.map((i) => i._id));

    // ---- Decide create vs update (respect Lock; update only if lastUpdate newer) ----
    let created = 0;
    let updated = 0;

    const createdIds: number[] = [];
    const updatedIds: number[] = [];
    const toCreatePreview: number[] = [];
    const toUpdatePreview: number[] = [];
    const skippedLocked: number[] = [];
    const alreadyExists: number[] = [];

    for (const item of candidateList) {
      const found = existingMapAll.get(item._id);

      // Resolve collection title per item (covers moved items)
      const collId =
        (item as any).collectionId ??
        item.collection?.$id ??
        RAINDROP_COLLECTION_ID;
      const collectionTitle =
        (collId ? await getCollectionTitleById(collId) : undefined) ??
        defaultCollectionTitle;

      if (!found) {
        if (dryRun) {
          toCreatePreview.push(item._id);
        } else {
          await createFromRaindrop(item, { collectionTitle });
          created += 1;
          createdIds.push(item._id);
          await new Promise((r) => setTimeout(r, 150));
        }
        continue;
      }

      if (found.locked) {
        skippedLocked.push(item._id);
        alreadyExists.push(item._id);
        continue;
      }

      const itemLast = item.lastUpdate || item.created;
      const notionLast = found.raindropLastUpdate;

      if (newerThan(itemLast, notionLast)) {
        if (dryRun) {
          toUpdatePreview.push(item._id);
        } else {
          await updateFromRaindrop(found.pageId, item, { collectionTitle });
          updated += 1;
          updatedIds.push(item._id);
          await new Promise((r) => setTimeout(r, 150));
        }
      } else {
        alreadyExists.push(item._id);
      }
    }

    // ---- Report ----
    res.status(200).json({
      dryRun,
      window: {
        lookbackHours: LOOKBACK_HOURS,
        overlapMinutes: OVERLAP_MINUTES,
        sinceDate: since.toISOString()
      },
      passA: {
        pagesFetched: pagesFetchedA,
        stopReason: stopReasonA ?? 'completed',
        candidates: passAItems.size
      },
      passB: {
        pagesFetched: pagesFetchedB,
        candidates: passBItems.size
      },
      unionCandidates: candidateList.length,
      created,
      updated,
      createdIds: dryRun ? undefined : createdIds,
      updatedIds: dryRun ? undefined : updatedIds,
      toCreatePreview: dryRun ? toCreatePreview : undefined,
      toUpdatePreview: dryRun ? toUpdatePreview : undefined,
      skippedLocked,
      alreadyExists
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Error' });
  }
}
