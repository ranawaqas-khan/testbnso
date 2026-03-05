/**
 * Google Maps Extractor API client — Omkar Cloud (Botasaurus Desktop)
 *
 * Server runs at http://localhost:8000 by default (set MAPS_API_BASE_URL to override).
 *
 * Real endpoint reference (from botasaurus_server source):
 *
 *   POST /api/tasks/create-task-async   → { id, status, ... }
 *   GET  /api/tasks/:id                 → { id, status, result_count, ... }
 *   POST /api/tasks/:id/results         → { total_pages, results: [...] }
 *   GET  /api                           → health check
 *
 * Task status lifecycle: PENDING → IN_PROGRESS → COMPLETED | FAILED | ABORTED
 *
 * Unique place identifier: `kgmid`  (place_id may be absent — do NOT rely on it)
 */

const axios = require('axios');
const logger = require('../logger');

const BASE_URL         = process.env.MAPS_API_BASE_URL       || 'http://localhost:8000';
const POLL_INTERVAL_MS = parseInt(process.env.MAPS_API_POLL_INTERVAL_MS) || 3000;
const POLL_TIMEOUT_MS  = parseInt(process.env.MAPS_API_POLL_TIMEOUT_MS)  || 300_000; // 5 min
// Scraper name as registered in the Botasaurus app (check /api/ui/config on your instance)
const SCRAPER_NAME     = process.env.MAPS_SCRAPER_NAME || null; // null = use default scraper

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} ScrapeInput
 * @property {string[]} queries   - e.g. ["coffee shops in NYC"]
 * @property {number}   [max_results]  - max per query (default: 120)
 * @property {string}   [lang]         - language code, e.g. "en"
 * @property {number}   [zoom]         - map zoom 15–18 (higher = more results, slower)
 */

/* ------------------------------------------------------------------ */
/*  API calls                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create an async scrape task for a single query.
 * Returns the integer task ID immediately.
 *
 * @param {string} query
 * @param {Object} options  - max_results, lang, zoom, etc.
 * @returns {Promise<number>} taskId
 */
async function createTask(query, options = {}) {
  const payload = {
    data: {
      query,
      max_results: options.max_results ?? 120,
      ...(options.lang  && { lang: options.lang }),
      ...(options.zoom  && { zoom: options.zoom }),
    },
    ...(SCRAPER_NAME && { scraper_name: SCRAPER_NAME }),
  };

  logger.info('Creating task', { query, options });

  const { data } = await client.post('/api/tasks/create-task-async', payload);

  // Botasaurus returns either the task object directly or { id, ... }
  const taskId = data?.id;
  if (!taskId) {
    throw new Error(`Maps API did not return task id. Response: ${JSON.stringify(data)}`);
  }

  logger.info('Task created', { taskId, query });
  return taskId;
}

/**
 * Poll until the task reaches a terminal state, then return the task object.
 *
 * @param {number} taskId
 * @returns {Promise<Object>} completed task object
 */
async function waitForTask(taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data: task } = await client.get(`/api/tasks/${taskId}`);
    const status = task?.status;

    logger.debug('Polling task', { taskId, status, result_count: task?.result_count });

    if (status === 'COMPLETED') return task;

    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Maps API task ${taskId} ended with status: ${status}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Maps API task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

/**
 * Fetch all result pages for a completed task.
 *
 * @param {number} taskId
 * @returns {Promise<Object[]>} raw place objects
 */
async function fetchAllResults(taskId) {
  const places = [];
  let page = 1;
  const PER_PAGE = 50; // keep requests small and fast

  while (true) {
    const { data } = await client.post(`/api/tasks/${taskId}/results`, {
      page,
      per_page: PER_PAGE,
    });

    const items = data?.results ?? [];
    places.push(...items);

    const totalPages = data?.total_pages ?? 1;
    logger.debug('Fetched results page', { taskId, page, totalPages, count: items.length });

    if (page >= totalPages || items.length === 0) break;
    page++;
  }

  logger.info('All results fetched', { taskId, total: places.length });
  return places;
}

