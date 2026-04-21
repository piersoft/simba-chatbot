
// ── Post-processing ontologie (fix dall'index.html standalone) ───────────────
function postProcessOntologie(ontos, headers) {
  const result = new Set(ontos);
  const norm = headers.map(h => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 30));
  const has   = (cols) => cols.every(c => norm.includes(c));
  const hasH  = (cols) => cols.some(c => norm.some(n => n.includes(c)));

  // OSM schema: rimuovi ontologie spurie
  const _hasPOIcoord = hasH(["lat","lon","latitudine","longitudine","utmx","utmy","x_wgs","y_wgs","x_etrs","y_etrs"]);
  const _hasOSMschema = has(["osm_id","osm_type"]) && _hasPOIcoord;
  if (_hasOSMschema) {
    result.delete("SMAPIT"); result.delete("Cultural-ON"); result.delete("ACCO");
    if (result.has("TI") && !hasH(["data_inizio","data_fine","data_evento","tipo_evento","titolo_evento"])) result.delete("TI");
  }

  // OpenCUP/BDAP: rimuovi Cultural-ON se c'è codice_cup
  if (has(["codice_cup"]) || has(["codice_locale_progetto","codice_cup"])) {
    result.delete("Cultural-ON"); result.delete("CulturalON"); result.delete("PARK"); result.delete("POI");
  }

  // Esercizi commerciali senza contratto: non PublicContract
  const _hasEsercizio = hasH(["insegna","insegna_commerciale","tipo_esercizio","categoria_esercizio"]);
  const _hasContratto = hasH(["cig","cup","importo_aggiudicazione","oggetto_gara","oggetto_contratto"]);
  if (_hasEsercizio && !_hasContratto) result.delete("PublicContract");

  // CLV toponomastica pura: rimuovi spurii se non ci sono coordinate o trigger forti
  if (result.has("CLV") && !_hasPOIcoord && !result.has("IoT") &&
      !hasH(["codice_ipa","partita_iva","tipo_poi","dae","importo","cig","cup","insegna"])) {
    if (result.has("COV") && !hasH(["codice_ipa","cf_ente","ragione_sociale","tipo_ente"])) result.delete("COV");
    if (result.has("TI") && !hasH(["data_inizio","data_fine","data_evento","quando","inizio","termine"])) result.delete("TI");
    if (result.has("POI") && !hasH(["tipo_poi","nome_poi","dae","lat","lon","coorx","coory"])) result.delete("POI");
    if (result.has("CPV") && !hasH(["cognome","codice_fiscale","data_nascita"])) result.delete("CPV");
  }

  // QB + CulturalON/ACCO/GTFS: QB non su strutture ricettive/trasporti
  if (result.has("QB") && (result.has("CulturalON") || result.has("ACCO") || result.has("GTFS"))) result.delete("QB");

  // SMAPIT esclude QB/CPV/CulturalON
  if (result.has("SMAPIT")) { result.delete("CulturalON"); result.delete("Cultural-ON"); result.delete("QB"); result.delete("CPV"); }

  // RO: data mandato non è evento
  if (result.has("RO") && result.has("TI") && !hasH(["data_evento","titolo_evento","tipo_evento_pubblico"])) result.delete("TI");

  return Array.from(result);
}

/**
 * rdf-mcp — Adapter locale per worker.js CSV-to-RDF
 *
 * Scarica worker.js dalla repo CSV-to-RDF all'avvio (o usa la copia locale).
 * Espone le stesse API dell'endpoint Cloudflare:
 *   GET  /?url=<csv_url>&ipa=<ipa>&pa=<nome>&fmt=<ttl|json|rdfxml>
 *   POST /  (body: text/csv)
 *
 * Si aggiorna automaticamente ogni notte scaricando il worker.js aggiornato.
 */

import express from "express";
import { createRequire } from "module";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.js");
const WORKER_URL  = "https://raw.githubusercontent.com/piersoft/CSV-to-RDF/main/worker.js";
const PORT        = process.env.PORT || 3003;

