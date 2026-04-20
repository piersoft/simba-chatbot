#!/usr/bin/env node
/**
 * SIMBA — Load test
 * =================
 * Simula N utenti concorrenti che fanno query miste (intent/sparql/enrich)
 * per M secondi, misura latenze percentili e correlazione con risorse Docker.
 *
 * Uso:
 *   BASE_URL=http://localhost:3001 node tests/load-test.mjs
 *   BASE_URL=http://localhost:3001 CONCURRENCY=50 DURATION_SEC=300 node tests/load-test.mjs
 *
 * REQUISITI:
 *   - Backend raggiungibile su BASE_URL
 *   - Rate limiter disabilitati per l'IP del tester (settare nel .env:
 *     LOADTEST_BYPASS_IP=127.0.0.1 e ricreare backend)
 *   - Node.js 20+ (fetch nativo)
 *
 * OUTPUT:
 *   - Progress in tempo reale ogni 10s
 *   - Report finale con p50/p75/p95/p99 per endpoint
 *   - load-test-results.json — dump completo
 *
 * Zero dipendenze esterne.
 */

import fs from "node:fs";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────
const BASE_URL       = process.env.BASE_URL;
const CONCURRENCY    = Number(process.env.CONCURRENCY    ?? 50);
const DURATION_SEC   = Number(process.env.DURATION_SEC   ?? 300);
const THINK_MIN_MS   = Number(process.env.THINK_MIN_MS   ?? 200);
const THINK_MAX_MS   = Number(process.env.THINK_MAX_MS   ?? 800);
const TIMEOUT_MS     = Number(process.env.TIMEOUT_MS     ?? 30000);

if (!BASE_URL) {
  console.error("\nERRORE: BASE_URL non configurata. Esempio:\n  BASE_URL=http://localhost:3001 node tests/load-test.mjs\n");
  process.exit(2);
}

// ─── Mix di endpoint (pesi realistici di uso utente) ────────────────────────
// intent: chiamata di classificazione, fatta ad OGNI query dell'utente
// sparql: quando l'intent è SEARCH, segue una query SPARQL al backend
// enrich: raro, solo quando l'utente chiede conversione CSV → RDF
const ENDPOINTS = [
  { name: "intent", weight: 60, fn: callIntent },
  { name: "sparql", weight: 35, fn: callSparql },
  { name: "enrich", weight:  5, fn: callEnrich },
];
const TOTAL_WEIGHT = ENDPOINTS.reduce((a, e) => a + e.weight, 0);

// ─── Pool di query realistiche ──────────────────────────────────────────────
const INTENT_QUERIES = [
  "Cerco dati sugli incidenti stradali in Lombardia",
  "Dammi i dati sulla qualità dell'aria a Milano",
  "bilanci comunali 2023",
  "Quanti stranieri ci sono in Italia?",
  "Elenco delle scuole di Roma",
  "Dataset turismo Puglia in formato aperto",
  "dati popolazione comuni italiani",
  "Chi è il sindaco di Napoli?",
  "Come si fa il tiramisù?",
  "Puoi convertirmi un CSV in RDF?",
];

// Query SPARQL realistiche: cercano dataset per keyword con LIMIT basso
// (il frontend usa LIMIT 32 per deduplicare → simuliamo comportamento tipico)
const SPARQL_KEYWORDS = ["defibrillatori", "bilancio", "turismo", "rifiuti", "istruzione"];
const buildSparqlQuery = (kw) => `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?d ?t ?desc WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?t .
  OPTIONAL { ?d dct:description ?desc }
  FILTER(CONTAINS(LCASE(STR(?t)), "${kw}"))
} LIMIT 32`;

// CSV sintetico piccolo per enrich (pochi KB, no rete esterna)
const ENRICH_CSV = [
  "codice_ipa,denominazione,indirizzo,cap,comune,provincia,regione,email,telefono",
  "c_h501,Comune di Roma,Via del Campidoglio 1,00186,Roma,RM,Lazio,protocollo@pec.comune.roma.it,0667101",
  "c_f205,Comune di Milano,Piazza della Scala 2,20121,Milano,MI,Lombardia,protocollo@pec.comune.milano.it,0288450",
  "c_f839,Comune di Napoli,Piazza Municipio 1,80133,Napoli,NA,Campania,protocollo@pec.comune.napoli.it,0817950",
].join("\n");

