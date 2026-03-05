/**
 * Supabase service
 *
 * All DB operations. `kgmid` is the unique place identifier from Google Maps
 * (place_id can be absent — never use it as a unique key).
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service-role key bypasses RLS
  { auth: { persistSession: false } }
);

/* ------------------------------------------------------------------ */
/*  Jobs                                                                */
/* ------------------------------------------------------------------ */

async function createJob(jobId, queries, options) {
  const { error } = await supabase.from('scrape_jobs').insert({
    id: jobId,
    queries,
    options,
    status: 'pending',
    results_count: 0,
  });
  if (error) throw new Error(`Failed to create job: ${error.message}`);
  return jobId;
}

async function updateJobStatus(jobId, status, resultsCount = null, errorMessage = null) {
  const update = { status, updated_at: new Date().toISOString() };
  if (resultsCount !== null) update.results_count = resultsCount;
  if (errorMessage)          update.error_message = errorMessage;
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
/*  Places — upsert deduplicated on kgmid                             */
/* ------------------------------------------------------------------ */

/**
 * Upsert an array of normalised places.
 * kgmid is the unique key — existing rows are updated, new ones inserted.
 *
 * @param {Object[]} places  - normalised place objects from mapsExtractor
 * @param {string}   jobId
 */
async function upsertPlaces(places, jobId) {
  if (!places.length) return;

  // Must have kgmid to be deduplicated
  const valid = places.filter((p) => p.kgmid);
  if (valid.length !== places.length) {
    logger.warn('Some places missing kgmid — skipped', {
      skipped: places.length - valid.length,
    });
  }
  if (!valid.length) return;

  const rows = valid.map((p) => ({
    kgmid:                 p.kgmid,
    place_id:              p.place_id,
    cid:                   p.cid,
    data_id:               p.data_id,
    name:                  p.name,
    description:           p.description,
    link:                  p.link,
    main_category:         p.main_category,
    categories:            p.categories,
    address:               p.address,
    detailed_address:      p.detailed_address,
    phone:                 p.phone,
    website:               p.website,
    rating:                p.rating,
    reviews_count:         p.reviews_count,
    reviews_link:          p.reviews_link,
    latitude:              p.latitude,
    longitude:             p.longitude,
    plus_code:             p.plus_code,
    time_zone:             p.time_zone,
    status:                p.status,
    is_temporarily_closed: p.is_temporarily_closed,
    is_permanently_closed: p.is_permanently_closed,
    is_spending_on_ads:    p.is_spending_on_ads,
    can_claim:             p.can_claim,
    workday_timing:        p.workday_timing,
    closed_on:             p.closed_on,
    hours:                 p.hours,
    linkedin:              p.linkedin,
    twitter:               p.twitter,
    facebook:              p.facebook,
    youtube:               p.youtube,
    instagram:             p.instagram,
    featured_image:        p.featured_image,
    image_count:           p.image_count,
    owner:                 p.owner,
    price_range:           p.price_range,
    about:                 p.about,
    raw_data:              p.raw_data,
    last_scraped_at:       new Date().toISOString(),
  }));

  // Upsert in chunks of 500 to stay within Supabase payload limits
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('places')
      .upsert(chunk, { onConflict: 'kgmid', ignoreDuplicates: false });

    if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  // Link job ↔ places
  await linkJobToPlaces(jobId, valid.map((p) => p.kgmid));

  logger.info('Upserted places', { jobId, count: valid.length });
}

async function linkJobToPlaces(jobId, kgmids) {
  const rows = kgmids.map((k) => ({ job_id: jobId, kgmid: k }));
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('job_places')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'job_id,kgmid', ignoreDuplicates: true });
    if (error) logger.warn('job_places link error', { error: error.message });
  }
}

/**
 * Get paginated results for a job.
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
    results: data?.map((r) => r.places) ?? [],
    total:   count ?? 0,
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
