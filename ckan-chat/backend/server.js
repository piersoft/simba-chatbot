import express from "express";
import { promises as dns } from "dns";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import { routeQuestion } from "./router.js";

// ─── Analytics: fire-and-forget ───────────────────────────────────────────────
const ANALYTICS_URL = process.env.ANALYTICS_URL || "http://analytics-service:3004";

function anonymizeIP(ip) {
  if (!ip) return null;
  const v4 = (ip || "").match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (v4) return v4[1] + ".0";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + ":0:0:0:0";
  return ip;
}

// Estrae solo OS e browser dal user-agent, senza versione specifica
// Es. "Mozilla/5.0 (Windows NT 10.0) Chrome/120" → "Windows / Chrome"
function parseUA(ua) {
  if (!ua) return null;
  const os = /Windows/.test(ua) ? "Windows"
    : /Mac OS/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Linux/.test(ua) ? "Linux" : "Other";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome/.test(ua) ? "Chrome"
    : /Firefox/.test(ua) ? "Firefox"
    : /Safari/.test(ua) ? "Safari" : "Other";
  return `${os} / ${browser}`;
}

function emitEvent(type, payload, req) {
  const event = {
    type,
    session_id: req?.headers?.["x-session-id"] || null,
    ip: anonymizeIP(
      req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req?.ip || ""
    ),
    user_agent: parseUA(req?.headers?.["user-agent"]),
    ts: new Date().toISOString(),
    ...payload,
  };
  fetch(`${ANALYTICS_URL}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

// ─── Endpoint SPARQL configurabile ───────────────────────────────────────────
const SPARQL_ENDPOINT = process.env.SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";

// ── Blocklist dinamica ────────────────────────────────────────────────────────
const BLOCKLIST_PATH = process.env.BLOCKLIST_PATH || "/app/data/blocklist.json";
const DEFAULT_BLOCKLIST = [
  "ignore previous","system prompt","forget instructions","jailbreak","prompt injection",
  "ignore instructions","disregard","bypass",
  "porn","porno","pornograph","xxx","nude","naked","escort","prostitut",
  "pedofil","pedophil","child abuse","snuff","gore",
  "cumshot","blowjob","handjob","gangbang","creampie","onlyfans","dildo","vibrat",
  "cocain","eroina","metanfetamin","drug deal","narcotic"
];

function loadBlocklist() {
  try {
    if (existsSync(BLOCKLIST_PATH)) {
      return JSON.parse(readFileSync(BLOCKLIST_PATH, "utf-8"));
    }
  } catch(e) { console.warn("[blocklist] Errore lettura:", e.message); }
  return [...DEFAULT_BLOCKLIST];
}

function saveBlocklist(list) {
  try {
    writeFileSync(BLOCKLIST_PATH, JSON.stringify(list, null, 2), "utf-8");
  } catch(e) { console.warn("[blocklist] Errore scrittura:", e.message); }
}

let dynamicBlocklist = loadBlocklist();

app.set("trust proxy", 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(s => s.trim())
    : true,
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Content-Security-Policy", "default-src 'self'");
  next();
});

// ─── Sicurezza: blocco SSRF ──────────────────────────────────────────────────
function isPrivateOrDangerous(urlStr) {
  try {
    const u = new URL(urlStr);
    // Solo HTTP/HTTPS (non file://, ftp://, ecc.)
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    const host = u.hostname.toLowerCase();
    // Blocca IP privati, localhost, metadati cloud
    const blocked = [
      /^localhost$/, /^127\./, /^10\./, /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^0\.0\.0\.0$/,
      /^169\.254\./, /^metadata\./, /^fd[0-9a-f]{2}:/i
    ];
    return blocked.some(r => r.test(host));
  } catch { return true; }
}

// Verifica che l'IP risolto dal DNS non sia privato (anti-SSRF post-redirect)
async function isResolvedIpSafe(hostname) {
  try {
    const result = await dns.lookup(hostname);
    const ip = result.address;
    const blocked = [
      /^127\./, /^10\./, /^192\.168\./,
      /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^0\.0\.0\.0$/,
      /^169\.254\./
    ];
    return !blocked.some(r => r.test(ip));
  } catch { return false; }
}

// ─── Rate limiting globale ────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppe richieste. Riprova tra un minuto." }
});
app.use("/api/", globalLimiter);

const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Troppe richieste su questo endpoint." }
});

app.use("/api/chat", rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Troppe richieste, riprova tra un minuto." }
}));

// ─── Configurazione provider ──────────────────────────────────────────────────
const LLM_PROVIDER = process.env.LLM_PROVIDER || "mistral";

// Lista MCP server: CKAN obbligatorio, validatore e rdf opzionali
const MCP_URLS = [
  process.env.MCP_URL              || "http://ckan-mcp-server:3000/mcp",
  process.env.MCP_URL_VALIDATORE   || null,
  process.env.MCP_URL_RDF          || null,
].filter(Boolean);

// Mistral
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL   = process.env.MISTRAL_MODEL || "mistral-small-latest";
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

// Ollama
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://ollama:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:1.5b";

console.log(`Motore LLM: ${LLM_PROVIDER === "mistral" ? `Mistral (${MISTRAL_MODEL})` : `Ollama (${OLLAMA_URL} - ${OLLAMA_MODEL})`}`);
console.log(`MCP servers: ${MCP_URLS.join(", ")}`);

// ─── MCP helpers (multi-server) ───────────────────────────────────────────────

let toolsCache = null;
let toolsRouteMap = {}; // { toolName → mcpUrl }

async function mcpCallTo(url, method, params = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
  });
  const raw = await res.text();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.startsWith("data:")) {
      try { return JSON.parse(t.slice(5).trim()); } catch {}
    } else if (t.startsWith("{")) {
      try { return JSON.parse(t); } catch {}
    }
  }
  return JSON.parse(raw);
}

// mcpCall sul primo server (CKAN) — usato da /api/health
async function mcpCall(method, params = {}) {
  return mcpCallTo(MCP_URLS[0], method, params);
}

// Tool esposti a Ollama: lista ridotta per non sovraccaricare modelli piccoli.
// Mistral riceve tutti i tool senza filtro.
const OLLAMA_TOOL_WHITELIST = new Set([
  "ckan_package_search",
  "ckan_package_show",
  "ckan_datastore_search",
  "ckan_organization_list",
  "ckan_tag_list",
  "csv_validate",
  "csv_validate_url",
]);

async function getTools() {
  if (toolsCache && toolsCache.length > 0) return toolsCache;
  const allTools = [];
  toolsRouteMap = {};
  for (const url of MCP_URLS) {
    try {
      console.log(`[tools] interrogo ${url}...`);
      const res = await mcpCallTo(url, "tools/list");
      const tools = res.result?.tools ?? [];
      for (const t of tools) {
        toolsRouteMap[t.name] = url;
        allTools.push(t);
      }
      console.log(`[tools] ${url} → ${tools.length} tool: ${tools.map(t=>t.name).join(", ")}`);
    } catch (e) {
      console.warn(`[tools] ERRORE ${url}: ${e.message}`);
    }
  }
  if (allTools.length > 0) toolsCache = allTools; // non cachare se vuoto
  return allTools;
}

function getToolsForProvider(allTools) {
  if (LLM_PROVIDER !== "ollama") return allTools;
  const filtered = allTools.filter(t => OLLAMA_TOOL_WHITELIST.has(t.name));
  console.log(`[tools] Ollama riceve ${filtered.length}/${allTools.length} tool (whitelist)`);
  return filtered;
}

async function callTool(name, args) {
  const url = toolsRouteMap[name] || MCP_URLS[0];
  console.log(`[callTool] ${name} → ${url}`);
  try {
    const res = await mcpCallTo(url, "tools/call", { name, arguments: args });
    console.log(`[callTool] ${name} risposta ricevuta, error=${JSON.stringify(res.error)}`);
    if (res.error) throw new Error(`MCP error ${res.error.code}: ${res.error.message}`);
    const content = res.result?.content ?? [];
    const text = content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    console.log(`[callTool] ${name} ok, ${text.length} chars`);
    return text;
  } catch (e) {
    console.error(`[callTool] ${name} ERRORE: ${e.message}`);
    throw e;
  }
}

// ─── Mistral chat ─────────────────────────────────────────────────────────────

function mcpToolToMistral(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

async function mistralChat(history, tools, model) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(MISTRAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: model || MISTRAL_MODEL,
        messages: history,
        tools,
        tool_choice: "auto",
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });
    if (response.status !== 429) break;
    console.log(`[rate limit] attendo 2s (tentativo ${attempt + 1})`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Mistral error ${response.status}: ${err}`);
  }
  return await response.json();
}

