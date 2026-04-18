import { useState, useRef, useEffect } from "react";
import StatusBar from "./components/StatusBar";
import DatasetCard from "./components/DatasetCard";
import ValidateReport from "./components/ValidateReport";
import Icon from "./components/Icon";
import AdvancedSearch from "./components/AdvancedSearch";
import AnalyticsDashboard from "./components/AnalyticsDashboard";
import AdminPanel from "./components/AdminPanel";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";

// ── Session ID — generato una volta per sessione browser ──────────────────────
if (!sessionStorage.getItem("ckan_sid")) {
  sessionStorage.setItem("ckan_sid", crypto.randomUUID());
}
const SESSION_ID = sessionStorage.getItem("ckan_sid");

// Header comuni a tutte le richieste verso il backend
function apiHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-session-id": SESSION_ID, ...extra };
}

// Invia evento analytics fire-and-forget dal frontend
// Usato per eventi che non passano per il backend (es. ricerca SPARQL diretta)
function emitAnalytics(type, payload = {}) {
  fetch("/analytics-api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      session_id: SESSION_ID,
      ts: new Date().toISOString(),
      ...payload,
    }),
  }).catch(() => {});
}

const SUGGESTIONS = [
  { text: "Cerca dataset sulla qualità dell'aria", icon: "" },
  { text: "Trova dati sui rifiuti urbani",          icon: "" },
  { text: "Dataset sulla mobilità e trasporti",     icon: "" },
  { text: "Dati sull'energia rinnovabile",           icon: "" },
  { text: "Valida CSV da URL",                       icon: "✅", action: "validate_prompt" },
];

const BLOCKLIST = [
  // Prompt injection
  "ignore previous","system prompt","forget instructions","jailbreak","prompt injection",
  "ignore instructions","disregard","bypass",
  // Contenuti esplicitamente illeciti/pornografici
  "porn","porno","pornograph","xxx","nude","naked","escort","prostitut",
  "pedofil","pedophil","child abuse","snuff","gore",
  "cumshot","blowjob","handjob","gangbang","creampie","onlyfans","milf","dildo","vibrat",
  "cocain","eroina","metanfetamin","drug deal","narcotic"
];

const SPARQL_EP = import.meta.env.VITE_SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";

