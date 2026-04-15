import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";

const app = express();

app.set("trust proxy", 1);

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(s => s.trim())
    : true,
  methods: ["GET", "POST"],
}));

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Content-Security-Policy", "default-src 'self'");
  next();
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
  if (toolsCache) return toolsCache;
  const allTools = [];
  toolsRouteMap = {};
  for (const url of MCP_URLS) {
    try {
      const res = await mcpCallTo(url, "tools/list");
      const tools = res.result?.tools ?? [];
      for (const t of tools) {
        toolsRouteMap[t.name] = url;
        allTools.push(t);
      }
      console.log(`[tools] ${url} → ${tools.length} tool`);
    } catch (e) {
      console.warn(`[tools] ${url} non raggiungibile: ${e.message}`);
    }
  }
  toolsCache = allTools;
  return toolsCache;
}

function getToolsForProvider(allTools) {
  if (LLM_PROVIDER !== "ollama") return allTools;
  const filtered = allTools.filter(t => OLLAMA_TOOL_WHITELIST.has(t.name));
  console.log(`[tools] Ollama riceve ${filtered.length}/${allTools.length} tool (whitelist)`);
  return filtered;
}

async function callTool(name, args) {
  const url = toolsRouteMap[name] || MCP_URLS[0];
  const res = await mcpCallTo(url, "tools/call", { name, arguments: args });
  const content = res.result?.content ?? [];
  return content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
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
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || OLLAMA_MODEL,
      messages: history,
      tools,
      stream: false,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama error ${res.status}: ${err}`);
  }
  return await res.json();
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
  const allTools = await getTools();
  const tools = getToolsForProvider(allTools);
  const toolCallsLog = [];

  const isOllama = LLM_PROVIDER === "ollama";
  const systemPrompt = isOllama ? SYSTEM_PROMPT_OLLAMA : SYSTEM_PROMPT;

  let historyMessages;
  if (isOllama && messages.length > 0) {
    const allButLast = messages.slice(0, -1).map(m => ({ role: m.role, content: m.content }));
    const lastMsg = messages[messages.length - 1];
    historyMessages = [...allButLast, buildNudgeMessage(lastMsg.content)];
  } else {
    historyMessages = messages.map(m => ({ role: m.role, content: m.content }));
  }

  const history = [
    { role: "system", content: systemPrompt },
    ...historyMessages,
  ];

  for (let round = 0; round < 6; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, 1200));

    let msg, finishReason;

    if (LLM_PROVIDER === "mistral") {
      const data = await mistralChat(history, tools.map(mcpToolToMistral), model);
      msg = data.choices[0].message;
      finishReason = data.choices[0].finish_reason;
    } else {
      const data = await ollamaChat(history, tools.map(mcpToolToOllama), model);
      msg = data.message;
      console.log(`[ollama-raw] tool_calls=${JSON.stringify(msg.tool_calls?.length)} content="${String(msg.content).slice(0,80)}" done_reason="${data.done_reason}"`);
      finishReason = msg.tool_calls?.length ? "tool_calls" : "stop";
    }

    if (isOllama && round === 0 && finishReason === "stop" && toolCallsLog.length === 0) {
      console.log(`[ollama-nudge] round ${round}: nessun tool chiamato, inietto retry message`);
      history.push(msg);
      history.push(RETRY_MESSAGE);
      continue;
    }

    history.push(msg);

    if (finishReason === "stop" || finishReason === "end_turn" || !msg.tool_calls?.length) {
      const rawReply = typeof msg.content === "string"
        ? msg.content
        : msg.content?.filter(b => b.type === "text").map(b => b.text).join("\n") ?? "";
      const reply = isOllama ? stripThinkTags(rawReply) : rawReply;
      if (isOllama && toolCallsLog.length === 0) {
        console.warn(`[ollama-nudge] risposta finale senza tool call dopo ${round + 1} round`);
      }
      return { reply, toolCalls: toolCallsLog };
    }

    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      const fnArgs = typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;

      console.log(`[tool] ${fnName}`, JSON.stringify(fnArgs).slice(0, 120));
      toolCallsLog.push({ tool: fnName, args: fnArgs });

      let result;
      try {
        result = await callTool(fnName, fnArgs);
      } catch (e) {
        result = `Errore: ${e.message}`;
      }

      if (LLM_PROVIDER === "mistral") {
        history.push({ role: "tool", tool_call_id: tc.id, name: fnName, content: result });
      } else {
        history.push({ role: "tool", content: result });
      }
    }
  }

  return { reply: "Nessuna risposta ottenuta.", toolCalls: toolCallsLog };
}

// ─── Risposta di rifiuto fuori tema ──────────────────────────────────────────

const OFF_TOPIC_REPLY = `Mi dispiace, posso aiutarti solo con domande relative a **open data**, **dataset** e **portali CKAN**.

Prova a chiedermi, ad esempio:
- 🔍 "Cerca dataset sulla qualità dell'aria"
- 📊 "Quanti dataset ci sono su mobilità a Roma?"
- ✅ "Valida questo CSV: <url>"
- 🌐 "Mostrami i dati aperti del comune di Milano"`;

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
    return res.json({ reply: OFF_TOPIC_REPLY, toolCalls: [] });
  }

  try {
    const { reply, toolCalls } = await chatWithTools(messages, model);
    res.json({ reply, toolCalls });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", async (req, res) => {
  const status = { backend: "ok", ollama: "n/a", mcp: "unknown", mcp_servers: MCP_URLS };
  if (LLM_PROVIDER === "ollama") {
    try {
      await fetch(`${OLLAMA_URL}/api/tags`);
      status.ollama = "ok";
    } catch {
      status.ollama = "error";
    }
  }
  try {
    await mcpCall("tools/list");
    status.mcp = "ok";
  } catch {}
  res.json(status);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend pronto su http://localhost:${PORT}`);
  console.log(`Raggiungibile su http://${process.env.SERVER_IP || "0.0.0.0"}:${PORT}`);
});