// ─── Ollama chat ──────────────────────────────────────────────────────────────

// Mappa tool per Ollama: schema minimale per ridurre i token.
// I modelli piccoli non leggono le descrizioni dei parametri — gli basta sapere il nome.
const OLLAMA_TOOL_SCHEMAS = {
  ckan_package_search:  { q: "string", server_url: "string", rows: "number" },
  ckan_package_show:    { id: "string", server_url: "string" },
  ckan_datastore_search:{ resource_id: "string", server_url: "string", q: "string", limit: "number" },
  ckan_organization_list:{ server_url: "string" },
  ckan_tag_list:        { server_url: "string" },
  csv_validate:         { csv_url: "string", csv_text: "string", summary_only: "boolean" },
  csv_validate_url:     { url: "string" },
};

function mcpToolToOllama(tool) {
  const knownParams = OLLAMA_TOOL_SCHEMAS[tool.name] ?? {};
  const properties = {};
  for (const [k, type] of Object.entries(knownParams)) {
    properties[k] = { type };
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", properties },
    },
  };
}

async function ollamaChat(history, tools, model) {
  const headers = {
    "Content-Type": "application/json",
    ...(process.env.OLLAMA_API_KEY
      ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
      : {}),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.error("[ollama] TIMEOUT dopo 90s — abort");
    controller.abort();
  }, 90000);
  console.log(`[ollama] invio richiesta a ${OLLAMA_URL}/api/chat model=${model || OLLAMA_MODEL} msgs=${history.length} tools=${tools.length}`);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: model || OLLAMA_MODEL,
        messages: history,
        tools,
        stream: false,
        options: { temperature: 0.3 },
      }),
    });
    clearTimeout(timeout);
    console.log(`[ollama] risposta HTTP ${res.status}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error ${res.status}: ${err}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ─── Guardrail: classificatore domanda ───────────────────────────────────────

const GUARDRAIL_PROMPT = `Sei un classificatore. Il tuo unico compito è decidere se la domanda dell'utente riguarda open data, dataset, portali dati, CKAN, dati aperti, statistiche pubbliche, API di dati, validazione CSV, conversione RDF, ontologie PA o argomenti correlati.
Rispondi SOLO con la parola SI se la domanda è pertinente, oppure SOLO con la parola NO se non lo è.
Non aggiungere nulla altro, nessuna spiegazione, nessun punto, nessuno spazio.`;

// Rimuove i tag <think>...</think> che qwen3 aggiunge prima della risposta
function stripThinkTags(text) {
  return (text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function isQuestionOnTopic(userMessage) {
  try {
    if (LLM_PROVIDER === "mistral") {
      const response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [
            { role: "system", content: GUARDRAIL_PROMPT },
            { role: "user", content: userMessage },
          ],
          max_tokens: 5,
          temperature: 0,
        }),
      });
      if (!response.ok) return true;
      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content ?? "SI";
      const answer = stripThinkTags(raw).toUpperCase();
      console.log(`[guardrail] risposta classificatore: "${answer}"`);
      return answer.startsWith("SI");
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            { role: "system", content: GUARDRAIL_PROMPT },
            { role: "user", content: userMessage },
          ],
          stream: false,
          options: { temperature: 0, num_predict: 512 },
        }),
      });
      if (!res.ok) return true;
      const data = await res.json();
      const raw = data.message?.content ?? "";
      const stripped = stripThinkTags(raw).toUpperCase();
      // Cerca SI o NO ovunque nel testo (qwen3 a volte aggiunge punteggiatura)
      const hasNo  = /\bNO\b/.test(stripped);
      const hasSi  = /\bSI\b/.test(stripped) || stripped.includes("YES");
      const answer = stripped.slice(0, 10); // per il log
      console.log(`[guardrail] raw="${raw.slice(0,60).replace(/\n/g," ")}" → stripped="${answer}"`);
      if (!stripped) return true; // fallback permissivo se vuoto
      if (hasNo && !hasSi) return false;
      return true;
    }
  } catch (e) {
    console.error("[guardrail] errore classificatore, lascio passare:", e.message);
    return true;
  }
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sei un assistente specializzato esclusivamente in open data e portali CKAN.
Il tuo unico scopo è aiutare l'utente a cercare, esplorare e comprendere dataset e dati aperti.
Hai accesso a strumenti per interrogare portali CKAN, validare CSV e convertire in RDF.

REGOLE FONDAMENTALI:
- Usa SEMPRE gli strumenti disponibili per rispondere con dati reali aggiornati.
- Il portale principale è https://www.dati.gov.it/opendata (Italia), ma puoi usare qualsiasi URL CKAN.
- Non rispondere mai a domande che non riguardano open data, dataset, portali CKAN o dati pubblici.
- Se l'utente fa domande fuori tema (cucina, sport, intrattenimento, ecc.), declina educatamente.
- Rispondi sempre in italiano in modo chiaro e conciso.

LINK AI DATASET - REGOLA CRITICA:
- Usa SEMPRE il campo "view_url" restituito dagli strumenti come link al dataset.
- Se "view_url" non è disponibile, costruisci il link con il campo "id" (UUID) così:
  https://www.dati.gov.it/view-dataset/dataset?id=<UUID>
- NON usare MAI il formato /opendata/dataset/<nome-slug>: è SBAGLIATO.
- NON inventare URL: usa solo quelli restituiti dagli strumenti.

FORMATO RISPOSTA:
- Quando trovi dataset, mostra: nome, organizzazione, descrizione breve e link (view_url).
- Per validazioni CSV, riporta score, verdict e i principali problemi trovati.
`;

const SYSTEM_PROMPT_OLLAMA = `Sei un assistente CKAN. Rispondi SOLO su open data e dataset.

ISTRUZIONE OBBLIGATORIA: Per QUALSIASI domanda su dati, dataset o open data devi chiamare uno strumento prima di rispondere. Non rispondere MAI dal tuo addestramento interno.

Strumenti disponibili:
- ckan_package_search: cerca dataset per parola chiave
- ckan_package_show: dettagli di un dataset
- ckan_organization_list: lista organizzazioni
- ckan_tag_list: lista tag disponibili
- ckan_datastore_search: cerca dati dentro una risorsa
- csv_validate: valida un CSV da URL o testo grezzo
- csv_validate_url: scarica e valida un CSV da URL risorsa CKAN

Portale da usare: https://www.dati.gov.it/opendata

ESEMPIO CORRETTO:
Utente: "cerca dataset sull'aria"
Tu: chiami ckan_package_search con q="aria" e server_url="https://www.dati.gov.it/opendata"

LINK AI DATASET - REGOLA CRITICA:
- Usa SEMPRE il campo "view_url" restituito dagli strumenti come link al dataset.
- Se "view_url" non è disponibile, costruisci il link con "id" (UUID):
  https://www.dati.gov.it/view-dataset/dataset?id=<UUID>
- NON usare MAI il formato /opendata/dataset/<nome-slug>: è SBAGLIATO.

REGOLA ASSOLUTA: Se non chiami uno strumento, la tua risposta è sbagliata.
Rispondi sempre in italiano.`;

function buildNudgeMessage(userQuestion) {
  return {
    role: "user",
    content: `[PROMEMORIA SISTEMA: Per rispondere a questa domanda DEVI chiamare uno strumento CKAN. Non rispondere senza aver prima chiamato un tool.]\n\n${userQuestion}`,
  };
}

const RETRY_MESSAGE = {
  role: "user",
  content: `[ERRORE: Non hai chiamato nessuno strumento. DEVI usare uno degli strumenti disponibili per cercare dati reali. Riprova chiamando ckan_package_search o un altro strumento adeguato.]`,
};

async function chatWithTools(messages, model) {
  const toolCallsLog = [];
  const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content ?? "";

  // ── Mistral: agentic loop classico con tool definitions ──────────────────
  if (LLM_PROVIDER === "mistral") {
    const tools = await getTools();
    const history = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];
    for (let round = 0; round < 6; round++) {
      if (round > 0) await new Promise(r => setTimeout(r, 1200));
      const data = await mistralChat(history, tools.map(mcpToolToMistral), model);
      const msg = data.choices[0].message;
      const finishReason = data.choices[0].finish_reason;
      history.push(msg);
      if (finishReason === "stop" || finishReason === "end_turn" || !msg.tool_calls?.length) {
        const reply = typeof msg.content === "string"
          ? msg.content
          : msg.content?.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
        return { reply, toolCalls: toolCallsLog };
      }
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        const fnArgs = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        console.log(`[tool] ${fnName}`, JSON.stringify(fnArgs).slice(0, 120));
        toolCallsLog.push({ tool: fnName, args: fnArgs });
        let result;
        try { result = await callTool(fnName, fnArgs); }
        catch (e) { result = `Errore: ${e.message}`; }
        history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: result });
      }
    }
    return { reply: "Nessuna risposta ottenuta.", toolCalls: toolCallsLog };
  }

  // ── Ollama: router deterministico → MCP → sintesi LLM ────────────────────
  // Il modello NON riceve tool definitions: zero overhead di tokenizzazione.
  // 1. Router decide quale tool chiamare
  const route = routeQuestion(lastUserMsg);
  console.log(`[router] tool=${route.tool} args=${JSON.stringify(route.args).slice(0, 100)}`);

  if (route.fallback) {
    return { reply: route.fallback, toolCalls: [] };
  }

  // 2. Chiama il tool MCP direttamente
  let mcpResult = "";
  try {
    mcpResult = await callTool(route.tool, route.args);
    toolCallsLog.push({ tool: route.tool, args: route.args });
    console.log(`[router] risultato MCP: ${mcpResult.slice(0, 150)}`);
  } catch (e) {
    console.error(`[router] errore MCP: ${e.message}`);
    return { reply: `Errore nel recupero dei dati: ${e.message}`, toolCalls: toolCallsLog };
  }

  // 3. Ollama sintetizza solo il testo — nessun tool, prompt minimale
  const synthesisPrompt = `Sei un assistente open data. Rispondi in italiano in modo chiaro e conciso.
Usa i dati forniti per rispondere alla domanda. Non inventare nulla.
Se trovi dataset mostra: nome, organizzazione, descrizione breve e link.`;

  const synthesisMessages = [
    { role: "system", content: synthesisPrompt },
    { role: "user", content: `Domanda: ${lastUserMsg}\n\nDati disponibili:\n${mcpResult.slice(0, 3000)}` },
  ];

  try {
    console.log(`[ollama] sintesi risposta...`);
    const data = await ollamaChat(synthesisMessages, [], model);
    const raw = data.message?.content ?? "";
    const reply = stripThinkTags(raw);
    console.log(`[ollama] risposta sintetizzata: ${reply.slice(0, 100)}`);
    return { reply, toolCalls: toolCallsLog };
  } catch (e) {
    console.error(`[ollama] errore sintesi: ${e.message}`);
    // Fallback: restituisce il risultato MCP grezzo senza sintesi LLM
    return { reply: mcpResult.slice(0, 2000), toolCalls: toolCallsLog };
  }
}


