import { useState, useRef, useEffect } from "react";
import StatusBar from "./components/StatusBar";
import DatasetCard from "./components/DatasetCard";
import ValidateReport from "./components/ValidateReport";

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
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [health,      setHealth]      = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [csvUrl,      setCsvUrl]      = useState("");
  const [csvTab,      setCsvTab]      = useState("url"); // "url" | "upload"
  const [csvFile,     setCsvFile]     = useState(null);
  const [showCsvBox,  setShowCsvBox]  = useState(false);

  const bottomRef = useRef(null);
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
SELECT DISTINCT ?d ?title ?description ?modified WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
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

    // Poi recupera publisher in parallelo (query separata per non sporcare DISTINCT)
    const uris = [...new Set(bindings.map(b => b.d?.value).filter(Boolean))];
    const pubMap = new Map();
    if (uris.length > 0) {
      try {
        const pubQ = `PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?d ?rhName WHERE {
  VALUES ?d { ${uris.map(u => `<${u}>`).join(" ")} }
  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }
}`;
        const pubUrl = `${SPARQL_EP}?query=${encodeURIComponent(pubQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const pr = await fetch(pubUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (pr.ok) {
          const pd = await pr.json();
          (pd.results?.bindings ?? []).forEach(b => {
            if (b.rhName?.value) pubMap.set(b.d?.value, b.rhName.value);
          });
        }
      } catch {}
    }

    // Deduplicazione e costruzione risultati
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
        publisher:   pubMap.get(uri) ?? "",
        viewUrl:     `https://www.dati.gov.it/view-dataset/dataset?id=${id}`,
        csvResources: [],
      });
    }
    const datasets = [...seen.values()].slice(0, PAGE_SIZE);
    return { datasets, query, offset };
  }

  // ── Validazione CSV ───────────────────────────────────────────────────────
  async function doValidate(url) {
    const r = await fetch(`${BACKEND_URL}/api/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).report ?? "";
  }

  // ── Aggiunge un messaggio alla chat ───────────────────────────────────────
  function addMsg(role, content, extra = {}) {
    setMessages(prev => [...prev, { role, content, ...extra }]);
  }

  // ── Handler principale ────────────────────────────────────────────────────
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
        addMsg("assistant", `🔄 La conversione CSV → RDF/Linked Data è in arrivo!\n\nNel frattempo usa il tool online: https://piersoft.github.io/CSV-to-RDF/`);
        return;
      }

      // SEARCH — estrae la query e chiama SPARQL
      const query = text
        .replace(/^(cerca|trovami|mostrami|dammi|elenca|trova)\s+/i, "")
        .replace(/\b(dataset|open data)\b/gi, "")
        .replace(/\s+/g, " ").trim() || text;

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
      addMsg("assistant", data.report ?? "Errore nella validazione", { type: "validate_report", url: csvFile.name });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setCsvFile(null); }
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
                <DatasetCard key={j} dataset={d} onValidate={validateFromCard} />
              ))}
            </div>
            <button className="load-more-btn" onClick={() => loadMore(m.query, m.offset)}>
              Carica altri risultati ↓
            </button>
          </div>
        </div>
      );
    }

    if (m.type === "validate_report") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <ValidateReport report={m.content} url={m.url} />
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
          <div className="logo-icon">🇮🇹</div>
          <span className="logo-text">Open Data<br />Assistant</span>
        </div>

        <StatusBar health={health} onRefresh={fetchHealth} />

        {/* Strumenti disponibili — card colorate */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti disponibili</div>
          <button className="tool-card tool-search" onClick={() => { setSidebarOpen(false); inputRef.current?.focus(); }} disabled={loading}>
            🔍 Cerca dataset
          </button>
          <button className="tool-card tool-validate" onClick={() => { addMsg("user","Valida un CSV"); setShowCsvBox(true); }} disabled={loading}>
            ✅ Valida CSV
          </button>
          <button className="tool-card tool-ttl" onClick={() => sendMessage("Converti CSV in RDF TTL")} disabled={loading}>
            🔄 Trasforma in TTL
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

        <button className="clear-btn" onClick={() => { setMessages([]); setShowCsvBox(false); }}>
          Nuova conversazione
        </button>
      </aside>

      <main className="chat-area">
        <div className="chat-header">
          <span className="chat-header-title">🏛️ Esplora i Dati Aperti Italiani</span>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">🏛️</div>
              <h2>Assistente Open Data</h2>
              <p>Cerca dataset, valida CSV o converti in Linked Data.<br />
                 Basato su dati.gov.it e ontologie PA italiane.</p>
              <div className="welcome-chips">
                <span className="chip" onClick={() => sendMessage("Cerca dataset sulla qualità dell'aria")}>🔍 Cerca dataset</span>
                <span className="chip" onClick={() => { addMsg("user","Valida un CSV"); setShowCsvBox(true); }}>✅ Valida CSV</span>
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

          {/* Box validazione CSV — URL o Upload */}
          {showCsvBox && (
            <div className="csv-box">
              <div className="csv-box-tabs">
                <button className={`csv-tab ${csvTab==="url" ? "active":""}`} onClick={() => setCsvTab("url")}>🔗 Da URL</button>
                <button className={`csv-tab ${csvTab==="upload" ? "active":""}`} onClick={() => setCsvTab("upload")}>📁 Carica file</button>
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
                    <input type="file" accept=".csv,.tsv,.txt"
                      className="csv-url-input"
                      onChange={e => setCsvFile(e.target.files[0] || null)} />
                    <button className="btn-validate-box" onClick={validateFromUpload} disabled={!csvFile}>
                      ✅ Valida
                    </button>
                  </div>
                  {csvFile && <p style={{fontSize:"12px",color:"#555",marginTop:"6px"}}>📄 {csvFile.name} ({(csvFile.size/1024).toFixed(1)} KB)</p>}
                </>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Cerca dataset, valida un CSV, converti in RDF…"
            rows={1}
            disabled={loading}
          />
          <button className="send-btn" onClick={() => sendMessage(input)} disabled={loading || !input.trim()}>
            {loading ? "⏳" : "➤"}
          </button>
        </div>
      </main>
    </div>
  );
}
