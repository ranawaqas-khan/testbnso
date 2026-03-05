/**
 * POST /api/scrape
 *
 * Accepts a scrape request from the React SaaS, enqueues it, and immediately
 * returns a jobId that the SaaS can use to poll for results.
 *
 * Request body:
 * {
 *   "queries": ["coffee shops in NYC", "coffee shops in LA"],   // required
 *   "strategy": "Fast"                                           // optional: Fast | Fastest | Detailed
 * }
 *
 * Response:
 * {
 *   "jobId": "uuid",
 *   "status": "pending",
 *   "pollUrl": "/api/results/<jobId>"
 * }
 */

const { Router } = require('express');
const { enqueue } = require('../queue/scrapeQueue');
const logger = require('../logger');

const router = Router();

// Allowed strategies from Google Maps Extractor API
const VALID_STRATEGIES = ['Fast', 'Fastest', 'Detailed'];

router.post('/', async (req, res) => {
  try {
    const { queries, strategy = 'Fast' } = req.body;

    // --- Validation ---
    if (!queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({
        error: 'queries must be a non-empty array of strings',
        example: { queries: ['coffee shops in NYC'], strategy: 'Fast' },
      });
    }

    const invalidQueries = queries.filter((q) => typeof q !== 'string' || !q.trim());
    if (invalidQueries.length) {
      return res.status(400).json({ error: 'All queries must be non-empty strings' });
    }

    if (!VALID_STRATEGIES.includes(strategy)) {
      return res.status(400).json({
        error: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}`,
      });
    }

    if (queries.length > 50) {
      return res.status(400).json({ error: 'Max 50 queries per request' });
    }

    // --- Enqueue ---
    const cleanQueries = queries.map((q) => q.trim());
    const jobId = await enqueue({ queries: cleanQueries, strategy });

    logger.info('Scrape job accepted', { jobId, queryCount: cleanQueries.length });

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