// ─── Intent classifier ───────────────────────────────────────────────────────
// Ollama fa UNA SOLA cosa: classificare l'intenzione in 4 categorie.
// Output atteso: SEARCH | VALIDATE | ENRICH | OFF_TOPIC
// ~1 secondo su CPU, nessun tool definition, prompt minimale.

const INTENT_PROMPT = `Sei un classificatore per un assistente open data italiano. Rispondi con UNA SOLA parola.

SEARCH: cercare, trovare, scoprire dataset o dati aperti della PA
VALIDATE: controllare, verificare, validare la qualità di un CSV che l'utente possiede
ENRICH: convertire CSV in RDF, TTL, Turtle, Linked Data
OFF_TOPIC: tutto il resto (cucina, sport, meteo, saluti, domande generali)

Regola chiave: se l'utente dice "ho dei dati" o "ho un file" o "ho un CSV" → VALIDATE (possiede già i dati).
Se l'utente vuole trovare dati → SEARCH.

Esempi:
"cerca dataset qualità aria" → SEARCH
"trova dati sui rifiuti" → SEARCH
"ho dei dati sui rifiuti da controllare" → VALIDATE
"ho un CSV da verificare" → VALIDATE
"ho un file CSV" → VALIDATE
"valida questo CSV" → VALIDATE
"converti in TTL" → ENRICH
"come stai" → OFF_TOPIC

Rispondi SOLO con una di queste parole: SEARCH VALIDATE ENRICH OFF_TOPIC`;

