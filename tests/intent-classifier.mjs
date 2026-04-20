#!/usr/bin/env node
/**
 * SIMBA — Intent classifier regression test
 * =========================================
 * Testa /api/intent del backend con 40 domande su 8 categorie
 * (base, fact-trap, meta-bot, llm-task, search-ambig, enrich-alt,
 * validate-alt, sigle-pa) per verificare la classificazione in
 * SEARCH / VALIDATE / ENRICH / OFF_TOPIC.
 *
 * Pipeline testata:
 *   1. Pre-filtro deterministico (validateKw, enrichKw, offTopicKw, searchPatterns)
 *   2. SPARQL ASK su lod.dati.gov.it
 *   3. LLM (qwen3:1.7b locale o Mistral)
 *
 * Uso:
 *   npm run test:intent
 *   node tests/intent-classifier.mjs
 *   BASE_URL=https://tuo-dominio.it DELAY_MS=3500 node tests/intent-classifier.mjs
 *
 * BASE_URL è OBBLIGATORIA: senza di essa il test fallisce con errore
 * esplicativo (niente default hardcoded a un dominio specifico).
 *
 * Requisiti: Node.js 18+, backend up su BASE_URL
 * Rate limit: /api/intent = 20 req/min → delay default 3500ms (totale ~2m20s)
 *
 * Output: tabella console colorata + simba-intent-results.{csv,json}
 * Exit code: 0 se pass totale, 1 se mismatch, 2 se errore fatale.
 *
 * Repo: https://github.com/piersoft/simba-chatbot
 * Licenza: AGPL-3.0
 */

import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("");
  console.error("┌─────────────────────────────────────────────────────────────┐");
  console.error("│ ERRORE: variabile BASE_URL non configurata                  │");
  console.error("├─────────────────────────────────────────────────────────────┤");
  console.error("│ Il test ha bisogno dell\'URL del backend da testare.        │");
  console.error("│ Esempio:                                                    │");
  console.error("│                                                             │");
  console.error("│   BASE_URL=https://tuo-dominio.it node tests/intent-...     │");
  console.error("│   BASE_URL=http://localhost:3001 npm run test:intent        │");
  console.error("│                                                             │");
  console.error("└─────────────────────────────────────────────────────────────┘");
  console.error("");
  process.exit(2);
}
const ENDPOINT = `${BASE_URL}/api/intent`;
const DELAY_MS = Number(process.env.DELAY_MS ?? 3500);
const TIMEOUT  = Number(process.env.TIMEOUT  ?? 45000);
const SESSION  = `regtest-${Date.now()}`;

