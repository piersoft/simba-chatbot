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

  // ── Ricerca SPARQL ────────────────────────────────────────────────────────
  async function doSearch(query, offset = 0) {
    const r = await fetch(`${BACKEND_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, offset }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
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

        <div className="sidebar-section suggestions-section">
          <div className="section-label">Suggerimenti</div>
          {SUGGESTIONS.map((s, i) => (
            <button key={i} className="suggestion-btn"
              onClick={() => s.action === "validate_prompt"
                ? (addMsg("user","Valida un CSV"), setShowCsvBox(true))
                : sendMessage(s.text)}
              disabled={loading}>
              {s.icon} {s.text}
            </button>
          ))}
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

          {/* Box validazione CSV manuale */}
          {showCsvBox && (
            <div className="csv-box">
              <p>📎 Incolla l'URL del file CSV da validare:</p>
              <div className="csv-box-row">
                <input
                  type="url"
                  className="csv-url-input"
                  placeholder="https://esempio.com/dati.csv"
                  value={csvUrl}
                  onChange={e => setCsvUrl(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && validateFromBox()}
                />
                <button className="btn-validate-box" onClick={validateFromBox} disabled={!csvUrl.trim()}>
                  ✅ Valida
                </button>
              </div>
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