// Pre-filtro deterministico — logica whitelist
// Se il messaggio NON contiene nessuna keyword open data → OFF_TOPIC diretto
// Ollama interviene SOLO quando ci sono keyword open data ma l'intent è ambiguo
function preFilterIntent(text) {
  const t = text.toLowerCase().trim();

  // VALIDATE — univoco, intercetta con certezza
  const validateKw = ["valida","valid","controlla il csv","verifica il csv",
    "qualità csv","errori csv","controllo csv","check csv","analizza csv",
    // Pattern "ho dei/un/il dati/file/csv da..." → l'utente possiede già i dati
    "ho dei dati","ho un csv","ho un file","ho il csv","ho il file",
    "ho dei csv","miei dati","mio csv","mio file","da controllare","da verificare",
    "da validare","da analizzare","da controllare",
    "verifica i dati","verifica il file","controlla i dati","controlla il file",
    "qualità dei dati","qualità del csv","qualità del file"];
  if (validateKw.some(k => t.includes(k))) return "VALIDATE";

  // ENRICH — univoco, intercetta con certezza
  const enrichKw = ["ttl","turtle","rdf","linked data","ontolog",
    "converti in","trasforma in","arricch","semantic","genera ttl","genera rdf"];
  if (enrichKw.some(k => t.includes(k))) return "ENRICH";

  // Per tutto il resto: prima ASK SPARQL, poi eventualmente Ollama
  return null;
}