// ─── Test set ────────────────────────────────────────────────────────────
// expected: stringa o array se più esiti sono accettabili (border case).
const TESTS = [
  // Base — dataset originale mix di categorie
  { id:  1, cat: "base",         q: "Ciao, ma tu che fai?",                                                      expected: "OFF_TOPIC", note: "meta: identità del bot" },
  { id:  2, cat: "base",         q: "Dammi i dati sulla qualità dell'aria a Milano",                             expected: ["SEARCH","VALIDATE"], note: "'qualità' può far scattare pre-filtro VALIDATE" },
  { id:  3, cat: "base",         q: "Quanti stranieri ci sono in Italia?",                                       expected: "SEARCH",    note: "demografia ISTAT colloquiale" },
  { id:  4, cat: "base",         q: "Mi arricchisci questo dataset? Ecco il link del CKAN",                      expected: "ENRICH",    note: "'arricch' matcha pre-filtro" },
  { id:  5, cat: "base",         q: "Che tempo fa domani a Roma?",                                               expected: "OFF_TOPIC", note: "meteo" },
  { id:  6, cat: "base",         q: "Cerco dati sugli incidenti stradali in Lombardia",                          expected: "SEARCH",    note: "search ben formata" },
  { id:  7, cat: "base",         q: "Sei meglio di ChatGPT?",                                                    expected: "OFF_TOPIC", note: "confronto con altri LLM" },
  { id:  8, cat: "base",         q: "dati popolazione comuni italiani 2023",                                     expected: "SEARCH",    note: "telegrafica" },
  { id:  9, cat: "base",         q: "Come si fa il tiramisù?",                                                   expected: "OFF_TOPIC", note: "ricetta di cucina" },
  { id: 10, cat: "base",         q: "Vorrei sapere quante scuole ci sono nella mia città",                       expected: "SEARCH",    note: "aggregato con ambito territoriale" },
  { id: 11, cat: "base",         q: "Puoi aiutarmi a migliorare i metadati del mio CSV?",                        expected: ["VALIDATE","ENRICH"], note: "'mio csv' attiva VALIDATE" },
  { id: 12, cat: "base",         q: "Chi ha vinto il campionato l'anno scorso?",                                 expected: "OFF_TOPIC", note: "sport" },
  { id: 13, cat: "base",         q: "bilanci comunali",                                                          expected: "SEARCH",    note: "query minimalista 2 parole" },
  { id: 14, cat: "base",         q: "Voglio i dati della spesa pubblica ma non so dove trovarli",                expected: "SEARCH",    note: "linguaggio non tecnico" },
  { id: 15, cat: "base",         q: "Mi racconti una barzelletta?",                                              expected: "OFF_TOPIC", note: "intrattenimento" },
  { id: 16, cat: "base",         q: "Dataset turismo Puglia in formato aperto",                                  expected: "SEARCH",    note: "ben formata" },
  { id: 17, cat: "base",         q: "arricchisci semanticamente questo catalogo CKAN",                           expected: "ENRICH",    note: "enrich lowercase telegrafico" },
  { id: 18, cat: "base",         q: "Quali sono i dati sui rifiuti urbani?",                                     expected: "SEARCH",    note: "tema ambientale" },
  { id: 19, cat: "base",         q: "Che significa DCAT-AP_IT?",                                                 expected: ["OFF_TOPIC","SEARCH"], note: "BORDER: educational/meta" },
  { id: 20, cat: "base",         q: "Puoi scrivermi un'email al mio capo?",                                      expected: "OFF_TOPIC", note: "task LLM" },

  // Fact-trap — fatti/eventi che SEMBRANO search ma non lo sono
  { id: 21, cat: "fact-trap",    q: "Chi è il sindaco di Napoli?",                                               expected: "OFF_TOPIC", note: "fatto puntuale, non dataset" },
  { id: 22, cat: "fact-trap",    q: "Quando è stata firmata la Costituzione italiana?",                          expected: "OFF_TOPIC", note: "fatto storico" },
  { id: 23, cat: "fact-trap",    q: "Quanto costa un biglietto del treno Milano-Roma?",                          expected: "OFF_TOPIC", note: "prezzo corrente, non open data" },
  { id: 24, cat: "fact-trap",    q: "A che ora apre l'ufficio anagrafe?",                                        expected: "OFF_TOPIC", note: "orario, non dataset" },

  // Meta-bot — confronti / domande sul bot
  { id: 25, cat: "meta-bot",     q: "Cosa sai fare?",                                                            expected: "OFF_TOPIC", note: "capability enquiry" },
  { id: 26, cat: "meta-bot",     q: "Chi ti ha creato?",                                                         expected: "OFF_TOPIC", note: "domanda sul bot" },
  { id: 27, cat: "meta-bot",     q: "Sei un'intelligenza artificiale?",                                          expected: "OFF_TOPIC", note: "natura del bot" },
  { id: 28, cat: "meta-bot",     q: "Quanto costa usarti?",                                                      expected: "OFF_TOPIC", note: "pricing del bot" },

  // LLM-task — task generici da chatbot generalista
  { id: 29, cat: "llm-task",     q: "Scrivimi un riassunto di questo testo",                                     expected: "OFF_TOPIC", note: "riassunto generico" },
  { id: 30, cat: "llm-task",     q: "Traducimi 'ciao' in inglese",                                               expected: "OFF_TOPIC", note: "traduzione" },
  { id: 31, cat: "llm-task",     q: "Fammi una poesia sulla primavera",                                          expected: "OFF_TOPIC", note: "creative writing" },

  // Search-ambig — SEARCH legittime con parole-trappola
  { id: 32, cat: "search-ambig", q: "Dati sui contratti pubblici per appalti sportivi",                          expected: "SEARCH",    note: "'sportivi' può confondere" },
  { id: 33, cat: "search-ambig", q: "Informazioni sugli eventi culturali finanziati dal comune",                 expected: "SEARCH",    note: "'eventi' non è sempre off-topic" },
  { id: 34, cat: "search-ambig", q: "Elenco delle ricette tradizionali regionali tutelate",                      expected: "SEARCH",    note: "'ricette' DOP/IGP, SEARCH legittima" },

  // Enrich-alt — varianti ENRICH per robustezza pre-filtro
  { id: 35, cat: "enrich-alt",   q: "Puoi convertirmi un CSV in RDF?",                                           expected: "ENRICH",    note: "'rdf' matcha pre-filtro" },
  { id: 36, cat: "enrich-alt",   q: "Voglio generare i linked data dal mio dataset",                             expected: "ENRICH",    note: "'linked data' matcha pre-filtro" },

  // Validate-alt — varianti VALIDATE per robustezza pre-filtro
  { id: 37, cat: "validate-alt", q: "Questo CSV ha errori?",                                                     expected: "VALIDATE",  note: "'csv ha errori' matcha pre-filtro" },
  { id: 38, cat: "validate-alt", q: "Il mio file rispetta lo standard?",                                         expected: ["VALIDATE","SEARCH"], note: "'rispetta lo standard' matcha pre-filtro" },

  // Sigle-PA — whitelist sigle corte
  { id: 39, cat: "sigle-pa",     q: "Cerco dati sul PNRR",                                                       expected: "SEARCH",    note: "sigla whitelist (4 char)" },
  { id: 40, cat: "sigle-pa",     q: "Quali sono i CIG aggiudicati nel 2024?",                                    expected: "SEARCH",    note: "sigla whitelist + domanda fattuale su catalogo" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function matchExpected(a, e) { return Array.isArray(e) ? e.includes(a) : a === e; }
function fmtExpected(e) { return Array.isArray(e) ? e.join("|") : e; }

async function callIntent(message) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": SESSION },
      body: JSON.stringify({ message }),
      signal: ctrl.signal,
    });
    const latency = Date.now() - t0;
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { ok: r.ok, status: r.status, body, latency };
  } catch (e) {
    return { ok: false, status: 0, body: { error: e.message }, latency: Date.now() - t0 };
  } finally { clearTimeout(to); }
}

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const RED = "\x1b[31m", GRN = "\x1b[32m", YLW = "\x1b[33m", CYA = "\x1b[36m", DIM = "\x1b[2m", RST = "\x1b[0m";

