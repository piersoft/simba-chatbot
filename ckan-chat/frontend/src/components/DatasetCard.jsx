import { useState } from "react";

const SPARQL_URL = "https://lod.dati.gov.it/sparql";
const FT_BASE    = "http://publications.europa.eu/resource/authority/file-type/";

function val(b, k) { return b[k]?.value || ""; }
function fmtLabel(uri) { return uri ? uri.replace(FT_BASE,"").replace(/_/g," ") : ""; }

async function sparql(query) {
  const url = `${SPARQL_URL}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
  const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error(`SPARQL ${r.status}`);
  return (await r.json()).results.bindings;
}

// Query identica a showDataset dell'assistente ckan-opendata-assistant
// dUri = URI completo del dataset (es. https://dati.gov.it/resource/Dataset/...)
async function loadDistributions(dUri) {
  const rows = await sparql(
`PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?distTitle ?format ?accessURL ?downloadURL ?resourceId WHERE {
  BIND(<${dUri}> AS ?d)
  OPTIONAL {
    ?d dcat:distribution ?dist .
    OPTIONAL { ?dist dct:title ?distTitle }
    OPTIONAL { ?dist dct:format ?format }
    OPTIONAL { ?dist dcat:accessURL ?accessURL }
    OPTIONAL { ?dist dct:downloadURL ?downloadURL }
    OPTIONAL { ?dist dct:identifier ?resourceId }
  }
} LIMIT 30`
  );

  const distMap = new Map();
  rows.forEach(r => {
    const accessURL   = val(r, "accessURL");
    const downloadURL = val(r, "downloadURL");
    // Priorità a downloadURL (file diretto) — accessURL è spesso pagina HTML
    const fileUrl = downloadURL || accessURL;
    const key = fileUrl;
    if (key && !distMap.has(key)) {
      distMap.set(key, {
        title:      val(r, "distTitle") || fmtLabel(val(r, "format")) || "Risorsa",
        format:     fmtLabel(val(r, "format")).toUpperCase(),
        url:        fileUrl,
        downloadURL: fileUrl,
        resourceId: val(r, "resourceId"),
      });
    }
  });
  return [...distMap.values()];
}

const CSV_FMTS = new Set(["CSV","TSV"]);

export default function DatasetCard({ dataset, onValidate, onEnrich }) {
  const [distributions, setDistributions] = useState(null);
  const [loading, setLoading]             = useState(false);
  const [expanded, setExpanded]           = useState(false);
  const [showOther, setShowOther]         = useState(false);

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && distributions === null) {
      setLoading(true);
      try {
        setDistributions(await loadDistributions(dataset.uri));
      } catch(e) {
        console.error("loadDistributions error:", e);
        setDistributions([]);
      }
      setLoading(false);
    }
  }

  const desc = dataset.description
    ? dataset.description.slice(0, 200) + (dataset.description.length > 200 ? "…" : "")
    : "";

  const csvDists   = (distributions || []).filter(d => CSV_FMTS.has(d.format));
  const otherDists = (distributions || []).filter(d => !CSV_FMTS.has(d.format));

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

          {csvDists.map((d, i) => (
            <div key={i} className="csv-resource">
              <span className="csv-name">
                📄 {d.title}
                {d.format && <span className="fmt-badge">{d.format}</span>}
              </span>
              <div className="csv-actions">
                <a href={d.downloadURL} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                  ⬇ Scarica
                </a>
                <button className="btn-small btn-validate" onClick={() => onValidate(d.downloadURL, dataset.title)}>
                  ✅ Valida
                </button>
              </div>
            </div>
          ))}

          {otherDists.length > 0 && (
            <>
              <button className="show-all-btn" onClick={() => setShowOther(v => !v)}>
                {showOther ? "▲ Nascondi altre" : `▼ Altre distribuzioni (${otherDists.length})`}
              </button>
              {showOther && otherDists.map((d, i) => (
                <div key={i} className="csv-resource">
                  <span className="csv-name">
                    📎 {d.title}
                    {d.format && <span className="fmt-badge">{d.format}</span>}
                  </span>
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
