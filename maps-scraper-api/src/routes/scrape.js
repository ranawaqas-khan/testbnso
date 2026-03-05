/**
 * POST /api/scrape
 *
 * Accepts a scrape request from the React SaaS, enqueues it, and immediately
 * returns a jobId that the SaaS can poll for results.
 *
 * Request body:
 * {
 *   "queries":     ["coffee shops in NYC", "coffee shops in LA"],  // required
 *   "max_results": 120,   // optional, per query (max 120, Google Maps limit)
 *   "lang":        "en",  // optional, language code
 *   "zoom":        15     // optional, 15–18 (higher = more results, slower)
 * }
 *
 * Response 202:
 * {
 *   "jobId":   "uuid",
 *   "status":  "pending",
 *   "pollUrl": "/api/results/<jobId>"
 * }
 */

const { Router } = require('express');
const { enqueue } = require('../queue/scrapeQueue');
const logger = require('../logger');

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { queries, max_results = 120, lang, zoom } = req.body;

    // --- Validation ---
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({
        error: 'queries must be a non-empty array of strings',
        example: { queries: ['coffee shops in NYC'], max_results: 120 },
      });
    }

    const invalidQueries = queries.filter((q) => typeof q !== 'string' || !q.trim());
    if (invalidQueries.length) {
      return res.status(400).json({ error: 'All queries must be non-empty strings' });
    }

    if (queries.length > 50) {
      return res.status(400).json({ error: 'Max 50 queries per request' });
    }

    if (max_results < 1 || max_results > 120) {
      return res.status(400).json({ error: 'max_results must be between 1 and 120' });
    }

    if (zoom !== undefined && (zoom < 15 || zoom > 18)) {
      return res.status(400).json({ error: 'zoom must be between 15 and 18' });
    }

    // --- Build options ---
    const options = { max_results };
    if (lang) options.lang = lang;
    if (zoom) options.zoom = zoom;

    // --- Enqueue ---
    const cleanQueries = queries.map((q) => q.trim());
    const jobId = await enqueue({ queries: cleanQueries, options });

    logger.info('Scrape job accepted', { jobId, queryCount: cleanQueries.length, options });

    return res.status(202).json({
      jobId,
      status: 'pending',
      pollUrl: `/api/results/${jobId}`,
      message: 'Job enqueued. Poll pollUrl for status and results.',
    });
  } catch (err) {
    logger.error('Scrape route error', { error: err.message });
    return res.status(500).json({ error: 'Failed to enqueue scrape job' });
  }
});

module.exports = router;
