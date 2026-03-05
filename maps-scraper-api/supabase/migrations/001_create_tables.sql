-- ============================================================
--  Google Maps Scraper — Supabase Schema
--  Run this in the Supabase SQL Editor (or via CLI)
--
--  Unique identifier: kgmid (Google Knowledge Graph ID)
--  place_id is stored for reference but is NOT guaranteed to
--  be present in every record — never use it as a unique key.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  places
-- ============================================================
CREATE TABLE IF NOT EXISTS places (
  -- Identifiers
  kgmid                 TEXT PRIMARY KEY,          -- unique Google KG ID, always present
  place_id              TEXT,                       -- may be NULL — stored for reference only
  cid                   TEXT,
  data_id               TEXT,

  -- Core info
  name                  TEXT,
  description           TEXT,
  link                  TEXT,
  main_category         TEXT,
  categories            TEXT[],
  address               TEXT,
  detailed_address      JSONB,
  phone                 TEXT,
  website               TEXT,

  -- Ratings
  rating                NUMERIC(3, 1),
  reviews_count         INTEGER DEFAULT 0,
  reviews_link          TEXT,

  -- Location
  latitude              NUMERIC(10, 7),
  longitude             NUMERIC(10, 7),
  plus_code             TEXT,
  time_zone             TEXT,

  -- Status
  status                TEXT,
  is_temporarily_closed BOOLEAN DEFAULT FALSE,
  is_permanently_closed BOOLEAN DEFAULT FALSE,
  is_spending_on_ads    BOOLEAN DEFAULT FALSE,
  can_claim             BOOLEAN DEFAULT FALSE,

  -- Hours
  workday_timing        TEXT,
  closed_on             TEXT,
  hours                 JSONB,

  -- Social media
  linkedin              TEXT,
  twitter               TEXT,
  facebook              TEXT,
  youtube               TEXT,
  instagram             TEXT,

  -- Media
  featured_image        TEXT,
  image_count           INTEGER,

  -- Owner / misc
  owner                 JSONB,
  price_range           TEXT,
  about                 JSONB,

  -- Full raw payload for future use
  raw_data              JSONB,

  -- Timestamps
  last_scraped_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common SaaS filter/sort operations
CREATE INDEX IF NOT EXISTS idx_places_rating          ON places (rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_places_reviews_count   ON places (reviews_count DESC);
CREATE INDEX IF NOT EXISTS idx_places_main_category   ON places (main_category);
CREATE INDEX IF NOT EXISTS idx_places_website         ON places ((website IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_places_ads             ON places (is_spending_on_ads);
CREATE INDEX IF NOT EXISTS idx_places_last_scraped    ON places (last_scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_places_place_id        ON places (place_id) WHERE place_id IS NOT NULL;

-- ============================================================
--  scrape_jobs
-- ============================================================
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  queries         TEXT[]       NOT NULL,
  options         JSONB        DEFAULT '{}',        -- max_results, lang, zoom, etc.
  status          TEXT         NOT NULL DEFAULT 'pending',
  -- status values: pending | running | completed | failed
  results_count   INTEGER      DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON scrape_jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON scrape_jobs (created_at DESC);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON scrape_jobs;
CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON scrape_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
--  job_places — many-to-many: job ↔ place
-- ============================================================
CREATE TABLE IF NOT EXISTS job_places (
  job_id   UUID  REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  kgmid    TEXT  REFERENCES places(kgmid)   ON DELETE CASCADE,
  PRIMARY KEY (job_id, kgmid)
);

CREATE INDEX IF NOT EXISTS idx_job_places_job   ON job_places (job_id);
CREATE INDEX IF NOT EXISTS idx_job_places_kgmid ON job_places (kgmid);

-- ============================================================
--  Row Level Security (optional)
--  The backend uses the service-role key and bypasses RLS.
--  Uncomment these if your React frontend also queries Supabase directly.
-- ============================================================

-- ALTER TABLE places      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE scrape_jobs ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE job_places  ENABLE ROW LEVEL SECURITY;

-- Example: authenticated users can read all places
-- CREATE POLICY "read places" ON places FOR SELECT TO authenticated USING (true);
