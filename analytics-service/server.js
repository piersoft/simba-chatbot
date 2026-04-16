'use strict';

const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const db          = require('./db/sqlite');

const app  = express();
const PORT = process.env.PORT || 3004;
const ORIGIN         = process.env.CHATBOT_ORIGIN  || 'https://chatbot.piersoftckan.biz';
const ANALYTICS_TOKEN = process.env.ANALYTICS_TOKEN || 'changeme';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin: [ORIGIN, 'http://localhost:8080', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
}));

const eventLimiter = rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false });
const statsLimiter = rateLimit({ windowMs: 60000, max: 60,  standardHeaders: true, legacyHeaders: false });

function authStats(req, res, next) {
  // In dev (token = 'changeme') non blocca; in prod richiede Bearer
  if (ANALYTICS_TOKEN === 'changeme') return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${ANALYTICS_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Validazione eventi ────────────────────────────────────────────────────────
const VALID_TYPES = new Set(['search','validate','ttl_create','off_topic','session_start','error','latency']);

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Payload non valido';
  if (!VALID_TYPES.has(body.type)) return `Tipo non valido: ${body.type}`;
  if (body.ts && isNaN(Date.parse(body.ts))) return 'ts non è un ISO date valido';
  if (body.type === 'search'     && typeof body.query !== 'string') return 'search: query mancante';
  if (body.type === 'validate'   && !body.dataset_id) return 'validate: dataset_id mancante';
  if (body.type === 'ttl_create' && !body.dataset_id) return 'ttl_create: dataset_id mancante';
  if (body.type === 'error'      && !body.error_type) return 'error: error_type mancante';
  return null;
}

// ── Helper range date ─────────────────────────────────────────────────────────
function parseDateRange(query) {
  const now = new Date();
  const to   = query.to   ? new Date(query.to).toISOString()   : now.toISOString();
  const from = query.from ? new Date(query.from).toISOString() :
    new Date(now.getTime() - 7 * 86400000).toISOString();
  return { from, to };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// POST /event
app.post('/event', eventLimiter, (req, res) => {
  const err = validateEvent(req.body);
  if (err) return res.status(400).json({ error: err });
  const { type, session_id, ip, user_agent, ts, ...payload } = req.body;
  try {
    db.insertEvent({ type, session_id: session_id || null, ip: ip || null,
      user_agent: user_agent || null, ts: ts || new Date().toISOString(),
      payload: JSON.stringify(payload) });
    res.status(202).json({ ok: true });
  } catch (e) {
    console.error('DB insert error:', e.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /stats/overview
app.get('/stats/overview', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      sessions:      db.countDistinct('session_id', from, to),
      unique_ips:    db.countDistinct('ip', from, to),
      total_events:  db.countEvents(null, from, to),
      searches:      db.countEvents('search', from, to),
      validations:   db.countEvents('validate', from, to),
      ttl_created:   db.countEvents('ttl_create', from, to),
      off_topic:     db.countEvents('off_topic', from, to),
      errors:        db.countEvents('error', from, to),
      avg_latency_ms: db.avgLatency(from, to),
      top_queries:   db.topQueries(10, from, to),
      hourly_traffic: db.hourlyTraffic(from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/search
app.get('/stats/search', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      top_queries:        db.topQueries(20, from, to),
      top_rightsholders:  db.topRightsHolders(20, from, to),
      searches_per_day:   db.eventsPerDay('search', from, to),
      avg_datasets_found: db.avgPayloadField('search', 'datasets_found', from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/validate
app.get('/stats/validate', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      top_datasets:       db.topValidatedDatasets(20, from, to),
      success_rate:       db.validationSuccessRate(from, to),
      validations_per_day: db.eventsPerDay('validate', from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/ttl
app.get('/stats/ttl', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      top_datasets: db.topTTLDatasets(20, from, to),
      ttl_per_day:  db.eventsPerDay('ttl_create', from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/errors
app.get('/stats/errors', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      by_type:        db.errorsByType(from, to),
      errors_per_hour: db.errorsPerHour(from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/performance
app.get('/stats/performance', statsLimiter, authStats, (req, res) => {
  const { from, to } = parseDateRange(req.query);
  try {
    res.json({
      avg_latency_ms:      db.avgLatency(from, to),
      p95_latency_ms:      db.percentileLatency(95, from, to),
      latency_per_hour:    db.latencyPerHour(from, to),
      requests_per_minute: db.requestsPerMinute(from, to),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`analytics-service listening on :${PORT}`);
  db.init();
});
