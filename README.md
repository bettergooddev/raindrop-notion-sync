# Raindrop → Notion Sync

Stateless TypeScript/Vercel worker that mirrors **Raindrop.io** bookmarks into a **Notion** database.

- **Create** new Notion rows for new Raindrop items (every 5 min)
- **Upsert** rows when Raindrop items change (title/tags/note/etc.)
- **Reconcile deletions** nightly with a grace period and safe archiving
- Idempotency via **Raindrop ID** (no duplicates)

---

## How it works

The service is **pull-based** and stateless. Notion acts as the **ledger** keyed by `Raindrop ID`.

- Every 5 minutes `/api/sync` runs two passes within a time window:
  1. **New items**: page by `-created`, stop once we’re past the window and see many consecutive “already exists”.
  2. **Updated items**: search by `lastUpdate:>SINCE` (plus `created:>SINCE` as a safety net), union the sets, then upsert.
- Nightly `/api/reconcile` enumerates **all** Raindrop IDs and all Notion rows → computes a set difference to find **moved** vs **deleted**. Deleted rows are flagged immediately, then archived after a grace period.

---

## Architecture

- **Runtime:** Node 18+ on Vercel Functions  
- **Language:** TypeScript (ESM, `moduleResolution: NodeNext`)  
- **Folders:** `api/` (endpoints), `lib/` (Raindrop/Notion helpers)

### Endpoints

- `GET /api/sync` — main 5-min poller (create + upsert)  
  Query params:
  - `dryRun=1` (optional) — report only, no writes
  - `limit=<n>` (optional) — hard cap processed items

- `GET /api/reconcile` — nightly set-difference (moved/deleted)  
  Query params:
  - `dryRun=1` (optional) — report only; **defaults to real mode** otherwise

- (Optional debug)
  - `GET /api/test-raindrop`
  - `GET /api/test-notion`
  - `GET /api/inspect-raindrop?id=<id>`

### Schedulers (Vercel cron, UTC)

```json
{
  "crons": [
    { "path": "/api/sync", "schedule": "*/5 * * * *" },
    { "path": "/api/reconcile", "schedule": "0 9 * * *" }
  ]
}
```

`0 9 * * *` ≈ **02:00 PT** most of the year.

---

## Environment variables

> **Note:** Don’t put inline comments on the same line as values in your `.env`.

**Required**
```env
RAINDROP_ACCESS_TOKEN=...
RAINDROP_COLLECTION_ID=...
NOTION_API_TOKEN=...
NOTION_DATABASE_ID=...
```

**Time-window knobs (defaults shown)**
```env
LOOKBACK_HOURS=48
OVERLAP_MINUTES=15
# Optional scan bounds (defaults baked in; set only if you want to tune)
# PER_PAGE=50
# MAX_PAGES=10
# CONSECUTIVE_HITS_STOP=50
```

**Deletion policy (defaults shown)**
```env
DELETE_MODE=archive
DELETE_GRACE_HOURS=24
```

Set envs in **Vercel → Project → Settings → Environment Variables**. Never commit secrets.

---

## Local development

```bash
npm install
npx vercel dev
# dry runs
open http://localhost:3000/api/sync?dryRun=1
open http://localhost:3000/api/reconcile?dryRun=1
```

Remove `dryRun=1` to actually write. (`/api/reconcile` defaults to **real mode**.)

---

## Deployment

1. Push to GitHub.
2. In Vercel, connect the repo.
3. Add environment variables → **Redeploy**.
4. Validate in prod:
   - `GET https://<app>.vercel.app/api/sync?dryRun=1`
   - `GET https://<app>.vercel.app/api/reconcile?dryRun=1`
5. Let cron run.

---

## Behavior details

- **Idempotency:** Notion row exists if `Raindrop ID` matches → no duplicate create.
- **Upsert rule:** if row exists, `Lock` is **unchecked**, and `item.lastUpdate > Raindrop LastUpdate`, overwrite mapped fields and bump **Raindrop LastUpdate** + **Synced At**. We don’t touch `Status` except in delete flow.
- **Moved items:** nightly reconcile updates the **Collection** field (respects Lock).
- **Deleted items:** reconcile sets **Deleted (Raindrop)** + **Delete Detected At**; after `DELETE_GRACE_HOURS`, archives the page and sets **Status = Archived** (if enabled). Lock prevents changes.

---

## Troubleshooting

- “Missing … TOKEN” → confirm envs and restart/redeploy.
- Notion 400 “property not found” → property name/type mismatch.
- Row not updating → ensure `Lock` is unchecked; compare Raindrop `lastUpdate` vs Notion “Raindrop LastUpdate”.
- Deletion not archiving → confirm `DELETE_MODE=archive`, grace elapsed, and request wasn’t dry-run.

---

## Security

- Tokens only in environment variables.
- Pull-only; no inbound webhooks.
- Prefer a **dedicated** Notion integration with access restricted to the target DB.

## License

Private/internal (add a license if open-sourcing).
