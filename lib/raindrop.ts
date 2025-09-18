// lib/raindrop.ts

export type RaindropItem = {
    _id: number;
    title: string;
    link: string;
    excerpt?: string;
    note?: string;
    tags?: string[];
    created: string;      // ISO
    lastUpdate?: string;  // ISO
    domain?: string;
    collection?: { $id: number; title?: string };
  };
  
  // Read the token at call-time so it still works if dotenv loads later
  function getRaindropToken(): string {
    const token = process.env.RAINDROP_ACCESS_TOKEN;
    if (!token) throw new Error('Missing RAINDROP_ACCESS_TOKEN');
    return token;
  }
  
  function hostnameFromUrl(url?: string) {
    try {
      if (!url) return undefined;
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  
  function normalizeItems(items: any[]): RaindropItem[] {
    return (items ?? []).map((it: any) => ({
      _id: it._id,
      title: it.title ?? it.link ?? 'Untitled',
      link: it.link,
      excerpt: it.excerpt ?? '',
      note: typeof it.note === 'string' ? it.note : '',
      tags: Array.isArray(it.tags) ? it.tags : [],
      created: it.created,
      lastUpdate: it.lastUpdate,
      domain: it.domain ?? hostnameFromUrl(it.link),
      collection: it.collection
    }));
  }
  
  /** Fetch recent raindrops for a collection (sorted by created desc). */
  export async function fetchRecentRaindrops(
    collectionId: string,
    perPage = 50,
    page = 0
  ): Promise<RaindropItem[]> {
    const url = new URL(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`);
    url.searchParams.set('perpage', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', '-created');
  
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${getRaindropToken()}` }
    });
  
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Raindrop fetch failed: ${res.status} ${text}`);
    }
  
    const data = await res.json();
    return normalizeItems(data.items ?? []);
  }
  
  /**
   * Fetch raindrops by a search filter with pagination.
   * Example searches:
   *  - `created:>2025-09-15`
   *  - `lastUpdate:>2025-09-15`
   */
  export async function fetchRaindropsBySearch(
    collectionId: string,
    search: string,
    perPage = 50,
    page = 0,
    sort: '-created' | 'created' = '-created'
  ): Promise<RaindropItem[]> {
    const url = new URL(`https://api.raindrop.io/rest/v1/raindrops/${collectionId}`);
    url.searchParams.set('perpage', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', sort);
    url.searchParams.set('search', search);
  
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${getRaindropToken()}` }
    });
  
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Raindrop search failed: ${res.status} ${text}`);
    }
  
    const data = await res.json();
    return normalizeItems(data.items ?? []);
  }
  
  /** Fetch a collection's title once (items often only include {$id}). */
  export async function fetchCollectionTitle(collectionId: string): Promise<string | undefined> {
    const res = await fetch(`https://api.raindrop.io/rest/v1/collection/${collectionId}`, {
      headers: { Authorization: `Bearer ${getRaindropToken()}` }
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    return (data?.item?.title as string | undefined) ?? undefined;
  }
  
  const collectionTitleCache = new Map<string, string>();
  export async function getCollectionTitleById(id: string | number): Promise<string | undefined> {
    const key = String(id);
    if (collectionTitleCache.has(key)) return collectionTitleCache.get(key);
  
    const res = await fetch(`https://api.raindrop.io/rest/v1/collection/${key}`, {
      headers: { Authorization: `Bearer ${getRaindropToken()}` }
    });
    if (!res.ok) return undefined;
  
    const data = await res.json();
    const title: string | undefined = data?.item?.title;
    if (title) collectionTitleCache.set(key, title);
    return title;
  }
  

export type RaindropDetail = {
    exists: boolean;
    removed?: boolean;
    collectionId?: number;
    lastUpdate?: string;
  };
  
  export async function fetchRaindropDetail(id: number): Promise<RaindropDetail> {
    const res = await fetch(`https://api.raindrop.io/rest/v1/raindrop/${id}`, {
      headers: { Authorization: `Bearer ${getRaindropToken()}` }
    });
  
    if (res.status === 404) return { exists: false };
    if (!res.ok) return { exists: false }; // treat non-200 as missing for safety
  
    const data = await res.json();
    const item = data?.item;
    if (!item) return { exists: false };
  
    return {
      exists: true,
      removed: !!item.removed,
      collectionId: item.collectionId ?? item.collection?.$id,
      lastUpdate: item.lastUpdate
    };
  }
  