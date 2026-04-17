import { useState, useEffect } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

export default function AdminPanel() {
  const [blocklist, setBlocklist] = useState([]);
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { fetchBlocklist(); }, []);

  async function fetchBlocklist() {
    try {
      const r = await fetch(`${BACKEND_URL}/api/admin/blocklist`);
      const data = await r.json();
      setBlocklist(data.blocklist || []);
    } catch(e) { setError("Errore caricamento blocklist: " + e.message); }
  }

  async function addWord(e) {
    e.preventDefault();
    if (!newWord.trim()) return;
    setLoading(true); setError(""); setSuccess("");
    try {
      const r = await fetch(`${BACKEND_URL}/api/admin/blocklist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: newWord.trim() }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error); return; }
      setBlocklist(data.blocklist);
      setNewWord("");
      setSuccess(`"${newWord.trim()}" aggiunta.`);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function removeWord(word) {
    setError(""); setSuccess("");
    try {
      const r = await fetch(`${BACKEND_URL}/api/admin/blocklist/${encodeURIComponent(word)}`, { method: "DELETE" });
      const data = await r.json();
      if (!r.ok) { setError(data.error); return; }
      setBlocklist(data.blocklist);
      setSuccess(`"${word}" rimossa.`);
    } catch(e) { setError(e.message); }
  }

  return (
    <div style={{ maxWidth: 700, margin: "40px auto", padding: "0 20px", fontFamily: "'Titillium Web', sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32, borderBottom: "2px solid #0066cc", paddingBottom: 16 }}>
        <img src="/chatbot/logo-agid.png" alt="AgID" style={{ height: 36 }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, color: "#17324d" }}>SIMBA — Pannello Admin</div>
          <div style={{ fontSize: 13, color: "#5c6f82" }}>Gestione guardrail contenuti</div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 700, color: "#17324d", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Blocklist attiva ({blocklist.length} termini)
      </h2>
      <p style={{ fontSize: 13, color: "#5c6f82", marginBottom: 20 }}>
        Le parole qui sotto vengono bloccate prima che la richiesta raggiunga il motore di ricerca.
      </p>

      {error && <div style={{ background: "#ffeef0", border: "1px solid #f5a6ae", borderRadius: 4, padding: "8px 12px", color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{error}</div>}
      {success && <div style={{ background: "#eafaf1", border: "1px solid #a9dfbf", borderRadius: 4, padding: "8px 12px", color: "#1e8449", fontSize: 13, marginBottom: 12 }}>{success}</div>}

      <form onSubmit={addWord} style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={newWord}
          onChange={e => setNewWord(e.target.value)}
          placeholder="Aggiungi parola da bloccare…"
          style={{ flex: 1, padding: "9px 12px", border: "1px solid #d9e4ef", borderRadius: 4, fontSize: 14, fontFamily: "inherit" }}
        />
        <button type="submit" disabled={loading || !newWord.trim()}
          style={{ padding: "9px 20px", background: "#0066cc", color: "#fff", border: "none", borderRadius: 4, fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          Aggiungi
        </button>
      </form>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {blocklist.sort().map(word => (
          <div key={word} style={{ display: "flex", alignItems: "center", gap: 6, background: "#f0f6fc", border: "1px solid #cce0f5", borderRadius: 4, padding: "4px 10px" }}>
            <span style={{ fontSize: 13, color: "#17324d", fontFamily: "monospace" }}>{word}</span>
            <button onClick={() => removeWord(word)}
              style={{ background: "none", border: "none", cursor: "pointer", color: "#c0392b", fontSize: 15, lineHeight: 1, padding: "0 2px" }}
              title={`Rimuovi "${word}"`}>×</button>
          </div>
        ))}
      </div>

      {blocklist.length === 0 && (
        <p style={{ color: "#5c6f82", fontSize: 14, fontStyle: "italic" }}>Nessun termine in blocklist.</p>
      )}
    </div>
  );
}