// ── Scarica/aggiorna worker.js ───────────────────────────────────────────────
async function downloadWorker() {
  try {
    console.log("[rdf-mcp] Scarico worker.js aggiornato...");
    const res = await fetch(WORKER_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    writeFileSync(WORKER_PATH, text, "utf-8");
    console.log(`[rdf-mcp] worker.js aggiornato (${text.length} bytes)`);
    return true;
  } catch (e) {
    console.warn("[rdf-mcp] Impossibile scaricare worker.js:", e.message);
    return false;
  }
}

// ── Carica il worker come modulo Cloudflare Worker emulato ──────────────────
let workerHandler = null;

async function loadWorker() {
  // Scarica sempre all'avvio per garantire l'ultima versione
  const downloaded = await downloadWorker();
  if (!downloaded && !existsSync(WORKER_PATH)) {
    console.error("[rdf-mcp] worker.js non disponibile — uscita"); process.exit(1);
  }
  if (!downloaded) {
    console.warn("[rdf-mcp] Download fallito, uso worker.js in cache");
  }
  // Leggo il sorgente e converto l'export Cloudflare in funzione eseguibile
  let src = readFileSync(WORKER_PATH, "utf-8");

  // Cloudflare Worker usa "export default { fetch(request, env, ctx) {...} }"
  // Lo wrapping: rimuovo l'export default e assegno a una variabile
  src = src.replace(/^export default\s*\{/m, "const __workerExport = {");
  src += "\n globalThis.__workerHandler = __workerExport;\n";
  // Esponi computeSemanticScore per /validate-semantic
  src += '\n if(typeof computeSemanticScore==="function") globalThis.computeSemanticScore=computeSemanticScore;\n';
  src += '\n if(typeof detectOntologiesDeterministic==="function") globalThis.detectOntologiesDeterministic=detectOntologiesDeterministic;\n';

  // Eseguo in un contesto isolato usando Function()
  try {
    new Function(src)();
    workerHandler = globalThis.__workerHandler;
    console.log("[rdf-mcp] worker.js caricato OK");
  } catch (e) {
    console.error("[rdf-mcp] Errore caricamento worker:", e.message);
    process.exit(1);
  }
}

// ── Express adapter ──────────────────────────────────────────────────────────
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (req, res) => res.sendStatus(204));

// ── Endpoint /validate-semantic ──────────────────────────────────────────────
app.post("/validate-semantic", express.json(), async (req, res) => {
  try {
    const { headers, rows, ontos, title } = req.body || {};
    // Headers vuoti o mancanti → BLOCCANTE diretto
    if (!headers || !Array.isArray(headers) || headers.length === 0) {
      return res.json({
        stato: "BLOCCANTE", score: 0,
        score_detail: { struttura: 0, ontologie: 0, linked_data: 0 },
        blockers: [{ id: "S0", msg: "Nessun header rilevato. Impossibile valutare il CSV." }],
        warnings: [], suggestions: [], renamed_headers: {}, ontos_detected: []
      });
    }
    const fn = globalThis.computeSemanticScore;
    if (typeof fn !== "function") {
      return res.status(503).json({ error: "computeSemanticScore non disponibile" });
    }
    // Se ontos non forniti, rileva automaticamente dagli header
    let resolvedOntos = (ontos && ontos.length > 0) ? ontos : [];
    if (resolvedOntos.length === 0 && typeof globalThis.detectOntologiesDeterministic === "function") {
      resolvedOntos = globalThis.detectOntologiesDeterministic(headers, rows || []) || [];
    }
    const result = fn(headers, rows || [], resolvedOntos, title || "", "", null);
    res.json(result);
  } catch (e) {
    console.error("[rdf-mcp] /validate-semantic errore:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use(async (req, res) => {
  try {
    // Costruisco un oggetto Request compatibile con Cloudflare Worker
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const fullUrl  = `${protocol}://${req.headers.host}${req.url}`;

    let bodyBuffer = null;
    if (req.method === "POST") {
      bodyBuffer = await new Promise((resolve) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
    }

    const cfRequest = new Request(fullUrl, {
      method:  req.method,
      headers: req.headers,
      body:    bodyBuffer,
    });

    const cfResponse = await workerHandler.fetch(cfRequest, {}, {});

    res.status(cfResponse.status);
    cfResponse.headers.forEach((v, k) => {
      if (!["content-encoding","transfer-encoding"].includes(k.toLowerCase()))
        res.setHeader(k, v);
    });

    const body = await cfResponse.arrayBuffer();
    // Post-processing ontologie: applica gli stessi fix dell'index.html standalone
    try {
      const txt = Buffer.from(body).toString("utf8");
      const json = JSON.parse(txt);
      if (json.ontologie && Array.isArray(json.ontologie)) {
        json.ontologie = postProcessOntologie(json.ontologie, json.colonne || []);
        res.end(Buffer.from(JSON.stringify(json)));
      } else {
        res.end(Buffer.from(body));
      }
    } catch {
      res.end(Buffer.from(body));
    }

  } catch (e) {
    console.error("[rdf-mcp] Errore handler:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Aggiornamento notturno (ore 3:00) ────────────────────────────────────────
function scheduleNightlyUpdate() {
  const now  = new Date();
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(async () => {
    await downloadWorker();
    await loadWorker();
    scheduleNightlyUpdate();
  }, ms);
  console.log(`[rdf-mcp] Prossimo aggiornamento: ${next.toLocaleString("it")}`);
}

// ── Avvio ────────────────────────────────────────────────────────────────────
await loadWorker();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[rdf-mcp] pronto su http://0.0.0.0:${PORT}`);
  console.log(`[rdf-mcp] Uso: GET http://localhost:${PORT}/?url=<csv_url>&ipa=<ipa>&pa=<nome>`);
  scheduleNightlyUpdate();
});
