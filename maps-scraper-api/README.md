# Maps Scraper API

Backend API server that bridges your React SaaS and the [Google Maps Extractor API](https://omkar.cloud) (Omkar Cloud Pro). Handles parallel requests, deduplicates results by Place ID in Supabase, and uses Node.js cluster to saturate all 8 VPS CPUs.

## Architecture

```
React SaaS
   │  POST /api/scrape   (returns jobId instantly)
   │  GET  /api/results/:jobId  (poll for status + data)
   ▼
Express API (8 workers via cluster)
   │
   ├── p-queue (3 concurrent scrapes/worker = 24 parallel max)
   │
   ▼
Google Maps Extractor API  ←  runs locally on VPS (port 3000)
   │
   ▼
Supabase  (places table, deduplicated on place_id)
```

## Quick Start

### 1. Install dependencies

```bash
cd maps-scraper-api
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Supabase credentials, API key, etc.
```

### 3. Run Supabase migration

Copy the contents of `supabase/migrations/001_create_tables.sql` into your Supabase SQL Editor and run it.

### 4. Start Google Maps Extractor on your VPS

Run the Omkar desktop app on the VPS. It will expose a local HTTP server (default port 3000). Set `MAPS_API_BASE_URL=http://localhost:3000` in your `.env`.

### 5. Start the API server

```bash
# Production (8 workers)
npm start

# Development (single process, auto-reload)
npm run dev
```

## API Reference

### `POST /api/scrape`

Enqueue a scrape job. Returns immediately with a `jobId`.

**Request:**
```json
{
  "queries": ["coffee shops in NYC", "coffee shops in LA"],
  "strategy": "Fast"
}
```
- `strategy`: `"Fast"` | `"Fastest"` | `"Detailed"` (default: `"Fast"`)
- Max 50 queries per request

**Response `202`:**
```json
{
  "jobId": "uuid",
  "status": "pending",
  "pollUrl": "/api/results/uuid"
}
```

---

### `GET /api/results/:jobId`

Poll for job status. Returns results when `status === "completed"`.

**Response:**
```json
{
  "jobId": "uuid",
  "status": "completed",
  "results_count": 120,
  "results": [ { "place_id": "...", "name": "...", ... } ],
  "pagination": { "page": 1, "limit": 100, "total": 120, "pages": 2 }
}
```
- `status` values: `pending` → `running` → `completed` | `failed`
- Supports `?page=1&limit=100` query params

---

### `GET /api/results/:jobId/places`

Places only (for table/grid views), with pagination.

---

### `DELETE /api/results/:jobId`

Delete the job and its result links. Does **not** delete the place records themselves (they are shared/deduplicated).

---

### `GET /health`

```json
{ "status": "ok", "worker": 12345, "timestamp": "..." }
```

## Deduplication

Every place has a unique `place_id` from Google Maps. When the same place appears in multiple scrape jobs, Supabase upserts it (updating the record) rather than inserting a duplicate. The `job_places` junction table tracks which jobs found which places.

## Headers

| Header | Description |
|---|---|
| `x-api-key` | Required if `API_KEY` is set in `.env` |
| `Content-Type` | `application/json` |

## Environment Variables

See `.env.example` for all options with descriptions.

## Tuning for 8-CPU VPS

| Variable | Default | Notes |
|---|---|---|
| `NUM_WORKERS` | `8` | One Node.js process per CPU |
| `QUEUE_CONCURRENCY` | `3` | Parallel Chrome sessions per worker |
| `MAPS_API_POLL_INTERVAL_MS` | `3000` | Reduce if Maps API responds faster |
| `MAPS_API_POLL_TIMEOUT_MS` | `300000` | Increase for large/slow queries |

**Memory estimate:** 8 workers × 3 concurrent × ~250MB Chrome = ~6GB RAM. Adjust `QUEUE_CONCURRENCY` down if the VPS has less than 8GB RAM.
