/**
 * Supabase service
 *
 * Handles all DB operations.
 * Place ID is the unique identifier — we upsert to avoid duplicates.
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service-role key for server-side ops
  { auth: { persistSession: false } }
);

/* ------------------------------------------------------------------ */
/*  Jobs (in-memory tracking per worker — Supabase table for shared)   */
/* ------------------------------------------------------------------ */

/**
 * Create a job record in Supabase.
 * @param {string} jobId  uuid
 * @param {string[]} queries
 * @param {string} strategy
 */
async function createJob(jobId, queries, strategy) {
  const { error } = await supabase.from('scrape_jobs').insert({
    id: jobId,
    queries,
    strategy,
    status: 'pending',
    results_count: 0,
  });
  if (error) throw new Error(`Failed to create job: ${error.message}`);
  return jobId;
}

async function updateJobStatus(jobId, status, resultsCount = null, errorMessage = null) {
  const update = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (resultsCount !== null) update.results_count = resultsCount;
  if (errorMessage) update.error_message = errorMessage;
  if (status === 'completed' || status === 'failed') {
    update.completed_at = new Date().toISOString();
  }

  const { error } = await supabase.from('scrape_jobs').update(update).eq('id', jobId);
  if (error) logger.error('Failed to update job status', { jobId, error: error.message });
}

async function getJob(jobId) {
  const { data, error } = await supabase
    .from('scrape_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) return null;
  return data;
}

/* ------------------------------------------------------------------ */
/*  Places — upsert with Place ID deduplication                        */
/* ------------------------------------------------------------------ */

/**
 * Upsert an array of normalised places.
 * place_id is the unique key — existing rows are updated, new ones inserted.
 *
 * @param {Object[]} places  - normalised place objects from mapsExtractor
 * @param {string}   jobId
 * @returns {Promise<{ inserted: number, updated: number }>}
 */
async function upsertPlaces(places, jobId) {
  if (!places.length) return { inserted: 0, updated: 0 };

  // Filter out places without a place_id — they can't be deduplicated
  const valid = places.filter((p) => p.place_id);
  if (valid.length !== places.length) {
    logger.warn('Some places missing place_id — skipped', {
      skipped: places.length - valid.length,
    });
  }

  const rows = valid.map((p) => ({
    place_id: p.place_id,
    name: p.name,
    address: p.address,
    phone: p.phone,
    website: p.website,
    rating: p.rating,
    reviews_count: p.reviews_count,
    category: p.category,
    latitude: p.latitude,
    longitude: p.longitude,
    is_spending_on_ads: p.is_spending_on_ads,
    status: p.status,
    opening_hours: p.opening_hours,
    photos_count: p.photos_count,
    raw_data: p.raw_data,
    last_scraped_at: new Date().toISOString(),
  }));

  // Upsert in chunks of 500 to stay within Supabase limits
  const CHUNK = 500;
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const { data, error } = await supabase
      .from('places')
      .upsert(chunk, {
        onConflict: 'place_id',
        ignoreDuplicates: false, // update existing rows
      })
      .select('place_id');

    if (error) {
      logger.error('Upsert error', { error: error.message });
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    inserted += data?.length || chunk.length;
  }

  // Link job → places in junction table
  await linkJobToPlaces(jobId, valid.map((p) => p.place_id));

  logger.info('Upserted places', { jobId, count: valid.length });
  return { inserted, updated };
}

async function linkJobToPlaces(jobId, placeIds) {
  const rows = placeIds.map((pid) => ({ job_id: jobId, place_id: pid }));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('job_places')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'job_id,place_id', ignoreDuplicates: true });
    if (error) logger.warn('job_places link error', { error: error.message });
  }
}

/**
 * Get results for a job with optional pagination.
 */
async function getJobResults(jobId, { page = 1, limit = 100 } = {}) {
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from('job_places')
    .select('places(*)', { count: 'exact' })
    .eq('job_id', jobId)
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Failed to fetch results: ${error.message}`);

  return {
    results: data?.map((r) => r.places) || [],
    total: count || 0,
    page,
    limit,
  };
}

module.exports = {
  createJob,
  updateJobStatus,
  getJob,
  upsertPlaces,
  getJobResults,
};