// Verifica se esistono dataset su lod.dati.gov.it con le parole chiave
// Usa ASK query — leggerissima, risposta booleana
async function sparqlAsk(text) {
  // Estrai parole significative (> 3 caratteri, no stopword)
  const stopwords = new Set(["cosa","come","dove","quando","perché","quali","quali",
    "sono","sarà","viene","voglio","vorrei","puoi","posso","devo","avere","essere",
    "tutti","tutte","della","delle","degli","dello","nella","nelle","negli",
    "questo","questa","questi","queste","anche","però","oppure","cerca","trova",
    "mostra","dammi","elenca","dataset","dati","file","apri",
    // Saluti e frasi comuni senza contenuto informativo
    "stai","ciao","salve","buon","buona","buongiorno","buonasera","grazie",
    "prego","scusa","scusi","aiuto","aiutami","help","hello","certo","okay",
    "bene","male","così","tanto","molto","poco","niente","qualcosa","tutto",
    "fatto","fare","dire","sapere","avere","stare","andare","venire",
    // Verbi colloquiali di richiesta
    "fammi","fammi","mostra","mostrami","dimmi","elenca","cerca","trova",
    "voglio","vorrei","puoi","potrei","vedere","sapere","avere","prendere",
    "dammi","datemi","serve","servono","vorrei","avere","trovare"]);
  
  const words = text.toLowerCase()
    .replace(/[^a-zàèéìòù\s]/g, " ")
    .split(/\s+/)
    .filter(w => {
      // Whitelist sigle PA — sempre accettate anche se corte
      const siglePa = new Set(['cup','cig','imu','iva','pec','pnrr','rup','pgt','prg','psc','vvf','asl','ats','inps','inail','agid','anas','aci','mef']);
      if (siglePa.has(w)) return true;
      return w.length > 3 && !stopwords.has(w);
    });

  if (words.length === 0) return false;

  // Usa le prime 2 parole significative per la ASK query
  const keyword = words.slice(0, 2).join(" ");
  
  // Se ci sono 2+ parole significative, richiedi che ENTRAMBE siano nel titolo (AND)
  // Questo riduce drasticamente i falsi positivi
  const mainWord = words.find(w => w.length > 4) || words[0];
  const secondWord = words.filter(w => w !== mainWord).find(w => w.length > 3);
  // Ogni parola viene cercata in titolo OR descrizione OR keyword (AND tra parole)
  const wordFilter = (w) => {
    const wl = w.replace(/"/g, '');
    return `(CONTAINS(LCASE(STR(?t)),"${wl}")||CONTAINS(LCASE(STR(?desc)),"${wl}")||CONTAINS(LCASE(STR(?kw)),"${wl}"))`;
  };
  let filterClause;
  if (secondWord) {
    filterClause = `${wordFilter(mainWord)} && ${wordFilter(secondWord)}`;
  } else {
    filterClause = wordFilter(mainWord);
  }
  const query = `PREFIX dct: <http://purl.org/dc/terms/>
PREFIX dcat: <http://www.w3.org/ns/dcat#>
ASK {
  ?d a dcat:Dataset .
  ?d dct:title ?t .
  OPTIONAL { ?d dct:description ?desc }
  OPTIONAL { ?d dcat:keyword ?kw }
  FILTER(${filterClause})
}`;

  try {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
    const r = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return true; // in caso di errore lascia passare
    const data = await r.json();
    return data.boolean === true;
  } catch {
    return true; // in caso di timeout/errore lascia passare
  }
}

async function classifyIntent(userMessage) {
  // Prima prova il pre-filtro deterministico
  const preFilter = preFilterIntent(userMessage);
  if (preFilter) {
    console.log(`[intent] pre-filtro → ${preFilter}`);
    return { intent: preFilter, aiUsed: false };
  }
  // Testo SPARQL ASK — il catalogo reale decide se esistono dataset
  console.log(`[intent] verifico su SPARQL...`);
  const hasDatasets = await sparqlAsk(userMessage);
  if (!hasDatasets) {
    console.log(`[intent] SPARQL ASK → nessun dataset → OFF_TOPIC`);
    return { intent: "OFF_TOPIC", aiUsed: false };
  }
  console.log(`[intent] SPARQL ASK → dataset trovati → chiedo ad Ollama per disambiguare`);
  // Nota: se Ollama risponde SEARCH, il SPARQL ASK ha già confermato che esistono dataset
  // Dataset esistono MA intent ambiguo (SEARCH? VALIDATE? ENRICH?) → Ollama decide
  try {
    if (LLM_PROVIDER === "mistral") {
      const response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${MISTRAL_API_KEY}` },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: [{ role: "system", content: INTENT_PROMPT }, { role: "user", content: userMessage }],
          max_tokens: 5, temperature: 0,
        }),
      });
      if (!response.ok) return { intent: "SEARCH", aiUsed: true };
      const data = await response.json();
      const raw = data.choices?.[0]?.message?.content ?? "SEARCH";
      const parsed = parseIntent(raw);
      return { intent: parsed, aiUsed: true };
    } else {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [{ role: "system", content: INTENT_PROMPT }, { role: "user", content: userMessage }],
          stream: false,
          options: { temperature: 0, num_predict: 10 },
        }),
      });
      if (!res.ok) return { intent: "SEARCH", aiUsed: true };
      const data = await res.json();
      const raw = data.message?.content ?? "SEARCH";
      const parsed = parseIntent(stripThinkTags(raw));
      // Se Ollama dice SEARCH, il SPARQL ASK iniziale ha già confermato dataset esistenti
      // ma potrebbe essere un falso positivo — il frontend gestisce risultati vuoti
      return { intent: parsed, aiUsed: true };
    }
  } catch (e) {
    console.error("[intent] errore:", e.message);
    return { intent: "SEARCH", aiUsed: false };
  }
}

function parseIntent(raw) {
  const t = raw.trim().toUpperCase();
  if (t.includes("VALIDATE")) return "VALIDATE";
  if (t.includes("ENRICH")) return "ENRICH";
  if (t.includes("OFF_TOPIC") || t.includes("OFF TOPIC")) return "OFF_TOPIC";
  return "SEARCH"; // default sicuro
}

app.post("/api/intent", strictLimiter, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  if (message.length > 500) return res.status(400).json({ error: "Messaggio troppo lungo (max 500 caratteri)." });
  const msgLower = message.toLowerCase();
  if (dynamicBlocklist.some(p => msgLower.includes(p.toLowerCase()))) return res.status(400).json({ error: "Richiesta non consentita." });
  const { intent, aiUsed } = await classifyIntent(message);
  console.log(`[intent] "${message.slice(0,60)}" → ${intent}`);
  res.json({ intent, ai_used: aiUsed });
});


// ─── Search: non più gestita dal backend ─────────────────────────────────────
// La ricerca SPARQL viene eseguita direttamente dal frontend nel browser.
// lod.dati.gov.it blocca le chiamate server-side (403).

async function fetchCsvResources(datasetId) {
  try {
    const CKAN_API = "https://www.dati.gov.it/opendata/api/3/action";
    const res = await fetch(`${CKAN_API}/package_show?id=${datasetId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const resources = data.result?.resources ?? [];
    return resources
      .filter(r => (r.format || "").toUpperCase() === "CSV" || (r.url || "").endsWith(".csv"))
      .map(r => ({ name: r.name || "CSV", url: r.url, id: r.id }));
  } catch { return []; }
}

app.get("/api/resources/:datasetId", async (req, res) => {
  try {
    const csvResources = await fetchCsvResources(req.params.datasetId);
    res.json({ csvResources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Validate endpoint diretto ───────────────────────────────────────────────
// Chiama validatore-mcp direttamente senza passare per Ollama.

app.post("/api/validate", strictLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  if (isPrivateOrDangerous(url)) return res.status(400).json({ error: "URL non consentito." });
  if (url.length > 2048) return res.status(400).json({ error: "URL troppo lungo." });
  try {
    const hostname = new URL(url).hostname;
    if (!(await isResolvedIpSafe(hostname))) return res.status(400).json({ error: "URL non consentito (IP risolto non sicuro)." });
  } catch { return res.status(400).json({ error: "URL non valido." }); }
  // Controllo Content-Type — verifica che la risorsa sia effettivamente un CSV
  const ctCheck = await checkCsvContentType(url);
  if (!ctCheck.ok) {
    return res.status(422).json({
      error: `La risorsa non sembra un file CSV. Content-Type rilevato: "${ctCheck.contentType}". ` +
             `Potrebbe essere una pagina HTML, un archivio ZIP o un altro formato. ` +
             `Verifica il link diretto al file CSV nel portale open data.`
    });
  }

  console.log(`[validate] ${url}` + (ctCheck.warning ? ` [warning: ${ctCheck.warning}]` : ""));
  const { dataset_title: reqTitle } = req.body;
  const t0val = Date.now();
  try {
    // Scarica il CSV dal backend (più affidabile del validatore-mcp per URL difficili)
    let csv_text = null;
    try {
      const csvResp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv,text/plain,*/*" },
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      if (csvResp.ok) {
        csv_text = await csvResp.text();
        if (csv_text.trimStart().startsWith("<")) csv_text = null; // è HTML
      }
    } catch (e) {
      console.warn(`[validate] download diretto fallito: ${e.message}`);
    }

    // Forza reload tool se csv_validate non è ancora in mappa
    if (!toolsRouteMap["csv_validate"]) {
      toolsCache = null;
      toolsRouteMap = {};
      await getTools();
    }
    console.log(`[validate] routeMap keys: ${Object.keys(toolsRouteMap).join(", ")}`);
    const result = csv_text
      ? await callTool("csv_validate", { csv_text, summary_only: false })
      : await callTool("csv_validate", { csv_url: url, summary_only: false });
    const cleanTitle = reqTitle || url.split("/").pop().split("?")[0] || url;
    emitEvent("validate", {
      dataset_id: url,
      dataset_title: cleanTitle.slice(0, 200),
      validation_ok: !result.includes("ERROR") && !result.includes("INVALID"),
      errors_count: (result.match(/error/gi) || []).length,
      latency_ms: Date.now() - t0val,
    }, req);
    res.json({ report: result });
  } catch (e) {
    console.error("[validate] errore:", e.message);
    emitEvent("error", { error_type: "validate_error", error_message: e.message.slice(0, 300), endpoint: "/api/validate" }, req);
    res.status(500).json({ error: e.message });
  }
});

// ─── Endpoint CSV → RDF/TTL ──────────────────────────────────────────────────
const RDF_MCP_URL = process.env.MCP_URL_RDF || "http://rdf-mcp:3003";

// Mappa dei file CSV temporanei serviti localmente per rdf-mcp
const tempCsvFiles = new Map();

// Endpoint che serve i CSV temporanei a rdf-mcp
app.get("/tmp-csv/:id", (req, res) => {
  const csv = tempCsvFiles.get(req.params.id);
  if (!csv) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(csv);
});

app.post("/api/enrich", strictLimiter, async (req, res) => {
  const { url, csv_text, ipa, pa, fmt, filename } = req.body;
  if (!url && !csv_text) return res.status(400).json({ error: "url o csv_text richiesto" });
  if (url && isPrivateOrDangerous(url)) return res.status(400).json({ error: "URL non consentito." });
  if (url && url.length > 2048) return res.status(400).json({ error: "URL troppo lungo." });
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      if (!(await isResolvedIpSafe(hostname))) return res.status(400).json({ error: "URL non consentito (IP risolto non sicuro)." });
    } catch { return res.status(400).json({ error: "URL non valido." }); }
  }
  if (csv_text && csv_text.length > 10000000) return res.status(400).json({ error: "File CSV troppo grande (max 10MB)." });
  if (ipa && !/^[a-z0-9_]{1,20}$/i.test(ipa)) return res.status(400).json({ error: "Codice IPA non valido." });
  console.log(`[enrich] url=${url || "upload"} ipa=${ipa} pa=${pa}`);
  try {
    let csvUrl = url;
    let tempId = null;
    if (csv_text) {
      // Salva CSV come file temporaneo accessibile a rdf-mcp via URL interno
      tempId = `csv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      tempCsvFiles.set(tempId, csv_text);
      // rdf-mcp chiama il backend per scaricare il CSV
      csvUrl = `http://backend:3001/tmp-csv/${tempId}`;
      setTimeout(() => tempCsvFiles.delete(tempId), 120000); // cleanup dopo 2 min
    }
    const params = new URLSearchParams({ url: csvUrl, ipa: ipa || "ente", pa: pa || "Ente Pubblico", fmt: fmt || "ttl" });
    const t0enrich = Date.now();
    const rdfRes = await fetch(`${RDF_MCP_URL}/?${params}`, { signal: AbortSignal.timeout(60000) });
    const text = await rdfRes.text();
    if (!rdfRes.ok) return res.status(rdfRes.status).json({ error: text });
    // dataset_id: usa URL se disponibile, altrimenti nome PA, altrimenti ipa
    // Titolo leggibile: se il nome file è generico (exp.aspx, export.csv, data.csv...)
    // lo arricchiamo con il dominio per dare contesto (es. "statweb.provincia.tn.it — exp.aspx")
    const GENERIC_NAMES = new Set(["exp.aspx","export.aspx","export.csv","data.csv","download.csv",
      "file.csv","output.csv","result.csv","query.csv","index.csv","default.csv","report.csv"]);
    const fileFromUrl = url ? url.split("/").pop().split("?")[0] : null;
    const domain = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } })() : null;
    const fileIsGeneric = fileFromUrl && GENERIC_NAMES.has(fileFromUrl.toLowerCase());
    const fileLabel = fileFromUrl
      ? (fileIsGeneric && domain ? `${domain} — ${fileFromUrl}` : fileFromUrl)
      : null;
    const rawTitle = (filename || fileLabel || pa || ipa || "upload").slice(0, 200);
    // Normalizza maiuscola iniziale per evitare duplicati (es. "comune di mesagne" vs "Comune di Mesagne")
    const enrichTitle = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
    const enrichId    = url ? url.split("?")[0].slice(0, 200) : enrichTitle;
    emitEvent("ttl_create", {
      dataset_id: enrichId,
      dataset_title: enrichTitle,
      pa: (pa || "").trim().replace(/^./, c => c.toUpperCase()) || null,  // nome ente, maiuscola iniziale
      format: fmt || "ttl",
      triples_count: (text.match(/\.\s*$/gm) || []).length,
      latency_ms: Date.now() - t0enrich,
    }, req);
    res.setHeader("Content-Type", rdfRes.headers.get("Content-Type") || "text/turtle");
    res.send(text);
  } catch (e) {
    console.error("[enrich] errore:", e.message);
    emitEvent("error", { error_type: "enrich_error", error_message: e.message.slice(0, 300), endpoint: "/api/enrich" }, req);
    res.status(500).json({ error: e.message });
  }
});

// Validazione da testo CSV grezzo (upload file dal browser)
app.post("/api/validate-text", strictLimiter, async (req, res) => {
  const { csv_text, filename } = req.body;
  if (!csv_text) return res.status(400).json({ error: "csv_text required" });
  if (csv_text.length > 10000000) return res.status(400).json({ error: "File CSV troppo grande (max 10MB)." });
  console.log(`[validate-text] ${filename || "upload"} (${csv_text.length} chars)`);
  const t0vt = Date.now();
  try {
    if (!toolsRouteMap["csv_validate"]) { toolsCache = null; toolsRouteMap = {}; await getTools(); }
    const result = await callTool("csv_validate", { csv_text, summary_only: false });
    const cleanFilename = (filename || "upload").split("?")[0].slice(0, 200);
    emitEvent("validate", {
      dataset_id: cleanFilename || "upload",
      dataset_title: cleanFilename || "upload",
      validation_ok: !result.includes("ERROR") && !result.includes("INVALID"),
      errors_count: (result.match(/error/gi) || []).length,
      latency_ms: Date.now() - t0vt,
    }, req);
    res.json({ report: result });
  } catch (e) {
    console.error("[validate-text] errore:", e.message);
    emitEvent("error", { error_type: "validate_error", error_message: e.message.slice(0, 300), endpoint: "/api/validate-text" }, req);
    res.status(500).json({ error: e.message });
  }
});

// ─── SPARQL proxy — il browser non può fare POST su lod.dati.gov.it
// Il backend fa la chiamata GET e restituisce il JSON pulito
app.post("/api/sparql", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });
  try {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
    const r = await fetch(url, {
      headers: {
        "Accept": "application/sparql-results+json, application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
        "Referer": "https://lod.dati.gov.it/",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      console.error(`[sparql-proxy] ${r.status} per query: ${query.slice(0, 100)}`);
      throw new Error(`SPARQL ${r.status}`);
    }
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error("[sparql-proxy] errore:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/api/models", (req, res) => {
  if (LLM_PROVIDER === "mistral") {
    res.json([{ name: "mistral-medium-latest" }]);
  } else {
    fetch(`${OLLAMA_URL}/api/tags`)
      .then(r => r.json())
      .then(data => res.json(data.models ?? []))
      .catch(() => res.json([]));
  }
});

app.get("/api/tools", async (req, res) => {
  try {
    toolsCache = null;
    toolsRouteMap = {};
    res.json(await getTools());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const BLOCKLIST = ["ignore previous", "system prompt", "forget instructions",
                   "new instructions", "disregard", "jailbreak"];

app.post("/api/chat", async (req, res) => {
  const { messages, model } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const lastMsg = messages[messages.length - 1]?.content ?? "";
  if (typeof lastMsg !== "string" || lastMsg.length > 2000) {
    return res.status(400).json({ error: "Messaggio non valido o troppo lungo" });
  }
  if (BLOCKLIST.some(p => lastMsg.toLowerCase().includes(p))) {
    return res.status(400).json({ error: "Input non consentito" });
  }
  if (LLM_PROVIDER === "mistral" && !MISTRAL_API_KEY) {
    return res.status(500).json({ error: "MISTRAL_API_KEY non impostata nel .env" });
  }

  const onTopic = await isQuestionOnTopic(lastMsg);
  if (!onTopic) {
    console.log(`[guardrail] domanda fuori tema bloccata: "${lastMsg.slice(0, 80)}"`);
    emitEvent("off_topic", { query_preview: lastMsg.slice(0, 100), guardrail_layer: "classifier" }, req);
    return res.json({ reply: OFF_TOPIC_REPLY, toolCalls: [] });
  }

  const t0chat = Date.now();
  try {
    const { reply, toolCalls } = await chatWithTools(messages, model);
    emitEvent("search", {
      query: lastMsg.slice(0, 500),
      datasets_found: toolCalls?.length || 0,
      latency_ms: Date.now() - t0chat,
    }, req);
    res.json({ reply, toolCalls });
  } catch (e) {
    console.error(e);
    emitEvent("error", { error_type: "chat_error", error_message: e.message.slice(0, 300), endpoint: "/api/chat" }, req);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", rateLimit({ windowMs: 60000, max: 10, message: { error: "Too many requests" } }), async (req, res) => {
  const status = { backend: "ok", ollama: "n/a", validatore: "unknown", rdf: "unknown" };
  if (LLM_PROVIDER === "ollama") {
    try {
      await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      status.ollama = "ok";
    } catch { status.ollama = "error"; }
  }
  try {
    const r = await fetch("http://validatore-mcp:3002/health", { signal: AbortSignal.timeout(3000) });
    status.validatore = r.ok ? "ok" : "error";
  } catch { status.validatore = "error"; }
  try {
    const r = await fetch("http://rdf-mcp:3003/health", { signal: AbortSignal.timeout(3000) });
    status.rdf = r.ok ? "ok" : "error";
  } catch { status.rdf = "error"; }
  res.json(status);
});

const PORT = process.env.PORT || 3001;
// ─── Controllo Content-Type prima della validazione ──────────────────────────
async function checkCsvContentType(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const cd = (r.headers.get("content-disposition") || "").toLowerCase();
    // Tipi chiaramente non CSV
    const nonCsv = [
      "text/html", "application/xhtml", "application/zip",
      "application/x-zip", "application/octet-stream",
      "application/json", "application/xml", "application/pdf",
      "image/", "video/", "audio/"
    ];
    // Se il content-type indica HTML o pagina web
    if (nonCsv.some(t => ct.includes(t))) {
      // Eccezione: se content-disposition dice che è un CSV
      if (cd.includes(".csv")) return { ok: true };
      return { ok: false, contentType: ct };
    }
    // Tipi CSV espliciti
    if (ct.includes("text/csv") || ct.includes("text/plain") || ct.includes("application/csv")) {
      return { ok: true };
    }
    // Google Sheets e altri exporters
    if (url.includes("docs.google.com") || url.includes("output=csv") || url.includes("format=csv")) {
      return { ok: true };
    }
    // Per altri tipi (es. application/octet-stream generico) lascia passare con warning
    return { ok: true, warning: ct || "content-type non dichiarato" };
  } catch (e) {
    // Se HEAD fallisce (alcuni server non lo supportano), lascia passare
    return { ok: true, warning: "HEAD request fallita: " + e.message };
  }
}

// ── Admin: gestione blocklist ─────────────────────────────────────────────────
const adminLimiter = rateLimit({ windowMs: 60000, max: 30, message: { error: "Too many requests" } });

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme-admin";

function requireAdminToken(req, res, next) {
  const auth = req.headers["authorization"] || "";
  if (auth === `Bearer ${ADMIN_TOKEN}`) return next();
  res.status(401).json({ error: "Non autorizzato" });
}

app.get("/api/admin/blocklist", adminLimiter, (req, res) => {
  res.json({ blocklist: dynamicBlocklist });
});

app.post("/api/admin/blocklist", adminLimiter, requireAdminToken, express.json(), (req, res) => {
  const { word } = req.body;
  if (!word || typeof word !== "string") return res.status(400).json({ error: "word richiesta" });
  const w = word.toLowerCase().trim();
  if (w.length < 2 || w.length > 50) return res.status(400).json({ error: "Parola non valida (2-50 chars)" });
  if (dynamicBlocklist.includes(w)) return res.status(409).json({ error: "Parola già presente" });
  dynamicBlocklist.push(w);
  saveBlocklist(dynamicBlocklist);
  res.json({ ok: true, blocklist: dynamicBlocklist });
});

app.delete("/api/admin/blocklist/:word", adminLimiter, requireAdminToken, (req, res) => {
  const w = decodeURIComponent(req.params.word).toLowerCase().trim();
  dynamicBlocklist = dynamicBlocklist.filter(p => p !== w);
  saveBlocklist(dynamicBlocklist);
  res.json({ ok: true, blocklist: dynamicBlocklist });
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Backend pronto su http://localhost:${PORT}`);
  console.log(`Raggiungibile su http://${process.env.SERVER_IP || "0.0.0.0"}:${PORT}`);
  // Pre-carica i tool all'avvio così toolsRouteMap è subito popolato
  try {
    await getTools();
    console.log(`[init] tool caricati: ${Object.keys(toolsRouteMap).join(", ")}`);
  } catch (e) {
    console.warn("[init] impossibile precaricare tool:", e.message);
  }
});
