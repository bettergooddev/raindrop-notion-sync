// lib/notion.ts
import { Client } from '@notionhq/client';
import type { RaindropItem } from './raindrop';

const NOTION_TOKEN = process.env.NOTION_API_TOKEN!;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID!;

export const notion = new Client({ auth: NOTION_TOKEN });

function toMultiSelect(tags?: string[]) {
  return (tags ?? []).slice(0, 50).map((t) => ({ name: t }));
}

export async function pageExists(raindropId: number) {
  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: {
      property: 'Raindrop ID',
      number: { equals: raindropId }
    },
    page_size: 1
  });

  return response.results[0];
}

export async function createFromRaindrop(item: RaindropItem) {
  return notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      'Title': { title: [{ text: { content: item.title || 'Untitled' } }] },
      'URL': { url: item.link },
      'Tags': { multi_select: toMultiSelect(item.tags) },
      'Excerpt': { rich_text: item.excerpt ? [{ text: { content: item.excerpt } }] : [] },
      'Site': { rich_text: item.domain ? [{ text: { content: item.domain } }] : [] },
      'Collection': item.collection?.title
        ? { rich_text: [{ text: { content: item.collection.title } }] }
        : { rich_text: [] },
      'Created': { date: { start: item.created } },
      'Raindrop ID': { number: item._id }
    }
  });
}