async function main() {
  const totSec = Math.round(TESTS.length * DELAY_MS / 1000);
  console.log(`\n🔍 SIMBA intent classifier — regression test (${TESTS.length} domande)`);
  console.log(`   endpoint: ${ENDPOINT}`);
  console.log(`   session:  ${SESSION}`);
  console.log(`   delay:    ${DELAY_MS}ms  (durata stimata: ~${Math.floor(totSec/60)}m${totSec%60}s)\n`);

  console.log(pad("#",3) + pad("Cat",14) + pad("Q",50) + pad("Atteso",18) + pad("Ricevuto",12) + pad("AI",4) + pad("ms",6) + "✓");
  console.log("─".repeat(110));

  const results = [];
  let lastCat = null;
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    if (t.cat !== lastCat) {
      console.log(`${CYA}── ${t.cat} ──${RST}`);
      lastCat = t.cat;
    }
    const r = await callIntent(t.q);
    const actual = r.body?.intent ?? "ERROR";
    const aiUsed = r.body?.ai_used === true;
    const pass = r.ok && matchExpected(actual, t.expected);
    const mark = pass ? `${GRN}✓${RST}` : `${RED}✗${RST}`;

    results.push({
      id: t.id, category: t.cat, question: t.q,
      expected: t.expected, actual,
      ai_used: aiUsed,
      source: aiUsed ? "llm" : (r.ok ? "pre-filter/sparql" : "error"),
      pass, status: r.status, latency_ms: r.latency,
      note: t.note, raw: r.body,
    });

    const color = pass ? "" : YLW;
    console.log(
      pad(t.id, 3) + pad(t.cat, 14) + pad(t.q, 50) +
      pad(fmtExpected(t.expected), 18) +
      color + pad(actual, 12) + RST +
      pad(aiUsed ? "llm" : "det", 4) +
      pad(r.latency, 6) + mark
    );

    if (i < TESTS.length - 1) await sleep(DELAY_MS);
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  const pass  = results.filter(r => r.pass).length;
  const total = results.length;
  const byIntent = results.reduce((a, r) => ((a[r.actual] = (a[r.actual] ?? 0) + 1), a), {});
  const aiCount  = results.filter(r => r.ai_used).length;

  console.log("\n" + "═".repeat(110));
  console.log(`  Totale: ${pass}/${total} pass  (${((pass/total)*100).toFixed(0)}%)`);
  console.log(`  Distribuzione intent: ${Object.entries(byIntent).map(([k,v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  Decisioni LLM vs deterministiche: ${aiCount} llm / ${total - aiCount} det`);

  console.log(`\n  Per categoria:`);
  const cats = [...new Set(results.map(r => r.category))];
  for (const c of cats) {
    const rows = results.filter(r => r.category === c);
    const p = rows.filter(r => r.pass).length;
    const color = p === rows.length ? GRN : (p === 0 ? RED : YLW);
    console.log(`    ${color}${pad(c, 14)}${RST} ${p}/${rows.length}`);
  }

  const fails = results.filter(r => !r.pass);
  if (fails.length) {
    console.log(`\n${RED}  ${fails.length} mismatch:${RST}`);
    for (const f of fails) {
      console.log(`   • [${f.category}] #${f.id} "${f.question.slice(0,65)}"`);
      console.log(`       atteso ${fmtExpected(f.expected)} → ricevuto ${YLW}${f.actual}${RST} (${f.source}, status ${f.status})`);
      console.log(`       ${DIM}${f.note}${RST}`);
    }
    console.log();
  }

  // ─── Output files ────────────────────────────────────────────────────
  const outDir = process.cwd();
  const jsonPath = path.join(outDir, "simba-intent-results.json");
  const csvPath  = path.join(outDir, "simba-intent-results.csv");

  fs.writeFileSync(jsonPath, JSON.stringify({
    endpoint: ENDPOINT, session: SESSION, timestamp: new Date().toISOString(),
    total, pass, fails: fails.length, results,
  }, null, 2));

  const csvEsc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csvRows = [
    ["id","category","question","expected","actual","ai_used","source","pass","status","latency_ms","note"].join(","),
    ...results.map(r => [
      r.id, r.category, csvEsc(r.question), csvEsc(fmtExpected(r.expected)),
      r.actual, r.ai_used, r.source, r.pass, r.status, r.latency_ms, csvEsc(r.note),
    ].join(",")),
  ].join("\n");
  fs.writeFileSync(csvPath, csvRows);

  console.log(`  📄 ${jsonPath}`);
  console.log(`  📄 ${csvPath}\n`);

  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(2); });
