'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/analytics.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  return db;
}

function init() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL,
      session_id TEXT,
      ip         TEXT,
      user_agent TEXT,
      ts         TEXT    NOT NULL,
      payload    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_ts   ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_sess ON events(session_id);
  `);
  console.log('SQLite analytics DB pronto:', DB_PATH);
}

function insertEvent({ type, session_id, ip, user_agent, ts, payload }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO events (type, session_id, ip, user_agent, ts, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(type, session_id, ip, user_agent, ts, payload);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function countDistinct(field, from, to) {
  const d = getDb();
  return d.prepare(
    `SELECT COUNT(DISTINCT ${field}) as n FROM events WHERE ts BETWEEN ? AND ?`
  ).get(from, to)?.n || 0;
}

function countOffTopicClassifier(from, to) {
  // Solo off_topic dal classificatore LLM (domande fuori tema vere)
  const d = getDb();
  const rows = d.prepare(
    `SELECT payload FROM events WHERE type='off_topic' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  return rows.filter(r => {
    try { return JSON.parse(r.payload).guardrail_layer === 'classifier'; } catch { return false; }
  }).length;
}

function countBlockedByBlocklist(from, to) {
  // Solo richieste bloccate dalla blocklist
  const d = getDb();
  const rows = d.prepare(
    `SELECT payload FROM events WHERE (type='off_topic' OR type='blocked') AND ts BETWEEN ? AND ?`
  ).all(from, to);
  return rows.filter(r => {
    try {
      const p = JSON.parse(r.payload);
      return p.guardrail_layer === 'blocklist' || r.type === 'blocked';
    } catch { return false; }
  }).length;
}

function countEvents(type, from, to) {
  const d = getDb();
  if (type) {
    return d.prepare(
      `SELECT COUNT(*) as n FROM events WHERE type=? AND ts BETWEEN ? AND ?`
    ).get(type, from, to)?.n || 0;
  }
  return d.prepare(
    `SELECT COUNT(*) as n FROM events WHERE ts BETWEEN ? AND ?`
  ).get(from, to)?.n || 0;
}

function avgLatency(from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type IN ('search','latency') AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const vals = rows
    .map(r => { try { return JSON.parse(r.payload).latency_ms; } catch { return null; } })
    .filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function percentileLatency(p, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type IN ('search','latency') AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const vals = rows
    .map(r => { try { return JSON.parse(r.payload).latency_ms; } catch { return null; } })
    .filter(v => typeof v === 'number')
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  return vals[Math.max(0, Math.ceil((p / 100) * vals.length) - 1)];
}

function topQueries(limit, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='search' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const q = (JSON.parse(r.payload).query || '').trim().toLowerCase().slice(0, 100);
      if (q) counts[q] = (counts[q] || 0) + 1;
    } catch {}
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([query, count]) => ({ query, count }));
}

function topBlockedQueries(limit, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE (type='blocked' OR type='off_topic') AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      // Includi solo eventi dalla blocklist, non dal classificatore LLM
      if (p.guardrail_layer && p.guardrail_layer !== 'blocklist') continue;
      const q = (p.query_preview || p.query || '').trim().toLowerCase().slice(0, 100);
      if (q) counts[q] = (counts[q] || 0) + 1;
    } catch {}
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([query, count]) => ({ query, count }));
}

function normalizeEnteName(name) {
  if (!name) return null;
  // Normalizza maiuscola iniziale per ogni parola, esclude preposizioni
  const skip = new Set(['di','del','della','delle','degli','dei','da','in','e','a','su','per']);
  return name.trim()
    .split(/\s+/)
    .map((w, i) => i === 0 || !skip.has(w.toLowerCase())
      ? w.charAt(0).toUpperCase() + w.slice(1)
      : w.toLowerCase())
    .join(' ');
}

function topRightsHolders(limit, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='search' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const w = JSON.parse(r.payload).where;
      if (!w) continue;
      const key = normalizeEnteName(w);
      if (key) counts[key] = (counts[key] || 0) + 1;
    } catch {}
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([rights_holder, count]) => ({ rights_holder, count }));
}

function topValidatedDatasets(limit, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='validate' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      // Solo dataset con titolo leggibile (no nomi file con estensione)
      const title = (p.dataset_title || '').trim().slice(0, 80);
      if (!title || FILE_EXT_RE.test(title)) continue; // salta file/distribuzioni dirette
      if (!counts[title]) counts[title] = { dataset_title: title, total: 0, ok: 0 };
      counts[title].total++;
      if (p.validation_ok) counts[title].ok++;
    } catch {}
  }
  return Object.values(counts).sort((a, b) => b.total - a.total).slice(0, limit);
}

