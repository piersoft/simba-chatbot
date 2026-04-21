import Icon from "./Icon";
import { useState } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";
const FT_BASE     = "http://publications.europa.eu/resource/authority/file-type/";

function val(b, k) {
  const v = b[k]?.value || "";
  let url = v.replace(/&amp;/g, "&").replace(/&#38;/g, "&");
  // Virtuoso rimuove i & dagli URL — ricostruisce i parametri noti Google Sheets
  if (url.includes("?") && !url.includes("&")) {
    const [base, qs] = url.split("?");
    const fixed = qs
      .replace(/(gid=\d+)(single=)/, "$1&$2")
      .replace(/(single=(?:true|false))(output=)/, "$1&$2")
      .replace(/(output=[^&]+)(format=)/, "$1&$2");
    url = base + "?" + fixed;
  }
  return url;
}

function fmtLabel(uri) { return uri ? uri.replace(FT_BASE,"").replace(/_/g," ") : ""; }

const SPARQL_URL = "https://lod.dati.gov.it/sparql";

async function sparql(query) {
  const url = `${SPARQL_URL}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
  const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error(`SPARQL ${r.status}`);
  const data = await r.json();
  return data.results.bindings;
}

async function loadDistributions(dUri) {
  const rows = await sparql(
`PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
SELECT ?distTitle ?format ?accessURL ?downloadURL WHERE {
  <${dUri}> dcat:distribution ?dist .
  OPTIONAL { ?dist dct:title ?distTitle }
  OPTIONAL { ?dist dct:format ?format }
  OPTIONAL { ?dist dcat:accessURL ?accessURL }
  OPTIONAL { ?dist dcat:downloadURL ?downloadURL }
} LIMIT 30`
  );

  const distMap = new Map();
  rows.forEach(r => {
    const accessURL   = val(r, "accessURL");
    const downloadURL = val(r, "downloadURL") || val(r, "downloadURL2");
    const fileUrl = downloadURL || accessURL;
    const key = fileUrl;
    if (key && !distMap.has(key)) {
      distMap.set(key, {
        title:      val(r, "distTitle") || fmtLabel(val(r, "format")) || "Risorsa",
        format:     fmtLabel(val(r, "format")).toUpperCase(),
        url:        fileUrl,
        downloadURL: fileUrl,
      });
    }
  });
  return [...distMap.values()];
}

const CSV_FMTS = new Set(["CSV","TSV"]);

// Evidenzia i termini cercati nel testo
function highlight(text, terms) {
  if (!text || !terms || terms.length === 0) return text;
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(re);
  const reTest = new RegExp(`^(${escaped.join("|")})$`, "i");
  return parts.map((part, i) =>
    reTest.test(part) ? <mark key={i} style={{background:"#fff176",borderRadius:2,padding:"0 1px"}}>{part}</mark> : part
  );
}

export default function DatasetCard({ dataset, onValidate, onEnrich, searchTerms = [] }) {
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
    ? dataset.description.slice(0, 400) + (dataset.description.length > 400 ? "…" : "")
    : "";

  const csvDists   = (distributions || []).filter(d => CSV_FMTS.has(d.format));
  const otherDists = (distributions || []).filter(d => !CSV_FMTS.has(d.format));

  return (
    <article className="dataset-card" aria-label={dataset.title}>
      <div className="dataset-card-header" onClick={toggleExpand} role="button" tabIndex={0} aria-expanded={expanded} aria-label={`${expanded ? "Nascondi" : "Espandi"} risorse: ${dataset.title}`} onKeyDown={e => e.key === "Enter" && toggleExpand()}>
        <div className="dataset-card-title">
          <a href={dataset.viewUrl} target="_blank" rel="noopener noreferrer" aria-label={`Apri dataset: ${dataset.title}`}
             onClick={e => e.stopPropagation()}>
            {searchTerms.length > 0 ? highlight(dataset.title, searchTerms) : dataset.title}
          </a>
        </div>
        <span className="dataset-card-toggle" aria-hidden="true">
          {expanded
            ? <><i className="bi bi-chevron-up"/> Nascondi risorse</>
            : <><i className="bi bi-chevron-down"/> Vedi risorse</>
          }
        </span>
      </div>

      <div className="dataset-card-meta">
        {dataset.publisher && (
          <span className="dataset-org">
            <i className="bi bi-pin-map-fill" style={{fontSize:"11px"}}/> {dataset.publisher}
          </span>
        )}
        {dataset.catalogLabel && (
          <span className="dataset-catalog-tag" title={dataset.catalogUri}>
            <i className="bi bi-collection" style={{fontSize:"11px"}}/> {dataset.catalogLabel}
          </span>
        )}
        {dataset.modified && <span className="dataset-tag">{dataset.modified}</span>}
        {dataset.modInvalid && (
          <span className="dataset-tag-warn" title={`Data anomala nel catalogo: ${dataset.modifiedRaw}`}>
            ⚠️ data non affidabile
          </span>
        )}
      </div>

      {desc && <p className="dataset-card-desc">{searchTerms.length > 0 ? highlight(desc, searchTerms) : desc}</p>}

      {dataset.keywords && dataset.keywords.length > 0 && (
        <div className="dataset-keywords">
          {dataset.keywords.map((k,i) => {
            const kLower = k.toLowerCase().replace(/-/g," ");
            const isMatch = searchTerms.some(t => kLower.includes(t.toLowerCase()) || t.toLowerCase().includes(kLower));
            return (
              <span key={i} className={`dataset-kw-tag${isMatch ? " dataset-kw-match" : ""}`}>{k}</span>
            );
          })}
        </div>
      )}
      {expanded && (
        <div className="dataset-card-resources">
          {loading && <span className="loading-small">Carico distribuzioni...</span>}

          {!loading && distributions !== null && distributions.length === 0 && (
            <span className="no-csv">Nessuna distribuzione trovata</span>
          )}

          {csvDists.map((d, i) => (
            <div key={i} className="csv-resource">
              <span className="csv-name">
                {d.title}
                {d.format && <span className="fmt-badge">{d.format}</span>}
              </span>
              <div className="csv-actions">
                <a href={d.downloadURL} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                  <Icon name="download" size={13} /> Scarica
                </a>
                <button className="btn-small btn-validate" onClick={() => onValidate(d.downloadURL, dataset.title, dataset.publisher, dataset.uri, dataset.description || "")}>
                  <Icon name="check2-circle" size={13} /> Valida
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
                    {d.title}
                    {d.format && <span className="fmt-badge">{d.format}</span>}
                  </span>
                  <div className="csv-actions">
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
                      <Icon name="box-arrow-up-right" size={13} /> Apri
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
          <Icon name="box-arrow-up-right" size={13} /> Apri dataset
        </a>
      </div>
    </article>
  );
}