// ─── Statistics tracker ─────────────────────────────────────────────────────
const stats = new Map(); // endpoint → { latencies[], successes, errors, statuses{} }
ENDPOINTS.forEach(e => stats.set(e.name, { latencies: [], successes: 0, errors: 0, statuses: {} }));

let totalRequests = 0;
let startTime = 0;
let running = true;

// ─── Helpers ────────────────────────────────────────────────────────────────
const rand = (min, max) => min + Math.random() * (max - min);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function pickEndpoint() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const e of ENDPOINTS) { r -= e.weight; if (r <= 0) return e; }
  return ENDPOINTS[0];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const latency = Date.now() - t0;
    // Drain body per non accumulare socket half-open
    await r.text();
    return { status: r.status, latency, ok: r.ok };
  } catch (e) {
    return { status: 0, latency: Date.now() - t0, ok: false, err: e.name };
  } finally { clearTimeout(to); }
}

// ─── Endpoint callers ───────────────────────────────────────────────────────
async function callIntent(sessionId) {
  return timedFetch(`${BASE_URL}/api/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ message: pick(INTENT_QUERIES) }),
  });
}

async function callSparql(sessionId) {
  const kw = pick(SPARQL_KEYWORDS);
  return timedFetch(`${BASE_URL}/api/sparql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ query: buildSparqlQuery(kw) }),
  });
}

