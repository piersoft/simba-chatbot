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

// ── Anteprima CSV ────────────────────────────────────────────────────────────
// Indipendente da CKAN/datastore: dato un downloadURL prova a leggerlo,
// auto-detect separatore, mostra prime 10 righe. Su HTTPS->HTTP o CORS
// fallisce silenziosamente offrendo "Apri direttamente".

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const first = lines[0];
  const counts = {
    ";": (first.match(/;/g) || []).length,
    ",": (first.match(/,/g) || []).length,
    "\t": (first.match(/\t/g) || []).length,
  };
  let sep = ";", max = 0;
  for (const k of Object.keys(counts)) if (counts[k] > max) { max = counts[k]; sep = k; }

  return lines.map(line => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') q = !q;
      else if (c === sep && !q) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  });
}

function CsvPreview({ url, format }) {
  const [state, setState] = useState({ status: "idle" });

  // TSV: forza tab come separatore preferito (l'auto-detect lo trova comunque,
  // ma evita falsi positivi su righe con virgole interne)
  const isTsv = format === "TSV";

  async function load() {
    setState({ status: "loading" });

    // Mixed content guard: pagina HTTPS -> URL HTTP è bloccato dal browser
    // prima della fetch. Diamo subito il fallback.
    if (typeof window !== "undefined"
        && window.location.protocol === "https:"
        && url.startsWith("http:")) {
      setState({ status: "error", message: "risorsa HTTP non leggibile da pagina HTTPS" });
      return;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${BACKEND_URL}/api/preview-csv?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      clearTimeout(t);

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html") || ct.includes("application/xhtml")) {
        throw new Error("il server ha restituito una pagina HTML");
      }

      // Il proxy backend risponde con JSON {headers, rows, totalRows}
      const data = await r.json();
      if (!data.headers || !data.rows) throw new Error("file vuoto o non parsabile");
      setState({
        status: "ok",
        headers: data.headers,
        rows: data.rows,
        total: data.totalRows,
      });
    } catch (e) {
      let msg = "anteprima non disponibile";
      if (e.name === "AbortError") msg = "timeout (file troppo grande o server lento)";
      else if (e.message?.includes("HTTP")) msg = e.message;
      else if (e.message?.includes("HTML")) msg = "il publisher ha restituito HTML invece del CSV";
      else if (e.message?.includes("Failed to fetch")) msg = "CORS bloccato dal publisher";
      else if (e.message?.includes("vuoto")) msg = "file vuoto o non parsabile";
      setState({ status: "error", message: msg });
    }
  }

  function close() { setState({ status: "idle" }); }

  if (state.status === "idle") {
    return (
      <button className="btn-small btn-preview" onClick={load} title="Mostra le prime righe del CSV">
        <Icon name="eye" size={13} /> Anteprima
      </button>
    );
  }

  if (state.status === "loading") {
    return (
      <button className="btn-small btn-preview" disabled>
        <Icon name="hourglass-split" size={13} /> Caricamento…
      </button>
    );
  }

  if (state.status === "error") {
    return (
      <button className="btn-small btn-preview btn-preview-err" onClick={close}
              title={state.message}>
        <Icon name="exclamation-triangle" size={13} /> {state.message} (chiudi)
      </button>
    );
  }

  // status === "ok"
  return (
    <button className="btn-small btn-preview btn-preview-active" onClick={close}>
      <Icon name="x-circle" size={13} /> Chiudi anteprima
    </button>
  );
}

