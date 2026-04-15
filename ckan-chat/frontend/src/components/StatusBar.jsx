export default function StatusBar({ health, onRefresh }) {
  const dot = (status) => (
    <span className={`status-dot ${status === "ok" ? "ok" : "error"}`} />
  );

  return (
    <div className="status-bar">
      <div className="status-row">
        {dot(health?.backend)} <span>Backend</span>
      </div>
      <div className="status-row">
        {dot(health?.ollama)} <span>Ollama</span>
      </div>
      <div className="status-row">
        {dot(health?.validatore)} <span>Validatore</span>
      </div>
      <div className="status-row">
        {dot(health?.rdf)} <span>RDF</span>
      </div>
      <button className="refresh-btn" onClick={onRefresh} title="Aggiorna stato">
        ↻
      </button>
    </div>
  );
}