/* ------------------------------------------------------------------ */
/*  High-level helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Run multiple queries in parallel (each becomes its own task).
 * Returns a flat array of normalised places from all queries.
 *
 * @param {string[]} queries
 * @param {Object}   options  - max_results, lang, zoom
 * @returns {Promise<NormalisedPlace[]>}
 */
async function scrape(queries, options = {}) {
  // Create all tasks in parallel
  const taskIds = await Promise.all(queries.map((q) => createTask(q, options)));

  // Wait for all tasks in parallel
  const tasks = await Promise.all(taskIds.map((id) => waitForTask(id)));

  // Fetch all results in parallel
  const resultArrays = await Promise.all(tasks.map((t) => fetchAllResults(t.id)));

  // Flatten and normalise
  const allPlaces = resultArrays.flat().map(normalisePlaceData);

  // Deduplicate by kgmid within this batch (before DB upsert)
  const seen = new Set();
  return allPlaces.filter((p) => {
    if (!p.kgmid || seen.has(p.kgmid)) return false;
    seen.add(p.kgmid);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/*  Normalise raw place → consistent shape                             */
/* ------------------------------------------------------------------ */

/**
 * Map the Omkar/Botasaurus raw place object to our DB schema.
 *
 * Field reference: https://github.com/omkarcloud/google-maps-scraper/blob/master/fields.md
 *
 * @param {Object} raw
 * @returns {NormalisedPlace}
 */
function normalisePlaceData(raw) {
  return {
    // --- Identifiers ---
    kgmid:    raw.kgmid    ?? null,   // PRIMARY unique identifier (always present)
    place_id: raw.place_id ?? null,   // may be absent — stored for reference only
    cid:      raw.cid      ?? null,
    data_id:  raw.data_id  ?? null,

    // --- Core info ---
    name:          raw.name          ?? null,
    description:   raw.description   ?? null,
    link:          raw.link          ?? null,
    main_category: raw.main_category ?? null,
    categories:    raw.categories    ?? null,
    address:       raw.address       ?? null,
    detailed_address: raw.detailed_address ?? null,
    phone:         raw.phone         ?? raw.phone_international ?? null,
    website:       raw.website       ?? null,

    // --- Ratings ---
    rating:        raw.rating  != null ? parseFloat(raw.rating) : null,
    reviews_count: raw.reviews ?? 0,
    reviews_link:  raw.reviews_link ?? null,

    // --- Location ---
    latitude:   raw.coordinates?.latitude  ?? null,
    longitude:  raw.coordinates?.longitude ?? null,
    plus_code:  raw.plus_code  ?? null,
    time_zone:  raw.time_zone  ?? null,

    // --- Status ---
    status:                  raw.status                  ?? null,
    is_temporarily_closed:   raw.is_temporarily_closed   ?? false,
    is_permanently_closed:   raw.is_permanently_closed   ?? false,
    is_spending_on_ads:      raw.is_spending_on_ads      ?? false,
    can_claim:               raw.can_claim               ?? false,

    // --- Hours ---
    workday_timing: raw.workday_timing ?? null,
    closed_on:      raw.closed_on      ?? null,
    hours:          raw.hours          ?? null,

    // --- Social media ---
    linkedin:    raw.linkedin    ?? null,
    twitter:     raw.twitter     ?? null,
    facebook:    raw.facebook    ?? null,
    youtube:     raw.youtube     ?? null,
    instagram:   raw.instagram   ?? null,

    // --- Media ---
    featured_image: raw.featured_image ?? null,
    image_count:    raw.image_count    ?? null,

    // --- Owner / info ---
    owner:         raw.owner         ?? null,
    price_range:   raw.price_range   ?? null,
    about:         raw.about         ?? null,

    // --- Full raw payload (JSONB) for future use ---
    raw_data: raw,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scrape, createTask, waitForTask, fetchAllResults };
