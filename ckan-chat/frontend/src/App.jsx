import { useState, useRef, useEffect } from "react";
import StatusBar from "./components/StatusBar";
import DatasetCard from "./components/DatasetCard";
import ValidateReport from "./components/ValidateReport";
import Icon from "./components/Icon";
import AdvancedSearch from "./components/AdvancedSearch";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";

const SUGGESTIONS = [
  { text: "Cerca dataset sulla qualità dell'aria", icon: "🔍" },
  { text: "Trova dati sui rifiuti urbani",          icon: "🔍" },
  { text: "Dataset sulla mobilità e trasporti",     icon: "🔍" },
  { text: "Dati sull'energia rinnovabile",           icon: "🔍" },
  { text: "Valida CSV da URL",                       icon: "✅", action: "validate_prompt" },
];

const BLOCKLIST = ["ignore previous","system prompt","forget instructions","jailbreak"];

export default function App() {
  const [messages,    setMessages]    = useState([]);
  const [pageTitle,   setPageTitle]   = useState("Esplora i Dati Aperti Italiani");
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [health,      setHealth]      = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [csvUrl,      setCsvUrl]      = useState("");
  const [csvTab,      setCsvTab]      = useState("url"); // "url" | "upload"
  const [csvFile,     setCsvFile]     = useState(null);
  const [showTtlBox,  setShowTtlBox]  = useState(false);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok) return "SEARCH";
      return (await r.json()).intent ?? "SEARCH";
    } catch { return "SEARCH"; }
  }

  // ── Ricerca SPARQL — chiamata diretta dal browser (come l'assistente CKAN) ──
  async function doSearch(query, offset = 0) {
    const SPARQL_EP = "https://lod.dati.gov.it/sparql";
    const FETCH_SIZE = 32; // come l'assistente: fetch più righe per deduplicare
    const PAGE_SIZE  = 8;
    const STOPWORDS = new Set(["il","lo","la","i","gli","le","un","una","uno",
      "di","a","da","in","con","su","per","tra","fra","e","o","ma","non","che",
      "del","dei","delle","della","degli","al","ai","alle","alla","nel","nei",
      "sul","sui","sulla","sulle"]);

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
      const sparqlQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?d ?title ?description ?modified ?publisher WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?publisher }
  FILTER(${kwFilter(words, useOr)})
} ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${off}`;
      const url = `${SPARQL_EP}?query=${encodeURIComponent(sparqlQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
      const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
      if (!r.ok) throw new Error(`SPARQL error ${r.status}`);
      return (await r.json()).results?.bindings ?? [];
    }

    // Prima prova AND, se non trova nulla riprova con OR (come l'assistente)
    let bindings = await runQuery(useWords, false, offset);
    if (bindings.length === 0 && useWords.length > 1) {
      bindings = await runQuery(useWords, true, offset);
    }

    // Deduplicazione e costruzione risultati
    // Il publisher viene dalla query principale (rightsHolder opzionale)
    const seen = new Map();
    for (const b of bindings) {
      const uri = b.d?.value ?? "";
      if (!uri || seen.has(uri)) continue;
      const id = uri.split("/").pop();
      seen.set(uri, {
        uri, id,
        title:       b.title?.value ?? "",
        description: b.description?.value ?? "",
        modified:    b.modified?.value?.slice(0,10) ?? "",
        publisher:   b.publisher?.value ?? "",
        viewUrl:     `https://www.dati.gov.it/view-dataset/dataset?id=${id}`,
        csvResources: [],
      });
    }
    const datasets = [...seen.values()].slice(0, PAGE_SIZE);
    return { datasets, query, offset };
  }

  // ── Validazione CSV ───────────────────────────────────────────────────────
  async function doValidate(url) {
    // 1. Prima prova dal browser (segue redirect, nessun CORS problem su CSV diretti)
    try {
      const csvRes = await fetch(url);
      if (csvRes.ok) {
        const csv_text = await csvRes.text();
        const isHtml = csv_text.trimStart().startsWith("<");
        const firstLine = csv_text.trim().split("\n")[0] || "";
        const hasSep = firstLine.includes(",") || firstLine.includes(";") || firstLine.includes("\t");
        if (!isHtml && hasSep) {
          const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ csv_text, filename: url.split("/").pop() }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()).report ?? "";
        }
      }
    } catch(e) {
      console.warn("[doValidate] browser fetch fallito:", e.message);
    }
    // 2. Il browser ha ricevuto HTML (accessURL → pagina CKAN) o CORS bloccato
    // Passa l URL al backend che scarica server-side e segue i redirect
    const r = await fetch(`${BACKEND_URL}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).report ?? "";
  }

  // ── Callback per risultati ricerca avanzata ─────────────────────────────
  function handleAdvResults(datasets, label) {
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

  // ── Handler principale ────────────────────────────────────────────────────
  function resetChat() {
    setMessages([]);
    setShowCsvBox(false);
    setShowTtlBox(false);
    setTtlCsvText(null);
    setCsvFile(null);
    setTtlFile(null);
  }

  async function sendMessage(text) {
    if (!text.trim() || loading) return;
    if (BLOCKLIST.some(p => text.toLowerCase().includes(p))) { alert("Input non valido."); return; }
    if (text.length > 2000) { alert("Messaggio troppo lungo."); return; }

    setSidebarOpen(false);
    setShowCsvBox(false);
    addMsg("user", text);
    setInput("");
    setLoading(true);

    try {
      const intent = await classifyIntent(text);

      if (intent === "SEARCH") setPageTitle("🔍 Ricerca Dataset — Open Data Italia");
      else if (intent === "VALIDATE") setPageTitle("✅ Validazione CSV — Open Data Italia");
      else if (intent === "ENRICH") setPageTitle("🔄 Conversione RDF — Open Data Italia");

      if (intent === "OFF_TOPIC") {
        addMsg("assistant", `Mi dispiace, posso aiutarti solo con:\n- 🔍 Ricerca dataset open data italiani\n- ✅ Validazione file CSV per la PA\n- 🔄 Conversione CSV → RDF Linked Data\n\nProva con: *"Cerca dataset sulla qualità dell'aria"*`);
        return;
      }

      if (intent === "VALIDATE") {
        const url = text.match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) {
          addMsg("assistant", "Per validare un CSV dimmi l'URL del file.\n\nOppure usa il box qui sotto per incollarlo:");
          setShowCsvBox(true);
          return;
        }
        addMsg("assistant", `✅ Validazione in corso per:\n\`${url}\``, { type: "validating" });
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

      setPageTitle("🔍 Ricerca Dataset — Open Data Italia");
      addMsg("assistant", `🔍 Ricerca di **"${query}"** in corso…`, { type: "searching" });

      const { datasets } = await doSearch(query);

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
    setPageTitle("🔄 Conversione RDF — Open Data Italia");
    addMsg("assistant", `🔄 Conversione in RDF/${fmt.toUpperCase()} di **"${datasetTitle}"** in corso…`);
    setLoading(true);
    try {
      // Passa sempre l'URL al backend — rdf-mcp lo scarica direttamente
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      addMsg("assistant", `✅ Conversione completata! ${lines.length} triple generate.`, {
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
    setLoading(true);
    try {
      const { datasets } = await doSearch(query, newOffset);
      if (!datasets.length) { addMsg("assistant", "Nessun altro risultato disponibile."); return; }
      addMsg("assistant", `Altri risultati per **"${query}"**:`, {
        type: "search_results", datasets, query, offset: newOffset,
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); }
  }

  // ── Valida CSV da card ────────────────────────────────────────────────────
  async function validateFromCard(url, datasetTitle) {
    addMsg("user",      `Valida CSV: ${url}`);
    setPageTitle("✅ Validazione CSV — Open Data Italia");
    addMsg("assistant", `✅ Validazione CSV di **"${datasetTitle}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      const report = await doValidate(url);
      addMsg("assistant", report, { type: "validate_report", url });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); }
  }

  // ── Valida CSV da box manuale ─────────────────────────────────────────────
  async function validateFromUpload() {
    if (!csvFile) return;
    setShowCsvBox(false);
    addMsg("user", `Valida CSV: ${csvFile.name}`);
    addMsg("assistant", `✅ Validazione CSV di **"${csvFile.name}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      const text = await csvFile.text();
      const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_text: text, filename: csvFile.name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      addMsg("assistant", data.report ?? "Errore nella validazione", { type: "validate_report", url: csvFile.name, csvText: text });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setCsvFile(null); }
  }

  async function doEnrichText(csv_text, filename, fmt = "ttl") {
    // Conversione diretta da testo CSV (file già caricato) — niente box IPA/PA
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${filename}`);
    addMsg("assistant", `🔄 Conversione in RDF/${fmt.toUpperCase()} di **"${filename}"** in corso…`);
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_text, pa: filename.replace(/\.csv$/i,""), ipa: "ente", fmt }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      const preview = lines.slice(0, 30).join("\n");
      const ext = fmt === "rdfxml" ? "rdf" : "ttl";
      const blob = new Blob([ttl], { type: fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle" });
      const blobUrl = URL.createObjectURL(blob);
      addMsg("assistant", `✅ Conversione completata! ${lines.length} righe generate.`, {
        type: "ttl_result", blobUrl, filename: `${filename.replace(/\.csv$/i,"")}.${ext}`, preview, fmt
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    setLoading(false);
  }

  function openTtlBox(url, fmt = "ttl", csvText = null) {
    setShowCsvBox(false);
    setTtlCsvText(csvText);
    setTtlUrl(csvText ? "" : (url || ""));
    setTtlTab(csvText ? "upload" : "url");
    setTtlFmt(fmt);
    setTtlIpa("");
    setTtlPa("");
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
    const fname = ttlFile?.name || "CSV";
    const fmt = ttlFmt || "ttl";
    const ext = fmt === "rdfxml" ? "rdf" : "ttl";
    const mimeType = fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle";
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${fname}`);
    addMsg("assistant", `🔄 Conversione in RDF/${fmt === "rdfxml" ? "XML" : "Turtle"} di **"${pa}"** in corso…`);
    setLoading(true);
    try {
      const csv_text = hasMemory ? ttlCsvText : await ttlFile.text();
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv_text, pa, ipa, fmt }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      const preview = lines.slice(0, 30).join("\n");
      const blob = new Blob([ttl], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      addMsg("assistant", `✅ Conversione completata!`, { type: "ttl_result", blobUrl, filename: `${ipa}-${Date.now()}.${ext}`, preview, fmt });
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
            <button className="load-more-btn" onClick={() => loadMore(m.query, m.offset)}>
              Carica altri risultati ↓
            </button>
          </div>
        </div>
      );
    }

    if (m.type === "ttl_result") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <p>✅ Conversione completata!</p>
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
            <ValidateReport report={m.content} url={m.url} csvText={m.csvText} onEnrich={(url, fmt) => openTtlBox(url, fmt, m.csvText)} onEnrichText={doEnrichText} />
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
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>☰</button>
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-logo">

        </div>

        <StatusBar health={health} onRefresh={fetchHealth} />

        {/* Strumenti disponibili — card colorate */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti disponibili</div>
          <button className="tool-card tool-search" onClick={() => { resetChat(); setSidebarOpen(false); inputRef.current?.focus(); }} disabled={loading}>
            <Icon name="search" size={18} /> Cerca dataset
          </button>
          <button className="tool-card tool-validate" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }} disabled={loading}>
            <Icon name="check2-circle" size={18} /> Valida CSV
          </button>
          <button className="tool-card tool-ttl" onClick={() => { setSidebarOpen(false); setShowTtlBox(true); setShowCsvBox(false); }} disabled={loading}>
            <Icon name="diagram-3" size={18} /> Trasforma in RDF TTL/XML
          </button>
        </div>

        {/* Link strumenti — testo semplice */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti consigliati</div>
          <a className="sidebar-plain-link" href="https://github.com/ondata/ckan-mcp-server" target="_blank" rel="noopener noreferrer">
            🔌 CKAN MCP Server <span className="plain-tag">OnData</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/ondata/istat_mcp_server" target="_blank" rel="noopener noreferrer">
            🔌 ISTAT MCP Server <span className="plain-tag">OnData</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/piersoft/CSV-to-RDF" target="_blank" rel="noopener noreferrer">
            📄 CSV to RDF <span className="plain-tag">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/piersoft/CSV-to-RDF/blob/main/validatore-csv-pa.html" target="_blank" rel="noopener noreferrer">
            ✅ Validatore CSV <span className="plain-tag">AgID</span>
          </a>
        </div>

        <button className="clear-btn" aria-label="Nuova conversazione" onClick={() => { resetChat(); }}>
          Nuova conversazione
        </button>

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
              <h2>Assistente Open Data Italiani</h2>
              <p>Cerca dataset, valida CSV o converti in Linked Data.<br />
                 Basato su dati.gov.it e ontologie PA italiane.</p>
              <div className="welcome-chips">
                <span className="chip" onClick={() => sendMessage("Cerca dataset sulla qualità dell'aria")}>🔍 Cerca dataset</span>
                <span className="chip" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }}>Valida CSV</span>
                <span className="chip" onClick={() => sendMessage("Converti CSV in RDF")}>🔄 CSV → RDF</span>
              </div>
            </div>
          )}

          {messages.map(renderMessage)}

          {loading && (
            <div className="message assistant">
              <div className="message-bubble typing"><span /><span /><span /></div>
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
                <p>Carica un file CSV dal tuo computer (max 5 MB):</p>
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
              <input type="text" className="csv-url-input" placeholder="* Codice IPA (es. c_b220)"
                value={ttlIpa} onChange={e => setTtlIpa(e.target.value)} />
              <input type="text" className="csv-url-input" placeholder="* Nome PA (es. Comune di Bari)"
                value={ttlPa} onChange={e => setTtlPa(e.target.value)} />
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


        <AdvancedSearch onResults={handleAdvResults} onLoading={setLoading} />
        <div className="input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            aria-label="Scrivi un messaggio"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Cerca dataset, valida un CSV, converti in RDF…"
            rows={1}
            disabled={loading}
          />
          <button className="send-btn" aria-label="Invia messaggio" onClick={() => sendMessage(input)} disabled={loading || !input.trim()}>
            {loading ? <Icon name="hourglass-split" /> : <Icon name="send-fill" />}
          </button>
        </div>
      </main>
    </div>
  );
}
