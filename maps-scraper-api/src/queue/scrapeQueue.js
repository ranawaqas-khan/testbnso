/**
 * Parallel scrape queue using p-queue.
 *
 * Why p-queue?
 *  - No Redis dependency — simpler VPS setup
 *  - Concurrency limit prevents hammering the local Maps Extractor API
 *  - Each worker process has its own queue (8 workers × N concurrent = full CPU use)
 *
 * CONCURRENCY tuning:
 *  - Maps Extractor runs Chrome under the hood, so don't go too high.
 *  - Default: 3 concurrent scrapes per worker (8 workers = 24 parallel Chrome sessions max).
 *  - Tune via QUEUE_CONCURRENCY env var.
 */

const { default: PQueue } = require('p-queue');
const { v4: uuidv4 } = require('uuid');

const { scrape } = require('../services/mapsExtractor');
const { createJob, updateJobStatus, upsertPlaces } = require('../services/supabase');
const logger = require('../logger');

const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY) || 3;

const queue = new PQueue({ concurrency: CONCURRENCY });

// Emit queue size metrics every 30s
setInterval(() => {
  logger.info('Queue stats', {
    size: queue.size,
    pending: queue.pending,
    concurrency: CONCURRENCY,
    worker: process.pid,
  });
}, 30_000);

/**
 * Add a scrape job to the queue and persist it to Supabase.
 *
 * @param {Object} params
 * @param {string[]} params.queries
 * @param {string}   params.strategy   "Fast" | "Fastest" | "Detailed"
 * @returns {Promise<string>} jobId — return immediately to the SaaS caller
 */
async function enqueue({ queries, strategy = 'Fast' }) {
  const jobId = uuidv4();

  // Persist job record first so SaaS can poll immediately
  await createJob(jobId, queries, strategy);

  // Add work to the queue (non-blocking — resolves in background)
  queue.add(() => runScrapeJob(jobId, queries, strategy)).catch((err) => {
    logger.error('Queue task threw unhandled error', { jobId, error: err.message });
  });

  logger.info('Job enqueued', { jobId, queries, strategy, queueSize: queue.size });
  return jobId;
}

/**
 * The actual scrape work run inside the queue.
 */
async function runScrapeJob(jobId, queries, strategy) {
  logger.info('Job started', { jobId, queries });

  try {
    await updateJobStatus(jobId, 'running');

    const places = await scrape(queries, strategy);

    await upsertPlaces(places, jobId);
    await updateJobStatus(jobId, 'completed', places.length);

    logger.info('Job completed', { jobId, placesFound: places.length });
  } catch (err) {
    logger.error('Job failed', { jobId, error: err.message });
    await updateJobStatus(jobId, 'failed', null, err.message);
  }
}

module.exports = { enqueue, queue };