function CsvPreviewTable({ data }) {
  if (!data || data.status !== "ok") return null;
  const cols = data.headers.slice(0, 10);
  return (
    <div className="csv-preview-box">
      <div className="csv-preview-header">
        <Icon name="table" size={12} /> Prime {data.rows.length} righe su {data.total.toLocaleString("it")} totali
      </div>
      <div className="csv-preview-scroll">
        <table className="csv-preview-table">
          <thead>
            <tr>{cols.map((h, i) => <th key={i}>{String(h).slice(0, 30)}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>
                {cols.map((_, j) => {
                  const v = r[j] !== undefined && r[j] !== null ? String(r[j]) : "";
                  return <td key={j} title={v}>{v.slice(0, 60)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Wrapper che gestisce il toggle button + tabella in modo che la tabella
// resti renderizzata sotto la riga della risorsa
function CsvResourceRow({ d, onValidate, dataset }) {
  const [previewData, setPreviewData] = useState(null);

  return (
    <>
      <div className="csv-resource">
        <span className="csv-name">
          {d.title}
          {d.format && <span className="fmt-badge">{d.format}</span>}
        </span>
        <div className="csv-actions">
          <a href={d.downloadURL} target="_blank" rel="noopener noreferrer" className="btn-small btn-download">
            <Icon name="download" size={13} /> Scarica
          </a>
          <CsvPreviewControlled
            url={d.downloadURL}
            format={d.format}
            onChange={setPreviewData}
          />
          <button className="btn-small btn-validate" onClick={() => onValidate(d.downloadURL, dataset.title, dataset.publisher, dataset.uri, dataset.description || "")}>
            <Icon name="check2-circle" size={13} /> Valida
          </button>
        </div>
      </div>
      <CsvPreviewTable data={previewData} />
    </>
  );
}

// Variante di CsvPreview che esfiltra i dati al parent così la tabella
// può vivere fuori dalla riga azioni
function CsvPreviewControlled({ url, format, onChange }) {
  const [state, setState] = useState({ status: "idle" });
  const isTsv = format === "TSV";

  async function load() {
    setState({ status: "loading" });
    onChange(null);

    if (typeof window !== "undefined"
        && window.location.protocol === "https:"
        && url.startsWith("http:")) {
      setState({ status: "error", message: "risorsa HTTP non leggibile da HTTPS" });
      return;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${BACKEND_URL}/api/preview-csv?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
      clearTimeout(t);

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html") || ct.includes("application/xhtml")) {
        throw new Error("il server ha restituito HTML");
      }

      const text = await r.text();
      let rows = parseCSV(text);
      if (isTsv && rows[0] && rows[0].length === 1 && text.includes("\t")) {
        rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split("\t").map(c => c.trim()));
      }
      if (rows.length < 2) throw new Error("vuoto");

      const ok = {
        status: "ok",
        headers: rows[0],
        rows: rows.slice(1, 11),
        total: rows.length - 1,
      };
      setState(ok);
      onChange(ok);
    } catch (e) {
      let msg = "anteprima non disponibile";
      if (e.name === "AbortError") msg = "timeout";
      else if (e.message?.includes("HTTP ")) msg = e.message;
      else if (e.message?.includes("HTML")) msg = "publisher ha risposto HTML";
      else if (e.message?.includes("Failed to fetch")) msg = "CORS bloccato";
      else if (e.message?.includes("vuoto")) msg = "file vuoto";
      setState({ status: "error", message: msg });
      onChange(null);
    }
  }

  function close() {
    setState({ status: "idle" });
    onChange(null);
  }

  if (state.status === "idle") {
    return (
      <button className="btn-small btn-preview" onClick={load} title="Mostra le prime righe del CSV">
        <Icon name="eye" size={13} /> Anteprima
      </button>
    );
  }
  if (state.status === "loading") {
    return <button className="btn-small btn-preview" disabled><Icon name="hourglass-split" size={13} /> …</button>;
  }
  if (state.status === "error") {
    return (
      <button className="btn-small btn-preview btn-preview-err" onClick={close} title={state.message}>
        <Icon name="exclamation-triangle" size={13} /> {state.message}
      </button>
    );
  }
  return (
    <button className="btn-small btn-preview btn-preview-active" onClick={close}>
      <Icon name="x-circle" size={13} /> Chiudi
    </button>
  );
}

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
            <CsvResourceRow key={i} d={d} onValidate={onValidate} dataset={dataset} />
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
