// api/test-notion.ts
import 'dotenv/config';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Client } from '@notionhq/client';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const token = process.env.NOTION_API_TOKEN;
    const dbId  = process.env.NOTION_DATABASE_ID;
    if (!token) throw new Error('Missing NOTION_API_TOKEN');
    if (!dbId) throw new Error('Missing NOTION_DATABASE_ID');

    const notion = new Client({ auth: token });
    const db: any = await notion.databases.retrieve({ database_id: dbId });

    const title =
      Array.isArray(db?.title) && db.title.length ? db.title[0]?.plain_text ?? null : null;

    res.status(200).json({
      ok: true,
      databaseId: db?.id ?? dbId,
      title
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'error' });
  }
}
