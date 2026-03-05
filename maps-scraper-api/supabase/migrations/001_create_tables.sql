-- ============================================================
--  Google Maps Scraper — Supabase Schema
--  Run this in the Supabase SQL Editor (or via CLI)
-- ============================================================

-- Enable UUID extension (already on in Supabase, but just in case)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  places
--  place_id is the unique Google Maps identifier.
--  Upserting on place_id prevents duplicates across all jobs.
-- ============================================================
CREATE TABLE IF NOT EXISTS places (
  place_id          TEXT PRIMARY KEY,
  name              TEXT,
  address           TEXT,
  phone             TEXT,
  website           TEXT,
  rating            NUMERIC(3, 1),
  reviews_count     INTEGER DEFAULT 0,
  category          TEXT,
  latitude          NUMERIC(10, 7),
  longitude         NUMERIC(10, 7),
  is_spending_on_ads BOOLEAN DEFAULT FALSE,
  status            TEXT,                  -- e.g. OPERATIONAL, CLOSED_TEMPORARILY
  opening_hours     JSONB,
  photos_count      INTEGER,
  raw_data          JSONB,                 -- full API payload for future use
  last_scraped_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Useful indexes for the SaaS result/filter views
CREATE INDEX IF NOT EXISTS idx_places_rating          ON places (rating DESC);
CREATE INDEX IF NOT EXISTS idx_places_reviews_count   ON places (reviews_count DESC);
CREATE INDEX IF NOT EXISTS idx_places_category        ON places (category);
CREATE INDEX IF NOT EXISTS idx_places_website         ON places ((website IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_places_ads             ON places (is_spending_on_ads);
CREATE INDEX IF NOT EXISTS idx_places_last_scraped    ON places (last_scraped_at DESC);

-- ============================================================
--  scrape_jobs
--  One row per request from the SaaS.
-- ============================================================
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queries         TEXT[]       NOT NULL,
  strategy        TEXT         NOT NULL DEFAULT 'Fast',
  status          TEXT         NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  results_count   INTEGER      DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status      ON scrape_jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at  ON scrape_jobs (created_at DESC);

-- Auto-update updated_at
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
--  Lets you retrieve all places found by a specific job,
--  and see which jobs found a given place.
-- ============================================================
CREATE TABLE IF NOT EXISTS job_places (
  job_id    UUID  REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  place_id  TEXT  REFERENCES places(place_id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_job_places_job   ON job_places (job_id);
CREATE INDEX IF NOT EXISTS idx_job_places_place ON job_places (place_id);

-- ============================================================
--  Row Level Security (RLS)
--  Enable if you expose Supabase to the React frontend directly.
--  The backend uses the service-role key and bypasses RLS.
-- ============================================================

-- ALTER TABLE places       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE scrape_jobs  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE job_places   ENABLE ROW LEVEL SECURITY;

-- Example policy: authenticated users can read places
-- CREATE POLICY "read places" ON places FOR SELECT TO authenticated USING (true);
