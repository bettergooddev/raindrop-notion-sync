// lib/notion.ts
import { Client } from '@notionhq/client';

import type { RaindropItem } from './raindrop.js';

const NOTION_TOKEN = process.env.NOTION_API_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID!;

export const notion = new Client({ auth: NOTION_TOKEN });

// Public, version-safe alias for the query response type
type NotionQueryResp = Awaited<
  ReturnType<InstanceType<typeof Client>['databases']['query']>
>;

export type NotionRow = {
    pageId: string;
    raindropId: number;
    locked: boolean;
    deletedFlag: boolean;
    deleteDetectedAt?: string;
  };
  
  // paginate the whole DB and return Raindrop-linked rows
  export async function listAllNotionRows(): Promise<NotionRow[]> {
    const rows: NotionRow[] = [];
    let cursor: string | undefined = undefined;
  
    while (true) {
      const resp: NotionQueryResp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        page_size: 100,
        start_cursor: cursor
      });
      for (const page of resp.results as any[]) {
        const props = page.properties || {};
        const idNum = props['Raindrop ID']?.number as number | undefined;
        if (typeof idNum !== 'number') continue;
  
        rows.push({
          pageId: page.id,
          raindropId: idNum,
          locked: !!props['Lock']?.checkbox,
          deletedFlag: !!props['Deleted (Raindrop)']?.checkbox,
          deleteDetectedAt: props['Delete Detected At']?.date?.start as string | undefined
        });
      }
      if (!resp.has_more) break;
      cursor = resp.next_cursor ?? undefined;
    }
    return rows;
  }
  
  function dateOrNull(iso?: string) {
    return iso ? { date: { start: iso } } : { date: null as any };
  }
  
  // update just the Collection (rich text) and Synced At
  export async function updateCollectionOnly(pageId: string, title?: string) {
    const nowIso = new Date().toISOString();
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Collection': title ? { rich_text: [{ text: { content: title } }] } : { rich_text: [] },
        'Synced At': dateOrNull(nowIso)
      }
    });
  }
  
  // set Deleted (Raindrop)=true and record timestamp
  export async function markDeleteDetected(pageId: string, whenIso: string, setArchived = true) {
    const nowIso = new Date().toISOString();
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Deleted (Raindrop)': { checkbox: true },
        'Delete Detected At': dateOrNull(whenIso),
        'Synced At': dateOrNull(nowIso),
        ...(setArchived ? { 'Status': { select: { name: 'Archived' } } } : {})
      }
    });
  }
  
  // clear deleted flags (e.g., if an item resurfaced/moved back)
  export async function clearDeleteFlags(pageId: string) {
    const nowIso = new Date().toISOString();
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'Deleted (Raindrop)': { checkbox: false },
        'Delete Detected At': { date: null as any },
        'Synced At': dateOrNull(nowIso)
      }
    });
  }
  
  // archive the Notion page (Notion's "delete")
  export async function archivePage(pageId: string) {
    await notion.pages.update({ page_id: pageId, archived: true });
  }
  



function toMultiSelect(tags?: string[]) {
  return (tags ?? []).slice(0, 50).map((t) => ({ name: t }));
}


// ------- existence (single) -------
export async function pageExists(raindropId: number) {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: 'Raindrop ID', number: { equals: raindropId } },
    page_size: 1
  });
  return response.results[0];
}

// ------- existence (batched) -------
const NOTION_QUERY_CHUNK = 25;

export type NotionFound = {
  pageId: string;
  raindropLastUpdate?: string; // from Notion "Raindrop LastUpdate"
  locked: boolean;             // from Notion "Lock" checkbox
};

export async function getPagesByRaindropIds(
  ids: number[]
): Promise<Map<number, NotionFound>> {
  const out = new Map<number, NotionFound>();
  for (let i = 0; i < ids.length; i += NOTION_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + NOTION_QUERY_CHUNK);
    const filter =
      chunk.length === 1
        ? { property: 'Raindrop ID', number: { equals: chunk[0] } }
        : {
            or: chunk.map((id) => ({
              property: 'Raindrop ID',
              number: { equals: id }
            }))
          };

      const resp: NotionQueryResp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      filter,
      page_size: 100
    });

    for (const page of resp.results as any[]) {
      const props = page.properties || {};
      const idProp = props['Raindrop ID']?.number as number | undefined;
      if (typeof idProp !== 'number') continue;

      const lastUpd = props['Raindrop LastUpdate']?.date?.start as string | undefined;
      const locked = !!props['Lock']?.checkbox;

      out.set(idProp, {
        pageId: page.id,
        raindropLastUpdate: lastUpd,
        locked
      });
    }
  }
  return out;
}

// ------- create -------
export async function createFromRaindrop(
  item: RaindropItem,
  opts?: { collectionTitle?: string }
) {
  const collTitle = item.collection?.title || opts?.collectionTitle || '';
  const nowIso = new Date().toISOString();
  const raindropLast = item.lastUpdate || item.created;

  return notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      'Title': { title: [{ text: { content: item.title || 'Untitled' } }] },
      'URL': { url: item.link },
      'Tags': { multi_select: toMultiSelect(item.tags) },
      'Excerpt': { rich_text: item.excerpt ? [{ text: { content: item.excerpt } }] : [] },
      'Notes': { rich_text: item.note ? [{ text: { content: item.note } }] : [] },
      'Site': { rich_text: item.domain ? [{ text: { content: item.domain } }] : [] },

      // If your Notion "Collection" column is SELECT, replace with: { select: { name: collTitle } }
      'Collection': collTitle ? { rich_text: [{ text: { content: collTitle } }] } : { rich_text: [] },

      'Created': { date: { start: item.created } },
      'Raindrop ID': { number: item._id },
      'Status': { select: { name: 'New' } },

      // new metadata fields
      'Raindrop LastUpdate': dateOrNull(raindropLast),
      'Synced At': dateOrNull(nowIso)
    }
  });
}

// ------- update (upsert path) -------
export async function updateFromRaindrop(
  pageId: string,
  item: RaindropItem,
  opts?: { collectionTitle?: string }
) {
  const collTitle = item.collection?.title || opts?.collectionTitle || '';
  const nowIso = new Date().toISOString();
  const raindropLast = item.lastUpdate || item.created;

  return notion.pages.update({
    page_id: pageId,
    properties: {
      'Title': { title: [{ text: { content: item.title || 'Untitled' } }] },
      'URL': { url: item.link },
      'Tags': { multi_select: toMultiSelect(item.tags) },
      'Excerpt': { rich_text: item.excerpt ? [{ text: { content: item.excerpt } }] : [] },
      'Notes': { rich_text: item.note ? [{ text: { content: item.note } }] : [] },
      'Site': { rich_text: item.domain ? [{ text: { content: item.domain } }] : [] },
      'Collection': collTitle ? { rich_text: [{ text: { content: collTitle } }] } : { rich_text: [] },

      // Leave Status alone (user workflow)

      'Created': { date: { start: item.created } },
      'Raindrop LastUpdate': dateOrNull(raindropLast),
      'Synced At': dateOrNull(nowIso)
    }
  });
}