export default function App() {
  // Route semplice: /analytics mostra la dashboard, tutto il resto il chatbot
  if (window.location.pathname.endsWith("/analytics") || window.location.pathname.endsWith("/analytics/")) {
    return <AnalyticsDashboard />;
  }
  if (window.location.pathname.includes("/admin") || new URLSearchParams(window.location.search).get("page") === "admin") {
    return <AdminPanel />;
  }

  const [messages,    setMessages]    = useState([]);
  const [pageTitle,   setPageTitle]   = useState("Esplora i Dati Aperti Italiani");
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [health,      setHealth]      = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [csvUrl,      setCsvUrl]      = useState("");
  const [csvTab,      setCsvTab]      = useState("url"); // "url" | "upload"
  const [csvFile,     setCsvFile]     = useState(null);
  const [showTtlBox,  setShowTtlBox]  = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(() => !localStorage.getItem("privacy_ok"));
  const [showHelp,    setShowHelp]    = useState(false);
  const [blocklist,   setBlocklist]   = useState(BLOCKLIST);

  // Carica blocklist dinamica dal backend all'avvio
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/admin/blocklist`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.blocklist?.length) setBlocklist(data.blocklist); })
      .catch(() => {}); // fallback alla BLOCKLIST hardcodata
  }, []);
  const [wizardDove,  setWizardDove]  = useState("");
  const [doveAcList,  setDoveAcList]  = useState([]);
  const [showDoveAc,  setShowDoveAc]  = useState(false);
  const doveAcTimer = useRef(null);
  const doveRef     = useRef(null);
  const [ttlUrl,      setTtlUrl]      = useState("");
  const [ttlFile,     setTtlFile]     = useState(null);
  const [ttlTab,      setTtlTab]      = useState("url");
  const [ttlIpa,      setTtlIpa]      = useState("");
  const [ttlPa,       setTtlPa]       = useState("");
  const [ttlFmt,      setTtlFmt]      = useState("ttl");
  const [ttlCsvText,  setTtlCsvText]  = useState(null);
  const [showCsvBox,  setShowCsvBox]  = useState(false);

  const bottomRef   = useRef(null);
  const csvFileRef   = useRef(null);
  const ttlFileRef   = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => { fetchHealth(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const h = (e) => { if (!e.target.closest(".sidebar")) setSidebarOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [sidebarOpen]);

  async function fetchHealth() {
    try {
      const r = await fetch(`${BACKEND_URL}/api/health`);
      setHealth(await r.json());
    } catch { setHealth({ backend: "error", ollama: "error", mcp: "error" }); }
  }

  // ── Classifica intenzione (Ollama, 1 token) ──────────────────────────────
  async function classifyIntent(text) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/intent`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok) return { intent: "SEARCH", aiUsed: false };
      const data = await r.json();
      return { intent: data.intent ?? "SEARCH", aiUsed: data.ai_used ?? false };
    } catch { return { intent: "SEARCH", aiUsed: false }; }
  }

  // ── Ricerca SPARQL — chiamata diretta dal browser (come l'assistente CKAN) ──
  async function doSearch(query, offset = 0, dove = "") {
    const FETCH_SIZE = 32; // come l'assistente: fetch più righe per deduplicare
    const PAGE_SIZE  = 8;
    const STOPWORDS = new Set(["il","lo","la","i","gli","le","un","una","uno",
      "di","a","da","in","con","su","per","tra","fra","e","o","ma","non","che",
      "del","dei","delle","della","degli","al","ai","alle","alla","nel","nei",
      "sul","sui","sulla","sulle",
      // Verbi colloquiali di richiesta — non sono keyword di dataset
      "fammi","mostra","mostrami","dimmi","elenca","cerca","trova","voglio",
      "vorrei","puoi","potrei","vedere","dammi","serve","servono","trovare",
      "come","cosa","dove","quando","sono","tutti","tutte","questo","questa",
      // Altre parole comuni non utili come keyword di dataset
      "dati","dato","file","open","data","anche","però","oppure","pure",
      "miei","tuoi","suoi","nostri","vostri","loro","controllare","verificare",
      "analizzare","scaricare","aprire","leggere","usare","utilizzare"]);

    const allWords = query.split(/\s+/).filter(w => w.length >= 2);
    const sigWords = allWords.filter(w => !STOPWORDS.has(w.toLowerCase()));
    const useWords = sigWords.length > 0 ? sigWords : allWords;

    // kwFilter: AND con ricerca in titolo, descrizione E keyword (come l'assistente)
    function kwFilter(words, useOr = false) {
      const parts = words.map((w, i) => {
        const wl = w.toLowerCase().replace(/"/g, "");
        return `(CONTAINS(LCASE(?title),"${wl}")||CONTAINS(LCASE(STR(?description)),"${wl}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?kw${i} . FILTER(CONTAINS(LCASE(STR(?kw${i})),"${wl}")) })`;
      });
      return parts.join(useOr ? " || " : " && ");
    }

    async function runQuery(words, useOr, off) {
      const doveFilter = dove
        ? `  ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName .
  FILTER(CONTAINS(LCASE(STR(?rhName)),"${dove.toLowerCase().replace(/"/g,'')}"))
`
        : `  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }
`;
      const sparqlQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?d ?title ?description ?modified ?rhName ?landingPage WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
${doveFilter}  FILTER(${kwFilter(words, useOr)})
} ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${off}`;
      // Prima prova diretta dal browser (lod.dati.gov.it supporta CORS per GET)
      try {
        const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(sparqlQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (rd.ok) return (await rd.json()).results?.bindings ?? [];
      } catch {}
      // Fallback: proxy backend
      const r = await fetch(`${BACKEND_URL}/api/sparql`, {
        method: "POST", headers: apiHeaders(),
        body: JSON.stringify({ query: sparqlQ }),
      });
      if (!r.ok) throw new Error(`SPARQL error ${r.status}`);
      return (await r.json()).results?.bindings ?? [];
    }

    // Prima prova AND, se non trova nulla riprova con OR (come l'assistente)
    let bindings = await runQuery(useWords, false, offset);
    if (bindings.length === 0 && useWords.length > 1) {
      bindings = await runQuery(useWords, true, offset);
    }

    // Deduplicazione e costruzione risultati
    // Il rightsHolder (titolare dati) viene da dct:rightsHolder
    const seen = new Map();
    for (const b of bindings) {
      const uri = b.d?.value ?? "";
      if (!uri || seen.has(uri)) continue;
      const id = uri.split("/").pop();
      const landingPage = b.landingPage?.value;
      const viewUrl = landingPage || `https://www.dati.gov.it/view-dataset/dataset?id=${id}`;
      seen.set(uri, {
        uri, id,
        title:       b.title?.value ?? "",
        description: b.description?.value ?? "",
        modified:    b.modified?.value?.slice(0,10) ?? "",
        publisher:   b.rhName?.value || (dove || ""),
        ipaCode:     "",
        viewUrl,
        csvResources: [],
      });
    }
    let datasets = [...seen.values()].slice(0, PAGE_SIZE);

    return { datasets, query, offset };
  }

  // ── Validazione CSV ───────────────────────────────────────────────────────
  async function doValidate(url, datasetTitle = "") {
    const title = datasetTitle || url.split("/").pop().split("?")[0] || url;
    // 1. Prima prova dal browser (segue redirect, nessun CORS problem su CSV diretti)
    try {
      const csvRes = await fetch(url);
      if (csvRes.ok) {
        // Controlla Content-Type della risposta reale (dopo redirect)
        const ct = (csvRes.headers.get("content-type") || "").toLowerCase();
        const isHtmlCt = ct.includes("text/html") || ct.includes("application/xhtml");
        const isZipCt = ct.includes("application/zip") || ct.includes("application/x-zip")
          || ct.includes("application/x-zip-compressed") || ct.includes("application/octet-stream")
          || url.toLowerCase().endsWith(".zip");
        const isPdfCt = ct.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");
        const isExcelCt = ct.includes("spreadsheetml") || ct.includes("ms-excel")
          || url.toLowerCase().endsWith(".xlsx") || url.toLowerCase().endsWith(".xls");

        if (isHtmlCt || isZipCt || isPdfCt || isExcelCt) {
          throw new Error(
            `La risorsa non è un file CSV — Content-Type rilevato: "${ct || "non dichiarato"}". ` +
            (isHtmlCt ? "L'URL punta a una pagina web, non al file diretto. Cerca il link diretto al CSV nel portale open data." : "") +
            (isZipCt && !isHtmlCt ? "La risorsa è un archivio ZIP. Scaricalo, estrailo e valida il CSV all'interno." : "") +
            (isPdfCt ? "La risorsa è un PDF, non un CSV." : "") +
            (isExcelCt ? "La risorsa è un file Excel. Esportalo come CSV prima di validarlo." : "")
          );
        }

        const csv_text = await csvRes.text();
        const isHtml = csv_text.trimStart().startsWith("<");

        // Doppio controllo sul contenuto — anche se il Content-Type non è dichiarato
        if (isHtml) {
          throw new Error(
            "L'URL restituisce una pagina HTML, non un file CSV. " +
            "Probabilmente è il link alla scheda del dataset, non al file diretto. " +
            "Cerca il link diretto al CSV nel portale open data."
          );
        }

        const firstLine = csv_text.trim().split("\n")[0] || "";
        const hasSep = firstLine.includes(",") || firstLine.includes(";") || firstLine.includes("\t");
        if (hasSep) {
          const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
            method: "POST",
            headers: apiHeaders(),
            body: JSON.stringify({ csv_text, filename: title }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()).report ?? "";
        }
      }
    } catch(e) {
      // Se l'errore è nostro (HTML/ZIP/PDF rilevato), rilancia direttamente
      if (e.message.includes("Content-Type") || e.message.includes("pagina HTML") || e.message.includes("pagina web") || e.message.includes("ZIP") || e.message.includes("PDF")) {
        throw e;
      }
      console.warn("[doValidate] browser fetch fallito:", e.message);
    }
    // 2. CORS bloccato o browser fetch fallito — passa al backend con controllo Content-Type
    const r = await fetch(`${BACKEND_URL}/api/validate`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ url, dataset_title: title }),
    });
    if (r.status === 422) {
      const data = await r.json();
      throw new Error(data.error || "Formato non CSV");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).report ?? "";
  }

  // ── Callback per risultati ricerca avanzata ─────────────────────────────
  function handleAdvLoading(isLoading, label) {
    if (isLoading && label) {
      setMessages([]);  // nuova ricerca — pulisce la chat
    }
  }

  function handleAdvResults(datasets, label) {
    emitAnalytics("search", {
      query: label.slice(0, 500),
      datasets_found: datasets.length,
    });
    // Rimuovi messaggio "in corso" se presente
    setMessages(prev => prev.filter(m => m.type !== "searching"));
    if (!datasets.length) {
      addMsg("assistant", `Nessun dataset trovato per **"${label}"**.`);
      return;
    }
    addMsg("assistant", `Trovati risultati per **"${label}"**:`, {
      type: "search_results", datasets, query: label, offset: 0,
    });
  }

  // ── Aggiunge un messaggio alla chat ───────────────────────────────────────
  function addMsg(role, content, extra = {}) {
    setMessages(prev => [...prev, { role, content, ...extra }]);
  }

  function replaceLastMsg(role, content, extra = {}) {
    setMessages(prev => {
      const msgs = [...prev];
      // Trova e sostituisce l'ultimo messaggio loading_ttl
      const idx = msgs.map(m => m.type).lastIndexOf("loading_ttl");
      if (idx !== -1) msgs[idx] = { role, content, ...extra };
      else msgs.push({ role, content, ...extra });
      return msgs;
    });
  }

  // ── Handler principale ────────────────────────────────────────────────────
  function resetChat() {
    setMessages([]);
    setInput("");
    setWizardDove("");
    setShowCsvBox(false);
    setShowTtlBox(false);
    setTtlCsvText(null);
    setCsvFile(null);
    setTtlFile(null);
  }

  // Autocomplete DOVE — rightsHolder live SPARQL
  async function handleDoveInput(v) {
    setWizardDove(v);
    clearTimeout(doveAcTimer.current);
    if (v.length < 2) { setShowDoveAc(false); return; }
    doveAcTimer.current = setTimeout(async () => {
      try {
        const ql = v.toLowerCase().replace(/"/g, "");
        const q = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name (COUNT(DISTINCT ?d) AS ?count) WHERE {
  ?d a dcat:Dataset .
  ?d dct:rightsHolder ?rh .
  ?rh foaf:name ?name .
  FILTER(CONTAINS(LCASE(STR(?name)),"${ql}"))
} GROUP BY ?name ORDER BY DESC(?count) LIMIT 10`;
        // Prova diretta dal browser, fallback al proxy
        let data;
        try {
          const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`;
          const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
          if (rd.ok) data = await rd.json();
        } catch {}
        if (!data) {
          const r = await fetch(`${BACKEND_URL}/api/sparql`, {
            method: "POST", headers: apiHeaders(),
            body: JSON.stringify({ query: q }),
          });
          if (!r.ok) return;
          data = await r.json();
        }
        const seen = new Set();
        const results = [];
        for (const b of data.results?.bindings ?? []) {
          const name = b.name?.value?.trim();
          if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            results.push({ name, count: parseInt(b.count?.value || "0") });
          }
        }
        setDoveAcList(results);
        setShowDoveAc(results.length > 0);
      } catch {}
    }, 350);
  }

  // Recupera codice IPA preciso del rightsHolder tramite query dedicata
  async function fetchIpaCode(datasetUri) {
    try {
      const q = `PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX dcat: <http://www.w3.org/ns/dcat#>
SELECT ?ipaCode WHERE {
  <${datasetUri}> dct:rightsHolder ?rh .
  ?rh dct:identifier ?ipaCode .
} LIMIT 1`;
      let data;
      try {
        const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (rd.ok) data = await rd.json();
      } catch {}
      if (!data) {
        const r = await fetch(`${BACKEND_URL}/api/sparql`, {
          method: "POST", headers: apiHeaders(),
          body: JSON.stringify({ query: q }),
        });
        if (!r.ok) return "";
        data = await r.json();
      }
      const val = data.results?.bindings?.[0]?.ipaCode?.value || "";
      // Se è una partita IVA (11 cifre numeriche) = errore nei metadati, scarta
      return /^\d{11}$/.test(val) ? "" : val;
    } catch { return ""; }
  }

  async function sendMessage(text) {
    setMessages([]);  // nuova ricerca — pulisce la chat
    if (!text.trim() || loading) return;
    if (blocklist.some(p => text.toLowerCase().includes(p.toLowerCase()))) {
      emitAnalytics("blocked", { query: text.slice(0, 200) });
      addMsg("assistant", "Richiesta non consentita. SIMBA risponde esclusivamente a domande sugli open data della Pubblica Amministrazione italiana.");
      return;
    }
    if (text.length > 2000) { alert("Messaggio troppo lungo."); return; }

    setSidebarOpen(false);
    setShowCsvBox(false);
    addMsg("user", text);
    setInput("");
    setLoading(true);

    try {
      const { intent, aiUsed } = await classifyIntent(text);
      if (aiUsed) addMsg("assistant", "🤖 *Classificazione AI attiva* — il motore AI ha interpretato la tua richiesta per indirizzarla correttamente.", { type: "ai_note" });

      if (intent === "SEARCH") setPageTitle("Ricerca Dataset — Open Data Italia");
      else if (intent === "VALIDATE") setPageTitle("Validazione CSV — Open Data Italia");
      else if (intent === "ENRICH") setPageTitle("Conversione RDF — SIMBA");

      if (intent === "OFF_TOPIC") {
        addMsg("assistant", `Mi dispiace, posso aiutarti solo con:\n- Ricerca dataset open data italiani\n- Validazione file CSV per la PA\n- Conversione CSV → RDF Linked Data\n\nProva con: *"Cerca defibrillatori nel Comune di Mesagne"*`);
        return;
      }

      if (intent === "VALIDATE") {
        const url = text.match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) {
          addMsg("assistant", "Per validare un CSV dimmi l'URL del file.\n\nOppure usa il box qui sotto per incollarlo:");
          setShowCsvBox(true);
          return;
        }
        addMsg("assistant", `Validazione in corso per:\n\`${url}\``, { type: "validating" });
        const report = await doValidate(url);
        addMsg("assistant", report, { type: "validate_report", url });
        return;
      }

      if (intent === "ENRICH") {
        setShowTtlBox(true);
        return;
      }

      // SEARCH — estrae la query e chiama SPARQL
      const query = text
        .replace(/^(cerca|trovami|mostrami|dammi|elenca|trova)\s+/i, "")
        .replace(/\b(dataset|open data)\b/gi, "")
        .replace(/\s+/g, " ").trim() || text;

      setPageTitle("Ricerca Dataset — Open Data Italia");


      const t0search = Date.now();
      const { datasets } = await doSearch(query);
      emitAnalytics("search", {
        query: query.slice(0, 500),
        where: null,
        datasets_found: datasets.length,
        latency_ms: Date.now() - t0search,
      });

      if (!datasets.length) {
        addMsg("assistant", `Nessun dataset trovato per **"${query}"**.\n\nProva con termini più generici.`);
        return;
      }

      addMsg("assistant", `Trovati risultati per **"${query}"** — clicca ▼ su un dataset per vedere le risorse CSV e validarle:`, {
        type: "search_results",
        datasets,
        query,
        offset: 0,
      });

    } catch (e) {
      addMsg("assistant", `❌ Errore: ${e.message}`);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  // ── Conversione CSV → RDF ────────────────────────────────────────────────────
  async function doEnrich(url, datasetTitle, ipa = "ente", fmt = "ttl") {
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${url}`);
    setPageTitle("Conversione RDF — SIMBA");
    addMsg("assistant", `Conversione in RDF/${fmt.toUpperCase()} di **"${datasetTitle}"** in corso…`, { type: "loading_ttl" });
    setLoading(true);
    try {
      // Passa sempre l'URL al backend — rdf-mcp lo scarica direttamente
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ url, pa: datasetTitle, ipa, fmt }),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`HTTP ${r.status}: ${err.slice(0,200)}`);
      }
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      const preview = lines.slice(0, 30).join("\n");
      const mimeType = fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle";
      const ext      = fmt === "rdfxml" ? "rdf" : "ttl";
      const blob = new Blob([ttl], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      replaceLastMsg("assistant", `Conversione completata: ${lines.length} triple generate.`, {
        type: "ttl_result", blobUrl, filename: `${ipa}-${Date.now()}.${ext}`, preview, fmt
      });
    } catch (e) {
      addMsg("assistant", `❌ Errore conversione: ${e.message}`);
    }
    setLoading(false);
  }

  // ── "Carica altri" ────────────────────────────────────────────────────────
  async function loadMore(query, currentOffset) {
    const newOffset = currentOffset + 8;
    setLoadingMore(true);
    try {
      const { datasets } = await doSearch(query, newOffset);
      if (!datasets.length) { addMsg("assistant", "Nessun altro risultato disponibile."); return; }
      addMsg("assistant", `Altri risultati per **"${query}"**:`, {
        type: "search_results", datasets, query, offset: newOffset,
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoadingMore(false); }
  }

  // ── Valida CSV da card ────────────────────────────────────────────────────
  async function validateFromCard(url, datasetTitle, publisher = "", datasetUri = "") {
    addMsg("user",      `Valida CSV: ${url}`);
    setPageTitle("Validazione CSV — Open Data Italia");
    addMsg("assistant", `Validazione CSV di **"${datasetTitle}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      // Scarica il CSV dal browser (evita 403 server-side su rdf-mcp)
      let csvText = null;
      try {
        const csvRes = await fetch(url);
        if (csvRes.ok) csvText = await csvRes.text();
      } catch { /* se non scaricabile, lascia null */ }
      const report = await doValidate(url, datasetTitle);
      const ipaCode = datasetUri ? await fetchIpaCode(datasetUri) : "";
      addMsg("assistant", report, { type: "validate_report", url, publisher, ipaCode, csvText, datasetTitle });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); }
  }

  // ── Valida CSV da box manuale ─────────────────────────────────────────────
  async function validateFromUpload() {
    if (!csvFile) return;
    setShowCsvBox(false);
    addMsg("user", `Valida CSV: ${csvFile.name}`);
    addMsg("assistant", `Validazione CSV di **"${csvFile.name}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      const text = await csvFile.text();
      const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text: text, filename: csvFile.name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      addMsg("assistant", data.report ?? "Errore nella validazione", { type: "validate_report", url: csvFile.name, csvText: text });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setCsvFile(null); }
  }

  async function doEnrichText(csv_text, filename, fmt = "ttl", paName = "") {
    // Conversione diretta da testo CSV (file già caricato) — niente box IPA/PA
    const title = paName || filename.replace(/\.csv$/i,"");
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${title}`);
    addMsg("assistant", `Conversione in RDF/${fmt.toUpperCase()} di **"${title}"** in corso…`);
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text, pa: title, ipa: "ente", fmt, filename: filename }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      const preview = lines.slice(0, 30).join("\n");
      const ext = fmt === "rdfxml" ? "rdf" : "ttl";
      const blob = new Blob([ttl], { type: fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle" });
      const blobUrl = URL.createObjectURL(blob);
      addMsg("assistant", `Conversione completata: ${lines.length} righe generate.`, {
        type: "ttl_result", blobUrl, filename: `${filename.replace(/\.csv$/i,"")}.${ext}`, preview, fmt
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    setLoading(false);
  }

  function openTtlBox(url, fmt = "ttl", csvText = null, pa = "", ipa = "") {
    setShowCsvBox(false);
    setTtlCsvText(csvText);
    setTtlUrl(url || ""); // conserva sempre l'URL originale per il nome file
    setTtlTab(csvText ? "upload" : "url");
    setTtlFmt(fmt);
    setTtlIpa(ipa);
    setTtlPa(pa);
    setShowTtlBox(true);
  }

  async function enrichFromBox() {
    if (!ttlUrl.trim()) return;
    if (!ttlIpa.trim()) { alert("Inserisci il Codice IPA dell'ente (es. c_b220)"); return; }
    if (!ttlPa.trim())  { alert("Inserisci il Nome della PA (es. Comune di Bari)"); return; }
    setShowTtlBox(false);
    const pa = ttlPa.trim();
    const ipa = ttlIpa.trim();
    await doEnrich(ttlUrl.trim(), pa, ipa, ttlFmt);
    setTtlUrl(""); setTtlIpa(""); setTtlPa(""); setTtlFmt("ttl");
  }

  async function enrichFromUpload() {
    const hasMemory = !!ttlCsvText;
    if (!ttlFile && !hasMemory) return;
    if (!ttlIpa.trim()) { alert("Inserisci il Codice IPA dell'ente (es. c_b220)"); return; }
    if (!ttlPa.trim())  { alert("Inserisci il Nome della PA (es. Comune di Bari)"); return; }
    setShowTtlBox(false);
    const pa = ttlPa.trim();
    const ipa = ttlIpa.trim();
    // Se non c'è file fisico ma c'è un URL (ttlUrl) o memoria da ValidateReport,
    // estrai il nome file dall'URL originale invece di usare il generico "CSV"
    // Estrai nome file dall'URL originale (anche quando il CSV è già in memoria)
    const fnameFromUrl = ttlUrl ? ttlUrl.split("/").pop().split("?")[0] : null;
    const fname = ttlFile?.name || fnameFromUrl || "CSV";
    const fmt = ttlFmt || "ttl";
    const ext = fmt === "rdfxml" ? "rdf" : "ttl";
    const mimeType = fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle";
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${fname}`);
    addMsg("assistant", `Conversione in RDF/${fmt === "rdfxml" ? "XML" : "Turtle"} di **"${pa}"** in corso…`);
    setLoading(true);
    try {
      const csv_text = hasMemory ? ttlCsvText : await ttlFile.text();
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text, pa, ipa, fmt, filename: fname }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      const preview = lines.slice(0, 30).join("\n");
      const blob = new Blob([ttl], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      replaceLastMsg("assistant", `✅ Conversione completata!`, { type: "ttl_result", blobUrl, filename: `${ipa}-${Date.now()}.${ext}`, preview, fmt });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setTtlFile(null); setTtlIpa(""); setTtlPa(""); setTtlCsvText(null); }
  }

  async function validateFromBox() {
    if (!csvUrl.trim()) return;
    setShowCsvBox(false);
    await validateFromCard(csvUrl.trim(), "CSV fornito");
    setCsvUrl("");
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  // ── Render messaggio ──────────────────────────────────────────────────────
  function renderMessage(m, i) {
    if (m.type === "search_results") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <p dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />
            <div className="dataset-list">
              {m.datasets.map((d, j) => (
                <DatasetCard key={j} dataset={d} onValidate={validateFromCard} onEnrich={doEnrich} />
              ))}
            </div>
            <button className="load-more-btn" onClick={() => loadMore(m.query, m.offset)} disabled={loadingMore}>
              {loadingMore
                ? <><i className="bi bi-arrow-repeat spin" /> Caricamento…</>
                : <><i className="bi bi-chevron-down" /> Carica altri risultati</>
              }
            </button>
          </div>
        </div>
      );
    }

    if (m.type === "loading_ttl") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble loading-ttl-bubble">
            <i className="bi bi-arrow-repeat spin" style={{fontSize:"18px",color:"#0066CC"}} />
            <span>{m.content}</span>
          </div>
        </div>
      );
    }

    if (m.type === "ttl_result") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <p>Conversione completata.</p>
            {m.preview && (
              <>
                <p className="ttl-preview-label">Anteprima (prime righe) — scarica il file per il contenuto completo:</p>
                <pre className="ttl-preview">{m.preview}{"\n…"}</pre>
              </>
            )}
            <div className="ttl-download-btns">
              <a href={m.blobUrl} download={m.filename} className="btn-small btn-download">
                ⬇ Scarica {m.fmt === "rdfxml" ? "RDF/XML" : "Turtle (.ttl)"}
              </a>
            </div>
          </div>
        </div>
      );
    }

    if (m.type === "validate_report") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <ValidateReport report={m.content} url={m.url} csvText={m.csvText} onEnrich={(url, fmt) => openTtlBox(url, fmt, m.csvText, m.publisher || "", m.ipaCode || "")} onEnrichText={(csv_text, filename, fmt) => doEnrichText(csv_text, filename, fmt, m.datasetTitle || m.publisher || "")} />
          </div>
        </div>
      );
    }

    return (
      <div key={i} className={`message ${m.role}`}>
        <div className="message-bubble">
          {m.content.split("\n").map((line, j) => (
            <p key={j} dangerouslySetInnerHTML={{ __html: mdToHtml(line) || "&nbsp;" }} />
          ))}
        </div>
      </div>
    );
  }

  function mdToHtml(text) {
    return (text || "")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,   "<em>$1</em>")
      .replace(/`(.+?)`/g,     "<code>$1</code>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  return (
    <div className="app">
      {showPrivacy && (
        <div className="privacy-banner">
          <span>
            Questo servizio raccoglie dati anonimi sull'utilizzo (query, sessione, IP parziale) per migliorare il servizio.
            Nessun dato personale identificabile viene conservato.
          </span>
          <button onClick={() => { localStorage.setItem("privacy_ok", "1"); setShowPrivacy(false); }}>
            Ho capito ✕
          </button>
        </div>
      )}
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-logo">
          <img src="/chatbot/logo-agid.png" alt="AgID" className="sidebar-agid-logo" />
          <div className="sidebar-agid-title">
            <span className="sidebar-agid-name">SIMBA</span>
            <span className="sidebar-agid-sub">Open Data · dati.gov.it</span>
          </div>
        </div>

        {/* Strumenti integrati — card colorate */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti integrati</div>
          <button className="tool-card tool-search" onClick={() => { resetChat(); setSidebarOpen(false); inputRef.current?.focus(); }} disabled={loading}>
            Cerca dataset
          </button>
          <button className="tool-card tool-validate" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }} disabled={loading}>
            Valida CSV
          </button>
          <button className="tool-card tool-ttl" onClick={() => { setSidebarOpen(false); setShowTtlBox(true); setShowCsvBox(false); }} disabled={loading}>
            Trasforma in RDF TTL/XML
          </button>
        </div>

        {/* Link strumenti — testo semplice */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti consigliati</div>
          <a className="sidebar-plain-link" href="https://github.com/ondata/ckan-mcp-server" target="_blank" rel="noopener noreferrer">
            CKAN MCP Server <span className="plain-tag">OnData</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/ondata/istat_mcp_server" target="_blank" rel="noopener noreferrer">
            ISTAT MCP Server <span className="plain-tag">OnData</span>
          </a>
          <a className="sidebar-plain-link" href="https://piersoft.github.io/CSV-to-RDF/" target="_blank" rel="noopener noreferrer">
            CSV to RDF <span className="plain-tag">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://piersoft.github.io/CSV-to-RDF/validatore-csv-pa.html" target="_blank" rel="noopener noreferrer">
            Validatore CSV <span className="plain-tag">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://piersoft.github.io/ckan-opendata-assistant/" target="_blank" rel="noopener noreferrer">
            Assistente ricerca <span className="plain-tag">AgID</span>
          </a>
        </div>

        <button className="help-sidebar-btn" onClick={() => setShowHelp(v => !v)} aria-label="Istruzioni brevi">
          Istruzioni brevi
        </button>

        <button className="clear-btn" aria-label="Nuova conversazione" onClick={() => { resetChat(); }}>
          Nuova conversazione
        </button>

        <StatusBar health={health} onRefresh={fetchHealth} compact />

        <div className="sidebar-github">
          <a href="https://github.com/piersoft/ckan-mcp-server-docker-ollama"
             target="_blank" rel="noopener noreferrer"
             aria-label="Codice sorgente su GitHub">
            <i className="bi bi-github" /> GitHub
          </a>
        </div>
      </aside>

      <main className="chat-area">
        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>SIMBA</h2>
              <p className="welcome-acronym"><span className="simba-letter">S</span>istema <span className="simba-letter">I</span>ntelligente di ricerca di <span className="simba-letter">M</span>etadati, <span className="simba-letter">B</span>onifica e <span className="simba-letter">A</span>rricchimento semantico</p>
              <p>Ricerca, valida e arricchisce i dataset della PA.</p>
              <div className="welcome-chips">
                <span className="chip" onClick={() => sendMessage("Cerca dataset sulla qualità dell'aria")}>Cerca dataset</span>
                <span className="chip" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }}>Valida CSV</span>
                <span className="chip" onClick={() => sendMessage("Converti CSV in RDF")}>🔄 CSV → RDF</span>
              </div>
            </div>
          )}

          {messages.map(renderMessage)}

          {loading && (
            <div className="message assistant">
              <div className="message-bubble typing"><span className="dot"/><span className="dot"/><span className="dot"/></div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Box validazione CSV — URL o Upload */}
        {showCsvBox && (
          <div className="csv-box">
            <div className="csv-box-tabs">
              <button className={`csv-tab ${csvTab==="url" ? "active":""}`} onClick={() => setCsvTab("url")}><Icon name="link-45deg" /> Da URL</button>
              <button className={`csv-tab ${csvTab==="upload" ? "active":""}`} onClick={() => setCsvTab("upload")}><Icon name="upload" /> Carica file</button>
            </div>
            {csvTab === "url" ? (
              <>
                <p>Incolla l'URL del file CSV:</p>
                <div className="csv-box-row">
                  <input type="url" className="csv-url-input"
                    placeholder="https://esempio.com/dati.csv"
                    value={csvUrl} onChange={e => setCsvUrl(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && validateFromBox()} />
                  <button className="btn-validate-box" onClick={validateFromBox} disabled={!csvUrl.trim()}>
                    ✅ Valida
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Carica un file CSV dal tuo computer (max 10 MB):</p>
                <div className="csv-box-row">
                  <input type="file" accept=".csv,.tsv,.txt" ref={csvFileRef} style={{display:"none"}}
                    onChange={e => setCsvFile(e.target.files[0] || null)} />
                  <button className="btn-file-pick" onClick={() => csvFileRef.current?.click()}>
                    <Icon name="upload" size={14} /> {csvFile ? csvFile.name : "Scegli file CSV…"}
                  </button>
                  <button className="btn-validate-box" onClick={validateFromUpload} disabled={!csvFile}>
                    <Icon name="check2-circle" size={14} /> Valida
                  </button>
                </div>
                {csvFile && <p style={{fontSize:"12px",color:"#555",marginTop:"6px"}}>📄 {csvFile.name} ({(csvFile.size/1024).toFixed(1)} KB)</p>}
              </>
            )}
          </div>
        )}

        {/* Box conversione TTL */}
        {showTtlBox && (
          <div className="csv-box ttl-box">
            {!ttlCsvText && (
              <div className="csv-box-tabs">
                <button className={`csv-tab ${ttlTab==="url" ? "active":""}`} onClick={() => setTtlTab("url")}><Icon name="link-45deg" /> Da URL</button>
                <button className={`csv-tab ${ttlTab==="upload" ? "active":""}`} onClick={() => setTtlTab("upload")}><Icon name="upload" /> Carica file</button>
              </div>
            )}
            <div className="ttl-meta-row">
              <div className="ttl-field">
                <label className="ttl-label">Nome PA *</label>
                <input type="text" className="csv-url-input" placeholder="es. Comune di Bari"
                  value={ttlPa} onChange={e => setTtlPa(e.target.value)} />
              </div>
              <div className="ttl-field">
                <label className="ttl-label">Codice IPA *</label>
                <input type="text" className="csv-url-input" placeholder="es. c_b220"
                  value={ttlIpa} onChange={e => setTtlIpa(e.target.value)} />
              </div>
            </div>
            <div className="ttl-fmt-row">
              <span className="convert-label">Formato output:</span>
              <button className={`fmt-btn ${ttlFmt==="ttl" ? "active" : ""}`} onClick={() => setTtlFmt("ttl")}>
                🐢 RDF/Turtle (.ttl)
              </button>
              <button className={`fmt-btn ${ttlFmt==="rdfxml" ? "active" : ""}`} onClick={() => setTtlFmt("rdfxml")}>
                📄 RDF/XML (.rdf)
              </button>
            </div>
            {ttlTab === "url" ? (
              <>
                <p>URL del file CSV da convertire {ttlFmt === "rdfxml" ? "(→ RDF/XML)" : "(→ RDF/Turtle)"}:</p>
                <div className="csv-box-row">
                  <input type="url" className="csv-url-input"
                    placeholder="https://esempio.it/dataset.csv"
                    value={ttlUrl} onChange={e => setTtlUrl(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && enrichFromBox()} />
                  <button className="btn-validate-box btn-ttl-box" onClick={enrichFromBox} disabled={!ttlUrl.trim()}>
                    🔄 Converti
                  </button>
                </div>
              </>
            ) : (
              <>
                {ttlCsvText ? (
                  <div className="csv-box-row">
                    <span style={{fontSize:"13px",color:"#555",flex:1}}>📄 CSV già in memoria dalla validazione</span>
                    <button className="btn-validate-box btn-ttl-box" onClick={enrichFromUpload}>
                      🔄 Converti
                    </button>
                  </div>
                ) : (
                  <>
                    <p>Carica un file CSV da convertire:</p>
                    <div className="csv-box-row">
                      <input type="file" accept=".csv,.tsv,.txt" ref={ttlFileRef} style={{display:"none"}}
                        onChange={e => setTtlFile(e.target.files[0] || null)} />
                      <button className="btn-file-pick" onClick={() => ttlFileRef.current?.click()}>
                        <Icon name="upload" size={14} /> {ttlFile ? ttlFile.name : "Scegli file CSV…"}
                      </button>
                      <button className="btn-validate-box btn-ttl-box" onClick={enrichFromUpload} disabled={!ttlFile || !ttlIpa.trim() || !ttlPa.trim()}>
                        <Icon name="diagram-3" size={14} /> Converti
                      </button>
                    </div>
                    {ttlFile && <p style={{fontSize:"12px",color:"#555",marginTop:"6px"}}>📄 {ttlFile.name} ({(ttlFile.size/1024).toFixed(1)} KB)</p>}
                  </>
                )}
              </>
            )}
            <p style={{fontSize:"11px",color:"#888",marginTop:"8px"}}>
              Ontologie rilevate automaticamente secondo dati-semantic-assets
            </p>
          </div>
        )}


        {showHelp && (
          <div className="help-popup" role="dialog" aria-label="Guida all'uso">
            <button className="help-close" onClick={() => setShowHelp(false)} aria-label="Chiudi guida">
              <Icon name="x-lg" size={14} />
            </button>

            <h4><Icon name="search" size={14} /> Cerca dataset</h4>
            <p>Usa verbi di ricerca seguiti dall'argomento. Esempi corretti:</p>
            <ul>
              <li><em>«cerca dati sulla qualità dell'aria»</em></li>
              <li><em>«trovami dataset sui rifiuti a Milano»</em></li>
              <li><em>«mostrami statistiche demografiche Puglia»</em></li>
              <li><em>«dati defibrillatori Mesagne»</em></li>
            </ul>
            <p className="help-warn"><Icon name="exclamation-triangle" size={12} /> Verranno scartate frasi troppo brevi, domande generiche o senza riferimento a dati aperti. Esempi <strong>non validi</strong>: <em>«cosa sono i dataset?»</em>, <em>«ciao»</em>, <em>«aiuto»</em>, <em>«i dati sono opendata?»</em></p>

            <h4><Icon name="check2-circle" size={14} /> Valida CSV</h4>
            <p>Clicca <strong>Valida CSV</strong> nella sidebar, poi scegli:</p>
            <ul>
              <li><strong>Da URL</strong> — incolla il link diretto al file CSV (anche Google Sheets)</li>
              <li><strong>Carica file</strong> — carica un file .csv dal tuo computer (max 10 MB)</li>
            </ul>
            <p>Il validatore controlla struttura, contenuto, qualità open data e linked data secondo le linee guida AgID. Punteggio da 0 a 100.</p>

            <h4><Icon name="diagram-3" size={14} /> Converti in RDF TTL/XML</h4>
            <p>Clicca <strong>Trasforma in RDF TTL/XML</strong> nella sidebar, poi:</p>
            <ul>
              <li>Scegli il formato: <strong>RDF/Turtle (.ttl)</strong> o <strong>RDF/XML (.rdf)</strong></li>
              <li>Inserisci il <strong>Codice IPA</strong> dell'ente (es. <em>c_b220</em>) — <strong>obbligatorio</strong></li>
              <li>Inserisci il <strong>Nome della PA</strong> (es. <em>Comune di Bari</em>) — <strong>obbligatorio</strong></li>
              <li>Fornisci l'URL del CSV o carica il file</li>
            </ul>
            <p>Le ontologie vengono rilevate automaticamente dal corpus di 468 dataset PA italiani reali.</p>

            <p className="help-tip"><Icon name="lightbulb" size={12} /> Questo assistente risponde <strong>esclusivamente</strong> a richieste riguardanti open data della Pubblica Amministrazione italiana. Domande su altri argomenti verranno rifiutate.</p>
          </div>
        )}
        <AdvancedSearch onResults={handleAdvResults} onLoading={setLoading} onLoadingMsg={handleAdvLoading} />
        <div className="wizard-bar">
          <div className="wizard-step">
            <span className="wizard-num">1</span>
            <span className="wizard-label">Cosa</span>
            <textarea
              ref={inputRef}
              className="wizard-input"
              aria-label="Cosa vuoi cercare"
              value={input}
              onChange={e => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
              }}
              onKeyDown={handleKey}
              placeholder="es. defibrillatori, rifiuti, bilancio…"
              rows={1}
              disabled={loading}
            />
          </div>
          <div className="wizard-step" style={{position:"relative"}}>
            <span className="wizard-num">2</span>
            <span className="wizard-label">Dove</span>
            <input
              ref={doveRef}
              type="text"
              className="wizard-input"
              aria-label="Amministrazione (opzionale)"
              value={wizardDove}
              onChange={e => handleDoveInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { setShowDoveAc(false); sendMessage(input); } if (e.key === "Escape") setShowDoveAc(false); }}
              onBlur={() => setTimeout(() => setShowDoveAc(false), 200)}
              placeholder="es. Comune di Bari… (vuoto = tutti)"
              disabled={loading}
              autoComplete="off"
            />
            {showDoveAc && (
              <div className="dove-ac-list">
                {doveAcList.map((m, i) => (
                  <div key={i} className="dove-ac-item" onMouseDown={() => { setWizardDove(m.name); setShowDoveAc(false); }}>
                    <span>{m.name}</span>
                    <span className="dove-ac-count">{m.count.toLocaleString("it")} ds</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="wizard-actions">
            <button className="wizard-search-btn" aria-label="Cerca" onClick={async () => {
              if (!input.trim()) return;
              if (!wizardDove) {
                // Solo COSA → usa il flusso normale con intent+SPARQL ASK
                sendMessage(input.trim());
                return;
              }
              // COSA + DOVE → query SPARQL diretta con filtro rightsHolder
              const userMsg = `${input.trim()} · ${wizardDove}`;
              setMessages([]);  // nuova ricerca — pulisce la chat
              addMsg("user", userMsg);
              setLoading(true);
              try {
                const t0w = Date.now();
                const { datasets, offset } = await doSearch(input.trim(), 0, wizardDove);
                emitAnalytics("search", {
                  query: input.trim().slice(0, 500),
                  where: wizardDove || null,
                  datasets_found: datasets.length,
                  latency_ms: Date.now() - t0w,
                });
                if (!datasets.length) {
                  addMsg("assistant", `Nessun dataset trovato per **"${userMsg}"**.`);
                } else {
                  addMsg("assistant", `Trovati risultati per **"${userMsg}"**:`, {
                    type: "search_results", datasets, query: userMsg, offset,
                  });
                }
              } catch(e) {
                addMsg("assistant", `❌ Errore: ${e.message}`);
              } finally {
                setLoading(false);
              }
            }} disabled={loading || !input.trim()}>
              {loading ? <Icon name="hourglass-split" /> : <><Icon name="search" size={15}/> Cerca</>}
            </button>
          </div>
        </div>

      </main>
    </div>
  );
}
