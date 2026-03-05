/**
 * Google Maps Extractor API client (Omkar Cloud)
 *
 * The desktop app exposes a local HTTP server (Botasaurus-based).
 * Typical base URL when running on VPS: http://localhost:3000
 *
 * Flow:
 *  1. POST /api/run     → starts a scraping task, returns { taskId }
 *  2. GET  /api/output/<taskId>  → poll until status === 'completed'
 *  3. GET  /api/output/<taskId>/results → fetch paginated results
 */

const axios = require('axios');
const logger = require('../logger');

const BASE_URL = process.env.MAPS_API_BASE_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = parseInt(process.env.MAPS_API_POLL_INTERVAL_MS) || 3000;
const POLL_TIMEOUT_MS = parseInt(process.env.MAPS_API_POLL_TIMEOUT_MS) || 300_000; // 5 min

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Start a scraping task.
 * @param {Object} params
 * @param {string[]} params.queries   - e.g. ["coffee shops in NYC"]
 * @param {string}   params.strategy  - "Fast" | "Fastest" | "Detailed" (default: "Fast")
 * @returns {Promise<string>} taskId
 */
async function startScrape({ queries, strategy = 'Fast' }) {
  logger.info('Starting scrape task', { queries, strategy });

  const response = await client.post('/api/run', {
    data: queries.map((q) => ({ query: q })),
    // Botasaurus Desktop run format; adjust key names if your version differs
    metadata: { strategy },
  });

  // Response shape: { taskId: "...", status: "pending" }
  const taskId = response.data?.taskId || response.data?.task_id;
  if (!taskId) {
    throw new Error(`Maps API did not return a taskId. Response: ${JSON.stringify(response.data)}`);
  }

  logger.info('Scrape task started', { taskId });
  return taskId;
}

/**
 * Poll until the task completes, then return raw place results.
 * @param {string} taskId
 * @returns {Promise<Object[]>} array of place objects from Maps API
 */
async function waitForResults(taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data } = await client.get(`/api/output/${taskId}`);
    const status = data?.status;

    logger.debug('Polling task', { taskId, status });

    if (status === 'completed' || status === 'Completed') {
      return fetchAllResults(taskId, data);
    }

    if (status === 'failed' || status === 'Failed') {
      throw new Error(`Maps API task ${taskId} failed`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Maps API task ${taskId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

/**
 * Fetch paginated results for a completed task.
 * Handles both "results inside output response" and "separate /results endpoint" patterns.
 */
async function fetchAllResults(taskId, outputData) {
  // If results are embedded in the output response
  if (Array.isArray(outputData?.results)) {
    return outputData.results;
  }
  if (Array.isArray(outputData?.data)) {
    return outputData.data;
  }

  // Otherwise fetch from dedicated results endpoint (paginated)
  const places = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await client.get(`/api/output/${taskId}/results`, {
      params: { page, per_page: perPage },
    });

    const items = data?.results || data?.data || [];
    places.push(...items);

    if (items.length < perPage) break; // last page
    page++;
  }

  logger.info('Fetched results', { taskId, count: places.length });
  return places;
}

/**
 * High-level helper: run a full scrape and return normalised place objects.
 * @param {string[]} queries
 * @param {string}   strategy
 * @returns {Promise<NormalisedPlace[]>}
 */
async function scrape(queries, strategy = 'Fast') {
  const taskId = await startScrape({ queries, strategy });
  const rawPlaces = await waitForResults(taskId);
  return rawPlaces.map(normalisePlaceData);
}

/**
 * Normalise the raw API response into a consistent shape.
 * Adjust field names here if the API version you have uses different keys.
 */
function normalisePlaceData(raw) {
  return {
    place_id: raw.place_id || raw.placeId || raw.google_id,
    name: raw.name || raw.business_name,
    address: raw.address || raw.full_address,
    phone: raw.phone || raw.phone_number,
    website: raw.website || raw.site,
    rating: raw.rating != null ? parseFloat(raw.rating) : null,
    reviews_count: raw.reviews || raw.reviews_count || raw.user_ratings_total || 0,
    category: raw.category || raw.type || raw.main_category,
    latitude: raw.latitude ?? raw.lat ?? null,
    longitude: raw.longitude ?? raw.lng ?? null,
    is_spending_on_ads: raw.is_spending_on_ads ?? false,
    status: raw.status || raw.business_status,
    opening_hours: raw.opening_hours || null,
    photos_count: raw.photos_count ?? null,
    // full raw payload stored in Supabase JSONB for future use
    raw_data: raw,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scrape, startScrape, waitForResults };
