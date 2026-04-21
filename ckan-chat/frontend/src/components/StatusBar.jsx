export default function StatusBar({ health, onRefresh, compact }) {
  const dot = (status) => (
    <span className={`status-dot ${status === "ok" ? "ok" : "error"}`} />
  );

  if (compact) {
    return (
      <div className="status-bar-compact">
        <div className="status-compact-grid">
          <div className="status-compact-line">
            {dot(health?.backend)} <span>Backend</span>
            {dot(health?.ollama)} <span>AI</span>
          </div>
          <div className="status-compact-line">
            {dot(health?.validatore)} <span>Validatore</span>
            {dot(health?.rdf)} <span>RDF</span>
          </div>
        </div>
        <button className="refresh-btn-compact" onClick={onRefresh} title="Aggiorna stato">↻</button>
      </div>
    );
  }

  return (
    <div className="status-bar">
      <div className="status-row">{dot(health?.backend)} <span>Backend</span></div>
      <div className="status-row">{dot(health?.ollama)} <span>AI</span></div>
      <div className="status-row">{dot(health?.validatore)} <span>Validatore</span></div>
      <div className="status-row">{dot(health?.rdf)} <span>RDF</span></div>
      <button className="refresh-btn" onClick={onRefresh} title="Aggiorna stato">↻</button>
    </div>
  );
}