const FILE_EXT_RE = /\.(csv|aspx|xlsx|xls|json|tsv|txt|xml|zip)/i;

function topTTLDatasets(limit, from, to) {
  // Solo record il cui dataset_title è un nome file (ha estensione)
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='ttl_create' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      const title = (p.dataset_title || '').trim();
      if (!FILE_EXT_RE.test(title)) continue; // salta i nomi ente
      if (!counts[title]) counts[title] = { dataset_title: title, count: 0 };
      counts[title].count++;
    } catch {}
  }
  return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, limit);
}

function topTTLAdmins(limit, from, to) {
  // Solo record con pa esplicito (nome ente inserito dall'utente)
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='ttl_create' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      // Usa pa se presente e non è un nome file
      const pa = (p.pa || '').trim();
      if (!pa || FILE_EXT_RE.test(pa)) continue;
      const key = pa.charAt(0).toUpperCase() + pa.slice(1);
      if (!counts[key]) counts[key] = { admin: key, count: 0 };
      counts[key].count++;
    } catch {}
  }
  return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, limit);
}

function validationSuccessRate(from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='validate' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  if (!rows.length) return null;
  let ok = 0;
  for (const r of rows) { try { if (JSON.parse(r.payload).validation_ok) ok++; } catch {} }
  return Math.round((ok / rows.length) * 100);
}

function errorsByType(from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type='error' AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const counts = {};
  for (const r of rows) {
    try {
      const t = JSON.parse(r.payload).error_type || 'unknown';
      counts[t] = (counts[t] || 0) + 1;
    } catch {}
  }
  return Object.entries(counts).map(([error_type, count]) => ({ error_type, count }));
}

function eventsPerDay(type, from, to) {
  return getDb().prepare(
    `SELECT substr(ts,1,10) as day, COUNT(*) as count
     FROM events WHERE type=? AND ts BETWEEN ? AND ?
     GROUP BY day ORDER BY day`
  ).all(type, from, to);
}

function hourlyTraffic(from, to) {
  return getDb().prepare(
    `SELECT substr(ts,1,13) as hour, COUNT(*) as count
     FROM events WHERE ts BETWEEN ? AND ?
     GROUP BY hour ORDER BY hour`
  ).all(from, to);
}

function errorsPerHour(from, to) {
  return getDb().prepare(
    `SELECT substr(ts,1,13) as hour, COUNT(*) as count
     FROM events WHERE type='error' AND ts BETWEEN ? AND ?
     GROUP BY hour ORDER BY hour`
  ).all(from, to);
}

function latencyPerHour(from, to) {
  const rows = getDb().prepare(
    `SELECT payload, substr(ts,1,13) as hour FROM events
     WHERE type IN ('search','latency') AND ts BETWEEN ? AND ?`
  ).all(from, to);
  const byHour = {};
  for (const r of rows) {
    try {
      const ms = JSON.parse(r.payload).latency_ms;
      if (typeof ms !== 'number') continue;
      if (!byHour[r.hour]) byHour[r.hour] = [];
      byHour[r.hour].push(ms);
    } catch {}
  }
  return Object.entries(byHour).sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, vals]) => ({ hour, avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) }));
}

function requestsPerMinute(from, to) {
  return getDb().prepare(
    `SELECT substr(ts,1,16) as minute, COUNT(*) as count
     FROM events WHERE type='search' AND ts BETWEEN ? AND ?
     GROUP BY minute ORDER BY minute DESC LIMIT 60`
  ).all(from, to).reverse();
}

function avgPayloadField(type, field, from, to) {
  const rows = getDb().prepare(
    `SELECT payload FROM events WHERE type=? AND ts BETWEEN ? AND ?`
  ).all(type, from, to);
  const vals = rows
    .map(r => { try { return JSON.parse(r.payload)[field]; } catch { return null; } })
    .filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function deleteOlderThan(cutoff) {
  const result = getDb().prepare(
    `DELETE FROM events WHERE ts < ?`
  ).run(cutoff);
  return result.changes;
}

module.exports = {
  init, insertEvent, deleteOlderThan,
  countDistinct, countEvents,
  avgLatency, percentileLatency,
  topQueries, topBlockedQueries, topRightsHolders,
  countOffTopicClassifier, countBlockedByBlocklist,
  topValidatedDatasets, topTTLDatasets, topTTLAdmins,
  validationSuccessRate, errorsByType,
  eventsPerDay, hourlyTraffic, errorsPerHour,
  latencyPerHour, requestsPerMinute, avgPayloadField,
};
