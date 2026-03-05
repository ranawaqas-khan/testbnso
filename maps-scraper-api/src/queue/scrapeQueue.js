/**
 * Parallel scrape queue using p-queue.
 *
 * Each worker process manages its own queue.
 * 8 workers × QUEUE_CONCURRENCY concurrent = total parallel Botasaurus tasks.
 *
 * Note: Botasaurus Desktop handles its own Chrome concurrency internally.
 * QUEUE_CONCURRENCY here controls how many simultaneous /create-task-async
 * calls we make to it. Keep this at 1–3 unless your VPS has abundant RAM.
 */

const { default: PQueue } = require('p-queue');
const { v4: uuidv4 } = require('uuid');

const { scrape }                             = require('../services/mapsExtractor');
const { createJob, updateJobStatus, upsertPlaces } = require('../services/supabase');
const logger = require('../logger');

const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY) || 2;

const queue = new PQueue({ concurrency: CONCURRENCY });

// Log queue health every 30s
setInterval(() => {
  logger.info('Queue stats', {
    size: queue.size,
    pending: queue.pending,
    concurrency: CONCURRENCY,
    worker: process.pid,
  });
}, 30_000);

/**
 * Enqueue a scrape job.
 * Persists the job to Supabase immediately so the SaaS can poll right away.
 *
 * @param {Object}   params
 * @param {string[]} params.queries
 * @param {Object}   params.options   - max_results, lang, zoom
 * @returns {Promise<string>} jobId
 */
async function enqueue({ queries, options = {} }) {
  const jobId = uuidv4();

  await createJob(jobId, queries, options);

  // Non-blocking — work runs in background
  queue.add(() => runScrapeJob(jobId, queries, options)).catch((err) => {
    logger.error('Queue task threw unhandled error', { jobId, error: err.message });
  });

  logger.info('Job enqueued', { jobId, queries, options, queueSize: queue.size });
  return jobId;
}

async function runScrapeJob(jobId, queries, options) {
  logger.info('Job started', { jobId, queries });

  try {
    await updateJobStatus(jobId, 'running');

    const places = await scrape(queries, options);

    await upsertPlaces(places, jobId);
    await updateJobStatus(jobId, 'completed', places.length);

    logger.info('Job completed', { jobId, placesFound: places.length });
  } catch (err) {
    logger.error('Job failed', { jobId, error: err.message });
    await updateJobStatus(jobId, 'failed', null, err.message);
  }
}

module.exports = { enqueue, queue };
