import { useState } from "react";

const SPARQL = "https://lod.dati.gov.it/sparql";
const FT_BASE = "http://publications.europa.eu/resource/authority/file-type/";
const CSV_FORMATS = new Set(["CSV","TSV","XLSX","XLS","ODS"]);

async function sparql(query) {
  const url = `${SPARQL}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
  const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error(`SPARQL ${r.status}`);
  return (await r.json()).results.bindings;
}

function val(b, k) { return b[k]?.value || ""; }

function fmtLabel(uri) {
  if (!uri) return "";
  return uri.replace(FT_BASE, "").replace(/_/g, " ");
}

async function loadDistributions(datasetUri) {
  const rows = await sparql(
    `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?distTitle ?format ?accessURL ?downloadURL WHERE {
  BIND(<${datasetUri}> AS ?d)
  ?d dcat:distribution ?dist .
  OPTIONAL { ?dist dct:title ?distTitle }
  OPTIONAL { ?dist dct:format ?format }
  OPTIONAL { ?dist dcat:accessURL ?accessURL }
  OPTIONAL { ?dist dct:downloadURL ?downloadURL }
} LIMIT 30`
  );

  const seen = new Map();
  rows.forEach(r => {
    const url = val(r, "downloadURL") || val(r, "accessURL");
    if (url && !seen.has(url)) {
      const fmt = fmtLabel(val(r, "format")).toUpperCase();
      seen.set(url, {
        name:   val(r, "distTitle") || fmt || "Risorsa",
        format: fmt,
        url,
      });
    }
  });
  return [...seen.values()];
}

export default function DatasetCard({ dataset, onValidate }) {
  const [distributions, setDistributions] = useState(null); // null = non caricato
  const [loading, setLoading]             = useState(false);
  const [expanded, setExpanded]           = useState(false);
  const [showAll, setShowAll]             = useState(false);

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && distributions === null) {
      setLoading(true);
      try {
        const dists = await loadDistributions(dataset.uri);
        setDistributions(dists);
      } catch {
        setDistributions([]);
      }
      setLoading(false);
    }
  }

  const desc = dataset.description
    ? dataset.description.slice(0, 200) + (dataset.description.length > 200 ? "…" : "")
    : "";

  const csvDists = (distributions || []).filter(d => CSV_FORMATS.has(d.format));
  const otherDists = (distributions || []).filter(d => !CSV_FORMATS.has(d.format));

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
          {loading && <span className="loading-small">⏳ Carico distribuzioni...</span>}

          {!loading && distributions !== null && distributions.length === 0 && (
            <span className="no-csv">Nessuna distribuzione trovata</span>
          )}

          {/* Risorse CSV — con bottone Valida */}
          {csvDists.map((d, i) => (
            <div key={i} className="csv-resource">
              <span className="csv-name">📄 {d.name} <span className="fmt-badge">{d.format}</span></span>
              <div className="csv-actions">
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                  ⬇ Scarica
                </a>
                <button className="btn-small btn-validate" onClick={() => onValidate(d.url, dataset.title)}>
                  ✅ Valida
                </button>
              </div>
            </div>
          ))}

          {/* Altre distribuzioni */}
          {otherDists.length > 0 && (
            <>
              <button className="show-all-btn" onClick={() => setShowAll(v => !v)}>
                {showAll ? "▲ Nascondi" : `▼ Altre distribuzioni (${otherDists.length})`}
              </button>
              {showAll && otherDists.map((d, i) => (
                <div key={i} className="csv-resource">
                  <span className="csv-name">📎 {d.name} {d.format && <span className="fmt-badge">{d.format}</span>}</span>
                  <div className="csv-actions">
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                      ↗ Apri
                    </a>
                  </div>
                </div>
              ))}
            </>
          )}
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
