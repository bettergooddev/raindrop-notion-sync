// lib/raindrop.ts
export type RaindropItem = {
    _id: number;
    title: string;
    link: string;
    excerpt?: string;
    tags?: string[];
    created: string; // ISO timestamp
    domain?: string;
    collection?: { $id: number; title?: string };
  };
  
  const RAINDROP_TOKEN = process.env.RAINDROP_ACCESS_TOKEN!;
  
  function assertEnv() {
    if (!RAINDROP_TOKEN) throw new Error('Missing RAINDROP_ACCESS_TOKEN');
  }
  
  function hostnameFromUrl(url?: string) {
    try {
      if (!url) return undefined;
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  
  export async function fetchRecentRaindrops(
    collectionId: string,
    perPage = 50
  ): Promise<RaindropItem[]> {
    assertEnv();
  
    const url = new URL(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`);
    url.searchParams.set('perpage', String(perPage));
    url.searchParams.set('sort', '-created');
  
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` }
    });
  
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Raindrop fetch failed: ${res.status} ${text}`);
    }
  
    const data = await res.json();
    return (data.items ?? []).map((it: any) => ({
      _id: it._id,
      title: it.title ?? it.link ?? 'Untitled',
      link: it.link,
      excerpt: it.excerpt ?? '',
      tags: Array.isArray(it.tags) ? it.tags : [],
      created: it.created,
      domain: it.domain ?? hostnameFromUrl(it.link),
      collection: it.collection
    }));
  }
  