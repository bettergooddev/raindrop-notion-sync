import 'dotenv/config';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const token = process.env.RAINDROP_ACCESS_TOKEN;
    if (!token) throw new Error('Missing RAINDROP_ACCESS_TOKEN');

    // Hit a lightweight endpoint: current user
    const r = await fetch('https://api.raindrop.io/rest/v1/user', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const ok = r.ok;
    const status = r.status;
    const data = await r.json().catch(() => ({}));

    // Don’t leak token; just return minimal info
    res.status(ok ? 200 : status).json({
      ok,
      status,
      userId: data?.user?._id ?? null,
      plan: data?.user?.pro ? 'pro' : 'free'
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || 'error' });
  }
}
