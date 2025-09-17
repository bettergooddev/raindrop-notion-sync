// api/sync.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchRecentRaindrops } from '../lib/raindrop';
import { pageExists, createFromRaindrop } from '../lib/notion';

const RAINDROP_COLLECTION_ID = process.env.RAINDROP_COLLECTION_ID!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!RAINDROP_COLLECTION_ID) throw new Error('Missing RAINDROP_COLLECTION_ID');

    const items = await fetchRecentRaindrops(RAINDROP_COLLECTION_ID, 50);

    let created = 0;
    for (const item of items) {
      const exists = await pageExists(item._id);
      if (exists) continue;

      await createFromRaindrop(item);
      created += 1;

      // polite pacing for external APIs
      await new Promise((r) => setTimeout(r, 150));
    }

    res.status(200).json({ checked: items.length, created });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Error' });
  }
}
