/**
 * Results routes
 *
 * GET  /api/results/:jobId           — job status + paginated results
 * GET  /api/results/:jobId/places    — places only (for SaaS table view)
 * DELETE /api/results/:jobId         — delete job + its place links (not the places themselves)
 */

const { Router } = require('express');
const { getJob, getJobResults } = require('../services/supabase');
const logger = require('../logger');

const router = Router();

/* ------------------------------------------------------------------ */
/*  GET /api/results/:jobId                                            */
/* ------------------------------------------------------------------ */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500); // max 500 per page

    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const response = {
      jobId: job.id,
      status: job.status,
      queries: job.queries,
      strategy: job.strategy,
      results_count: job.results_count,
      created_at: job.created_at,
      completed_at: job.completed_at,
      error_message: job.error_message || null,
    };

    // Only include results when job is done
    if (job.status === 'completed') {
      const { results, total } = await getJobResults(jobId, { page, limit });
      response.results = results;
      response.pagination = {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      };
    }

    return res.json(response);
  } catch (err) {
    logger.error('Results route error', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/results/:jobId/places  (places only, all pages)           */
/* ------------------------------------------------------------------ */
router.get('/:jobId/places', async (req, res) => {
  try {
    const { jobId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status !== 'completed') {
      return res.status(202).json({ status: job.status, message: 'Job not yet completed' });
    }

    const data = await getJobResults(jobId, { page, limit });
    return res.json(data);
  } catch (err) {
    logger.error('Places route error', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch places' });
  }
});

/* ------------------------------------------------------------------ */
/*  DELETE /api/results/:jobId                                         */
/* ------------------------------------------------------------------ */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // Delete job_places links first (FK constraint)
    await supabase.from('job_places').delete().eq('job_id', jobId);
    const { error } = await supabase.from('scrape_jobs').delete().eq('id', jobId);

    if (error) throw new Error(error.message);

    return res.json({ message: 'Job deleted', jobId });
  } catch (err) {
    logger.error('Delete route error', { error: err.message });
    return res.status(500).json({ error: 'Failed to delete job' });
  }
});

module.exports = router;
