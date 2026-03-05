require('dotenv').config();

const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./logger');
const scrapeRoutes = require('./routes/scrape');
const resultsRoutes = require('./routes/results');

const NUM_WORKERS = parseInt(process.env.NUM_WORKERS) || os.cpus().length; // defaults to 8 on VPS

// --- Cluster: primary forks workers, workers run Express ---
if (cluster.isPrimary) {
  logger.info(`Primary process ${process.pid} starting ${NUM_WORKERS} workers`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  return;
}

// --- Worker: Express app ---
const app = express();
const PORT = process.env.PORT || 3001;

// Security
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute
  max: parseInt(process.env.RATE_LIMIT_RPM) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', limiter);

// Parsing & logging
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// API key auth middleware (optional — set API_KEY in .env to enable)
app.use('/api/', (req, res, next) => {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next();                          // auth disabled

  const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (provided !== requiredKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }
  next();
});

// Routes
app.use('/api/scrape', scrapeRoutes);
app.use('/api/results', resultsRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', worker: process.pid, timestamp: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Worker ${process.pid} listening on port ${PORT}`);
});
