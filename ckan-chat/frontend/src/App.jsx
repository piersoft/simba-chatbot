import { useState, useRef, useEffect, useCallback } from "react";
import StatusBar from "./components/StatusBar";
import ToolCallBadge from "./components/ToolCallBadge";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";
const BASE_PATH   = import.meta.env.VITE_BASE_PATH ?? "/";

const SUGGESTIONS = [
  { text: "Cerca dataset sulla qualità dell'aria", icon: "🔍" },
  { text: "Trova dataset sui rifiuti in Lombardia", icon: "🔍" },
  { text: "Valida questo CSV: https://raw.githubusercontent.com/piersoft/CSV-to-RDF/main/esempio.csv", icon: "✅" },
  { text: "Dataset sull'energia rinnovabile", icon: "🔍" },
  { text: "Cerca dati sulla mobilità urbana", icon: "🔍" },
];

const OFF_TOPIC_MSG = `Mi dispiace, posso aiutarti solo con:
- 🔍 **Ricerca** di dataset e dati aperti
- ✅ **Validazione** di file CSV per la PA
- 🔄 **Conversione** CSV → RDF/Linked Data

Prova con: *"Cerca dataset sulla qualità dell'aria"*`;

// Estrae la query di ricerca dalla domanda utente
function extractSearchQuery(text) {
  return text
    .replace(/^(cerca|trovami|mostrami|dammi|elenca|mostra|trova)\s+/i, "")
    .replace(/\b(dataset|dati aperti|open data|portale ckan)\b/gi, "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Estrae URL CSV dalla domanda
function extractCsvUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

export default function App() {
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [health, setHealth]         = useState(null);
  const [toolCalls, setToolCalls]   = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // modalità attiva: null | "search" | "validate" | "enrich"
  const [activeMode, setActiveMode] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [validateResult, setValidateResult] = useState(null);

  const bottomRef = useRef(null);
  const inputRef  = useRef(null);
  const iframeRef = useRef(null);

  useEffect(() => { fetchHealth(); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e) => { if (!e.target.closest(".sidebar")) setSidebarOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sidebarOpen]);

  // Quando cambia searchQuery, comunica all'iframe dell'assistente
  useEffect(() => {
    if (activeMode !== "search" || !searchQuery || !iframeRef.current) return;
    // Aspetta che l'iframe sia caricato prima di mandare il messaggio
    const send = () => {
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "CKAN_SEARCH", query: searchQuery }, "*"
        );
      } catch {}
    };
    iframeRef.current.addEventListener("load", send, { once: true });
    send(); // prova subito se già caricato
  }, [activeMode, searchQuery]);

  async function fetchHealth() {
    try {
      const r = await fetch(`${BACKEND_URL}/api/health`);
      setHealth(await r.json());
    } catch {
      setHealth({ backend: "error", ollama: "error", mcp: "error" });
    }
  }

  async function classifyIntent(text) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok) return "SEARCH";
      const data = await r.json();
      return data.intent ?? "SEARCH";
    } catch {
      return "SEARCH";
    }
  }

  async function validateCsv(url) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: `valida il CSV: ${url}` }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return data.reply;
    } catch (e) {
      return `❌ Errore validazione: ${e.message}`;
    }
  }

  async function sendMessage(text) {
    if (!text.trim() || loading) return;

    const blocklist = ["ignore previous", "system prompt", "forget instructions", "jailbreak"];
    if (blocklist.some(p => text.toLowerCase().includes(p))) { alert("Input non valido."); return; }
    if (text.length > 2000) { alert("Messaggio troppo lungo (max 2000 caratteri)."); return; }

    setSidebarOpen(false);
    const userMsg = { role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);
    setToolCalls([]);
    setActiveMode(null);
    setValidateResult(null);

    // 1. Classifica l'intenzione
    const intent = await classifyIntent(text);

    if (intent === "OFF_TOPIC") {
      setMessages(prev => [...prev, { role: "assistant", content: OFF_TOPIC_MSG }]);
      setLoading(false);
      return;
    }

    if (intent === "SEARCH") {
      const q = extractSearchQuery(text);
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `🔍 Ricerca in corso per **"${q}"** nel catalogo dati.gov.it...`,
        isSearch: true,
      }]);
      setSearchQuery(q);
      setActiveMode("search");
      setLoading(false);
      return;
    }

    if (intent === "VALIDATE") {
      const csvUrl = extractCsvUrl(text);
      if (!csvUrl) {
        setMessages(prev => [...prev, {
          role: "assistant",
          content: "Per validare un CSV dimmi l'URL del file.\nEsempio: *\"Valida questo CSV: https://example.com/dati.csv\"*",
        }]);
        setLoading(false);
        return;
      }
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `✅ Validazione CSV in corso: \`${csvUrl}\`...`,
      }]);
      const result = await validateCsv(csvUrl);
      setValidateResult({ url: csvUrl, report: result });
      setMessages(prev => [...prev, { role: "assistant", content: result }]);
      setToolCalls([{ tool: "csv_validate", args: { csv_url: csvUrl } }]);
      setLoading(false);
      return;
    }

    if (intent === "ENRICH") {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "🔄 La funzione di conversione CSV → RDF/Linked Data è in arrivo!\n\nNel frattempo puoi usare il tool online: https://piersoft.github.io/CSV-to-RDF/",
      }]);
      setLoading(false);
      return;
    }

    setLoading(false);
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  function resetChat() {
    setMessages([]);
    setToolCalls([]);
    setActiveMode(null);
    setSearchQuery("");
    setValidateResult(null);
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

        {toolCalls.length > 0 && (
          <div className="sidebar-section">
            <div className="section-label">Ultima Query</div>
            <div className="tool-calls-list">
              {toolCalls.map((tc, i) => <ToolCallBadge key={i} toolCall={tc} />)}
            </div>
          </div>
        )}

        <div className="sidebar-section suggestions-section">
          <div className="section-label">Suggerimenti</div>
          {SUGGESTIONS.map((s, i) => (
            <button key={i} className="suggestion-btn" onClick={() => sendMessage(s.text)} disabled={loading}>
              {s.icon} {s.text}
            </button>
          ))}
        </div>

        <button className="clear-btn" onClick={resetChat}>Nuova conversazione</button>
      </aside>

      <main className="chat-area">
        <div className="chat-header">
          <span className="chat-header-title">🏛️ Esplora i Dati Aperti Italiani</span>
          <span className="chat-header-subtitle">
            {activeMode === "search" ? "📊 Assistente CKAN attivo" :
             activeMode === "validate" ? "✅ Validatore CSV attivo" : ""}
          </span>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">🏛️</div>
              <h2>Assistente Open Data</h2>
              <p>Cerca dataset, valida CSV o converti in Linked Data.<br />Tutto basato su dati.gov.it e ontologie PA italiane.</p>
              <div className="welcome-chips">
                <span className="chip" onClick={() => sendMessage("Cerca dataset sulla qualità dell'aria")}>🔍 Cerca dataset</span>
                <span className="chip" onClick={() => sendMessage("Valida questo CSV: https://raw.githubusercontent.com/piersoft/CSV-to-RDF/main/esempio.csv")}>✅ Valida CSV</span>
                <span className="chip" onClick={() => sendMessage("Converti CSV in RDF")}>🔄 CSV → RDF</span>
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <div className="message-bubble">
                {m.content.split("\n").map((line, j) => {
                  // Rendering minimale markdown: **bold**, *italic*, link
                  const html = line
                    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                    .replace(/\*(.+?)\*/g, "<em>$1</em>")
                    .replace(/`(.+?)`/g, "<code>$1</code>")
                    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
                  return <p key={j} dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />;
                })}
              </div>
            </div>
          ))}

          {loading && (
            <div className="message assistant">
              <div className="message-bubble typing">
                <span /><span /><span />
              </div>
            </div>
          )}

          {/* Pannello assistente CKAN embedded */}
          {activeMode === "search" && (
            <div className="embedded-panel">
              <iframe
                ref={iframeRef}
                src={`/chatbot/assistant.html`}
                title="Assistente CKAN"
                className="ckan-iframe"
                onLoad={() => {
                  if (searchQuery) {
                    try {
                      iframeRef.current?.contentWindow?.postMessage(
                        { type: "CKAN_SEARCH", query: searchQuery }, "*"
                      );
                    } catch {}
                  }
                }}
              />
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Cerca dataset, valida un CSV, converti in RDF..."
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
