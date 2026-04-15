import { useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";
const FT_BASE     = "http://publications.europa.eu/resource/authority/file-type/";

function val(b, k) {
  const v = b[k]?.value || "";
  return v.replace(/&amp;/g, "&");
}

function fmtLabel(uri) { return uri ? uri.replace(FT_BASE,"").replace(/_/g," ") : ""; }

// Proxy backend — il backend scarica da lod.dati.gov.it e restituisce JSON pulito
// I & nei downloadURL vengono preservati perché non passano per un URL del browser
async function sparql(query) {
  const r = await fetch(`${BACKEND_URL}/api/sparql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SPARQL proxy ${r.status}`);
  return (await r.json()).results.bindings;
}

async function loadDistributions(dUri) {
  const rows = await sparql(
`PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?distTitle ?format (STR(?aURL) AS ?accessURL) (STR(?dURL) AS ?downloadURL) ?resourceId WHERE {
  BIND(<${dUri}> AS ?d)
  OPTIONAL {
    ?d dcat:distribution ?dist .
    OPTIONAL { ?dist dct:title ?distTitle }
    OPTIONAL { ?dist dct:format ?format }
    OPTIONAL { ?dist dcat:accessURL ?aURL }
    OPTIONAL { ?dist dcat:downloadURL ?dURL }
    OPTIONAL { ?dist dct:identifier ?resourceId }
  }
} LIMIT 30`
  );

  const distMap = new Map();
  rows.forEach(r => {
    const accessURL   = val(r, "accessURL");
    const downloadURL = val(r, "downloadURL");
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
                {onEnrich && (
                  <button className="btn-small btn-ttl" onClick={() => onEnrich(d.downloadURL, dataset.title)}>
                    🔄 TTL
                  </button>
                )}
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