async function callEnrich(sessionId) {
  return timedFetch(`${BASE_URL}/api/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({
      csv_text: ENRICH_CSV,
      ipa: "c_h501",
      pa: "Comune di Roma",
      fmt: "ttl",
      filename: "test.csv",
    }),
  });
}

// ─── Worker ─────────────────────────────────────────────────────────────────
async function worker(id) {
  const sessionId = `loadtest-${id}`;
  while (running) {
    const ep = pickEndpoint();
    const { status, latency, ok } = await ep.fn(sessionId);
    const s = stats.get(ep.name);
    s.latencies.push(latency);
    if (ok) s.successes++; else s.errors++;
    s.statuses[status] = (s.statuses[status] ?? 0) + 1;
    totalRequests++;
    if (!running) break;
    await sleep(rand(THINK_MIN_MS, THINK_MAX_MS));
  }
}

// ─── Progress reporter ──────────────────────────────────────────────────────
function printProgress() {
  const elapsed = (Date.now() - startTime) / 1000;
  const remain  = Math.max(0, DURATION_SEC - elapsed);
  const tput    = (totalRequests / elapsed).toFixed(1);
  const s       = [...stats.entries()].map(([n, s]) => {
    const total = s.successes + s.errors;
    const errPct = total > 0 ? ((s.errors / total) * 100).toFixed(1) : "0";
    const last50 = s.latencies.slice(-50).sort((a,b) => a-b);
    const p95    = percentile(last50, 95);
    return `${n}: ${total} req, ${errPct}% err, p95~${p95}ms`;
  }).join("  |  ");
  console.log(`[${elapsed.toFixed(0)}s/${DURATION_SEC}s rem=${remain.toFixed(0)}s] tput=${tput}r/s  ${s}`);
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n\n⏹  Ctrl+C ricevuto — chiudo ordinatamente...");
  running = false;
});

// ─── Report finale ──────────────────────────────────────────────────────────
function printReport() {
  const elapsed = (Date.now() - startTime) / 1000;
  console.log("\n" + "═".repeat(100));
  console.log(`  REPORT FINALE — durata ${elapsed.toFixed(1)}s, concurrency ${CONCURRENCY}`);
  console.log("═".repeat(100));

  const totalReqs = [...stats.values()].reduce((a, s) => a + s.successes + s.errors, 0);
  const totalErrs = [...stats.values()].reduce((a, s) => a + s.errors, 0);
  const throughput = (totalReqs / elapsed).toFixed(2);
  const errRate = totalReqs > 0 ? ((totalErrs / totalReqs) * 100).toFixed(2) : "0";

  console.log(`  Totale richieste:   ${totalReqs}`);
  console.log(`  Throughput:         ${throughput} req/s`);
  console.log(`  Error rate totale:  ${errRate}%`);

  console.log("\n  Dettaglio per endpoint:");
  console.log("  " + "-".repeat(98));
  console.log("  " + ["endpoint", "req", "ok", "err", "err%", "p50", "p75", "p95", "p99", "max"].map(s => s.padEnd(9)).join(""));
  console.log("  " + "-".repeat(98));
  const summary = {};
  for (const [name, s] of stats.entries()) {
    const total = s.successes + s.errors;
    if (total === 0) continue;
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p75 = percentile(sorted, 75);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1];
    const errPct = ((s.errors / total) * 100).toFixed(1);
    console.log("  " + [name, total, s.successes, s.errors, errPct + "%", p50 + "ms", p75 + "ms", p95 + "ms", p99 + "ms", max + "ms"].map(String).map(x => x.padEnd(9)).join(""));
    summary[name] = { total, ok: s.successes, err: s.errors, err_pct: Number(errPct), p50, p75, p95, p99, max, statuses: s.statuses };
  }

  console.log("\n  Status code distribution:");
  for (const [name, s] of stats.entries()) {
    if (Object.keys(s.statuses).length === 0) continue;
    const entries = Object.entries(s.statuses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    console.log(`    ${name.padEnd(10)} ${entries.join("  ")}`);
  }

  // Warning se ci sono segnali di sovraccarico
  const warnings = [];
  for (const [name, s] of stats.entries()) {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    if (p95 > 5000) warnings.push(`${name}: p95=${p95}ms > 5s (UX degradata)`);
    const errPct = s.successes + s.errors > 0 ? s.errors / (s.successes + s.errors) : 0;
    if (errPct > 0.05) warnings.push(`${name}: error rate ${(errPct * 100).toFixed(1)}% > 5%`);
  }
  if (warnings.length) {
    console.log("\n  ⚠ Warnings:");
    warnings.forEach(w => console.log(`    • ${w}`));
  } else {
    console.log("\n  ✓ Nessun warning — sistema regge bene il carico");
  }

  // Dump JSON
  const out = {
    base_url: BASE_URL, concurrency: CONCURRENCY, duration_sec: elapsed,
    total_requests: totalReqs, total_errors: totalErrs,
    throughput_rps: Number(throughput), error_rate_pct: Number(errRate),
    timestamp: new Date().toISOString(),
    per_endpoint: summary,
  };
  const jsonPath = path.join(process.cwd(), "load-test-results.json");
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`\n  📄 ${jsonPath}`);
  console.log();
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔥 SIMBA load test`);
  console.log(`   target:       ${BASE_URL}`);
  console.log(`   concurrency:  ${CONCURRENCY}`);
  console.log(`   duration:     ${DURATION_SEC}s (${(DURATION_SEC/60).toFixed(1)}min)`);
  console.log(`   think time:   ${THINK_MIN_MS}-${THINK_MAX_MS}ms tra richieste/worker`);
  console.log(`   mix:          ${ENDPOINTS.map(e => `${e.name}=${e.weight}%`).join("  ")}`);
  console.log();
  console.log(`⚠  Assicurati che LOADTEST_BYPASS_IP=127.0.0.1 sia nel .env del backend,`);
  console.log(`   altrimenti i rate limiter bloccheranno subito il test.\n`);

  startTime = Date.now();
  const endAt = startTime + DURATION_SEC * 1000;

  // Lancia workers
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker(i));

  // Progress timer
  const progressTimer = setInterval(printProgress, 10000);

  // Stop timer
  setTimeout(() => { running = false; }, DURATION_SEC * 1000);

  await Promise.all(workers);
  clearInterval(progressTimer);

  printReport();
  process.exit(0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
