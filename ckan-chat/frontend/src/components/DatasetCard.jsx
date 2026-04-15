import { useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";

export default function DatasetCard({ dataset, onValidate }) {
  const [csvResources, setCsvResources] = useState(dataset.csvResources ?? []);
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function loadResources() {
    if (csvResources.length > 0 || loadingCsv) return;
    setLoadingCsv(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/resources/${dataset.id}`);
      const data = await r.json();
      setCsvResources(data.csvResources ?? []);
    } catch {}
    setLoadingCsv(false);
  }

  function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next) loadResources();
  }

  const desc = dataset.description
    ? dataset.description.slice(0, 180) + (dataset.description.length > 180 ? "…" : "")
    : "";

  return (
    <div className="dataset-card">
      <div className="dataset-card-header" onClick={toggleExpand}>
        <div className="dataset-card-title">
          <a href={dataset.viewUrl} target="_blank" rel="noopener noreferrer"
             onClick={e => e.stopPropagation()}>
            {dataset.title}
          </a>
        </div>
        <span className="dataset-card-toggle">{expanded ? "▲" : "▼"}</span>
      </div>

      <div className="dataset-card-meta">
        {dataset.publisher && <span className="dataset-tag">🏛 {dataset.publisher}</span>}
        {dataset.modified  && <span className="dataset-tag">📅 {dataset.modified}</span>}
      </div>

      {desc && <p className="dataset-card-desc">{desc}</p>}

      {expanded && (
        <div className="dataset-card-resources">
          {loadingCsv && <span className="loading-small">Carico risorse CSV...</span>}
          {!loadingCsv && csvResources.length === 0 && (
            <span className="no-csv">Nessuna risorsa CSV trovata</span>
          )}
          {csvResources.map((r, i) => (
            <div key={i} className="csv-resource">
              <span className="csv-name">📄 {r.name || "CSV"}</span>
              <div className="csv-actions">
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                  ⬇ Scarica
                </a>
                <button className="btn-small btn-validate" onClick={() => onValidate(r.url, dataset.title)}>
                  ✅ Valida
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="dataset-card-footer">
        <a href={dataset.viewUrl} target="_blank" rel="noopener noreferrer" className="btn-small btn-view">
          🔗 Apri dataset
        </a>
      </div>
    </div>
  );
}
