import { useState, useRef, useEffect } from "react";

const SPARQL_EP = import.meta.env.VITE_SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";

// Sanitizza input utente per SPARQL — rimuove caratteri pericolosi
function sanitizeSparql(s) {
  return (s || "")
    .replace(/["{}<>\\|^`]/g, "")  // rimuove caratteri SPARQL pericolosi
    .slice(0, 200);                   // limite lunghezza
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";
const THEME_BASE = "http://publications.europa.eu/resource/authority/data-theme/";
const HVD_BASE   = "http://data.europa.eu/bna/";
const FT_BASE    = "http://publications.europa.eu/resource/authority/file-type/";
const LICENSE_MAP = {
  CC_BY:   ["https://creativecommons.org/licenses/by/4.0/","http://creativecommons.org/licenses/by/4.0/","http://creativecommons.org/licenses/by/4.0/it/"],
  CC_ZERO: ["https://creativecommons.org/publicdomain/zero/1.0/","http://creativecommons.org/publicdomain/zero/1.0/"],
  IODL:    ["https://www.dati.gov.it/content/italian-open-data-license-v20"],
  CC_BYSA: ["https://creativecommons.org/licenses/by-sa/4.0/"],
};

const THEMES = [
  { code:"AGRI", label:"Agricoltura" },
  { code:"ECON", label:"Economia" },
  { code:"EDUC", label:"Istruzione" },
  { code:"ENER", label:"Energia" },
  { code:"ENVI", label:"Ambiente" },
  { code:"GOVE", label:"Governo" },
  { code:"HEAL", label:"Salute" },
  { code:"INTR", label:"Relazioni int." },
  { code:"JUST", label:"Giustizia" },
  { code:"REGI", label:"Regioni" },
  { code:"SOCI", label:"Società" },
  { code:"TECH", label:"Tecnologia" },
  { code:"TRAN", label:"Trasporti" },
];

const HVD_CATS = [
  { code:"c_ac64a52d", label:"Geospaziali" },
  { code:"c_dd313021", label:"Terra e Ambiente" },
  { code:"c_e1da4e07", label:"Statistici" },
  { code:"c_164e0bf5", label:"Meteorologici" },
  { code:"c_b79e35eb", label:"Mobilità" },
  { code:"c_a9135398", label:"Imprese" },
];

const FORMATS = ["CSV","JSON","XML","SHP","GEOJSON","RDF_XML","TURTLE","PDF","XLSX","ZIP","WMS","WFS"];
const FETCH_SIZE = 32;

async function sparqlFetch(query) {
  // Prima prova diretta dal browser
  try {
    const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
    const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
    if (rd.ok) return (await rd.json()).results.bindings;
  } catch {}
  // Fallback: proxy backend
  const r = await fetch(`${BACKEND_URL}/api/sparql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SPARQL ${r.status}`);
  return (await r.json()).results.bindings;
}

function val(b, k) { return b[k]?.value || ""; }

function kwFilter(words) {
  // Cerca in titolo + descrizione + keyword (massima copertura)
  return words.map((w, i) => {
    const wl = sanitizeSparql(w.toLowerCase());
    return `(CONTAINS(LCASE(?title),"${wl}")||CONTAINS(LCASE(STR(?description)),"${wl}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?kw${i} . FILTER(CONTAINS(LCASE(STR(?kw${i})),"${wl}")) })`;
  }).join(" && ");
}

// Post-filter: mantieni solo dataset dove tutti i termini appaiono in titolo, desc o keyword
function postFilterAdv(datasets, q) {
  if (!q || !q.trim()) return datasets;
  const words = q.trim().toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return datasets;
  return datasets.filter(d => {
    const haystack = [
      (d.title || ""),
      (d.description || ""),
      ...((d.keywords || []))
    ].join(" ").toLowerCase();
    return words.every(w => haystack.includes(w));
  });
}

function buildAdvQuery(q, theme, hvd, pub, format, license, sort, offset) {
  let triples = "  ?d a dcat:Dataset . ?d dct:title ?title .\n";
  if (theme)   triples += `  ?d <http://www.w3.org/ns/dcat#theme> <${THEME_BASE}${theme}> .\n`;
  if (hvd)     triples += `  ?d <http://data.europa.eu/r5r/hvdCategory> <${HVD_BASE}${hvd}> .\n`;
  if (format)  triples += `  ?d <http://www.w3.org/ns/dcat#distribution> ?distFmt . ?distFmt <http://purl.org/dc/terms/format> <${FT_BASE}${format}> .\n`;
  if (license) {
    const uris = (LICENSE_MAP[license] || []).map(u => `<${u}>`).join(" ");
    if (uris) triples += `  ?d <http://www.w3.org/ns/dcat#distribution> ?distLic . ?distLic <http://purl.org/dc/terms/license> ?lic . VALUES ?lic { ${uris} }\n`;
  }
  if (pub) triples += "  ?d <http://purl.org/dc/terms/rightsHolder> ?rh . ?rh <http://xmlns.com/foaf/0.1/name> ?rhName .\n  OPTIONAL { ?rh <http://purl.org/dc/terms/identifier> ?ipaCode }\n";

  let filters = "  FILTER(LANG(?title)='it'||LANG(?title)='')\n";
  if (q)   filters += `  FILTER(${kwFilter(q.trim().split(/\s+/))})\n`;
  if (pub) filters += `  FILTER(CONTAINS(LCASE(STR(?rhName)),"${pub.toLowerCase().replace(/"/g,"")}"))\n`;

  const orderBy = sort === "title" ? "?title" : "DESC(?modified)";
  // Se non c'è già il rightsHolder nei triples (filtro per pub), lo aggiungiamo come OPTIONAL
  const rhOptional = pub ? "" : "  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName . OPTIONAL { ?rh dct:identifier ?ipaCode } }\n";
  return `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?d ?title ?description ?modified ?rhName ?ipaCode ?landingPage WHERE {
${triples}${rhOptional}  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
${filters}} ORDER BY ${orderBy} LIMIT ${FETCH_SIZE} OFFSET ${offset}`;
}

// Carica lista cataloghi (una sola volta) ordinati per numero dataset
async function loadCatalogs() {
  const q = `SELECT ?catalog (COUNT(?s) AS ?count) WHERE {
  ?catalog <http://www.w3.org/ns/dcat#dataset> ?s .
} GROUP BY ?catalog ORDER BY DESC(?count) LIMIT 500`;
  // Tenta prima dal browser, poi proxy backend
  const SPARQL_EP = import.meta.env.VITE_SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";
  try {
    const url = `${SPARQL_EP}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`;
    const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
    if (r.ok) {
      const data = await r.json();
      const rows = data.results?.bindings ?? [];
      return rows.map(r => ({
        uri:   r.catalog?.value || "",
        label: (r.catalog?.value || "").replace(/https?:\/\//, "").replace(/\/$/, ""),
        count: parseInt(r.count?.value || "0"),
      })).filter(c => c.uri);
    }
  } catch {}
  // Fallback proxy
  const rows = await sparqlFetch(q);
  return rows.map(r => ({
    uri:   r.catalog?.value || "",
    label: (r.catalog?.value || "").replace(/https?:\/\//, "").replace(/\/$/, ""),
    count: parseInt(r.count?.value || "0"),
  })).filter(c => c.uri);
}

// Query dataset per catalogo specifico — usa EXISTS per evitare timeout
function buildCatalogQuery(catalogUri, q, offset, format) {
  const kwF = q?.trim()
    ? `  FILTER(${q.trim().split(/\s+/).map((w,i) => {
        const wl = w.toLowerCase().replace(/"/g,"");
        return `(CONTAINS(LCASE(?title),"${wl}")||CONTAINS(LCASE(STR(?description)),"${wl}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?kw${i} . FILTER(CONTAINS(LCASE(STR(?kw${i})),"${wl}")) })`;
      }).join(" && ")})
`
    : "";
  return `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?d ?title ?description ?modified ?rhName ?landingPage WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  FILTER(EXISTS { <${catalogUri}> dcat:dataset ?d })
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d dcat:landingPage ?landingPage }
  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }
${kwF}} ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${offset}`;
}

// Autocomplete rightsHolder — query SPARQL live con CONTAINS (come sidebar originale)
async function searchRightsHolder(q) {
  const ql = sanitizeSparql(q.toLowerCase());
  const query = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name (COUNT(DISTINCT ?d) AS ?count) WHERE {
  ?d a dcat:Dataset .
  ?d dct:rightsHolder ?rh .
  ?rh foaf:name ?name .
  FILTER(CONTAINS(LCASE(STR(?name)),"${ql}"))
} GROUP BY ?name ORDER BY DESC(?count) LIMIT 20`;
  const SPARQL_EP = import.meta.env.VITE_SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";
  let rows = [];
  try {
    const url = `${SPARQL_EP}?query=${encodeURIComponent(query)}&format=${encodeURIComponent("application/sparql-results+json")}`;
    const r = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
    if (r.ok) rows = (await r.json()).results?.bindings ?? [];
  } catch {}
  if (!rows.length) rows = await sparqlFetch(query);
  const seen = new Set();
  return rows
    .map(r => ({ name: val(r, "name").trim(), count: parseInt(val(r, "count") || "0") }))
    .filter(m => { const k = m.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export default function AdvancedSearch({ onResults, onLoading, onLoadingMsg, onResetRef }) {
  const [open,    setOpen]    = useState(false);
  const [q,       setQ]       = useState("");
  const [theme,   setTheme]   = useState("");
  const [hvd,     setHvd]     = useState("");
  const [rh,      setRh]      = useState("");
  const [format,  setFormat]  = useState("");
  const [license, setLicense] = useState("");
  const [sort,    setSort]    = useState("modified");
  const [acList,  setAcList]  = useState([]);
  const [showAc,  setShowAc]  = useState(false);
  const [catalog,    setCatalog]    = useState("");       // URI catalogo selezionato
  const [catInput,   setCatInput]   = useState("");       // testo nel campo catalogo
  const [catList,    setCatList]    = useState([]);       // lista completa cataloghi
  const [catLoading, setCatLoading] = useState(false);   // caricamento lista
  const [showCat,    setShowCat]    = useState(false);   // dropdown catalogo aperto
  const [catLoaded,  setCatLoaded]  = useState(false);   // già caricata

  // Esponi funzione reset al genitore
  if (onResetRef) {
    onResetRef.current = () => {
      setQ(""); setTheme(""); setHvd(""); setRh(""); setFormat("");
      setLicense(""); setSort("modified"); setCatalog(""); setCatInput("");
      setRhInput(""); setOpen(false);
    };
  }
  const acTimer = useRef(null);

  async function handleCatFocus() {
    if (catLoaded) { setShowCat(true); return; }
    setCatLoading(true);
    try {
      const cats = await loadCatalogs();
      setCatList(cats);
      setCatLoaded(true);
      setShowCat(true);
    } catch {}
    setCatLoading(false);
  }

  function handleCatInput(v) {
    setCatInput(v);
    setCatalog(""); // deseleziona se si modifica
    if (!catLoaded) return;
    setShowCat(true);
  }

  function selectCatalog(cat) {
    setCatalog(cat.uri);
    setCatInput(`${cat.label} (${cat.count.toLocaleString("it")} ds)`);
    setShowCat(false);
  }

  const filteredCats = catList.filter(c =>
    !catInput || catalog || c.label.toLowerCase().includes(catInput.toLowerCase())
  ).slice(0, 15);

  async function handlePubInput(v) {
    setRh(v);
    clearTimeout(acTimer.current);
    if (v.length < 2) { setShowAc(false); return; }
    acTimer.current = setTimeout(async () => {
      try {
        const matches = await searchRightsHolder(v);
        setAcList(matches);
        setShowAc(matches.length > 0);
      } catch {}
    }, 350);
  }

  async function doSearch(offset = 0) {
    const effectiveQ = (q === "*") ? "" : q; // * equivale a nessun filtro keyword
    setOpen(false);
    const label = [effectiveQ||"*", theme && THEMES.find(t=>t.code===theme)?.label, rh, catalog && catInput.split(" (")[0]].filter(Boolean).join(" · ") || "Ricerca avanzata";
    if (onLoadingMsg) onLoadingMsg(true, label);
    onLoading(true);
    try {
      const rows = await sparqlFetch(
        catalog
          ? buildCatalogQuery(catalog, effectiveQ, offset, format)
          : buildAdvQuery(effectiveQ, theme, hvd, rh, format, license, sort, offset)
      );
      const seen = new Map();
      for (const b of rows) {
        const uri = val(b, "d");
        if (!uri || seen.has(uri)) continue;
        const id = uri.split("/").pop();
        const landingPage = val(b, "landingPage");
        const viewUrl = landingPage || `https://www.dati.gov.it/view-dataset/dataset?id=${id}`;
        const modRaw = val(b, "modified").slice(0, 10);
        // Rileva date anomale (anno > anno corrente + 1)
        const modYear = modRaw ? parseInt(modRaw.slice(0,4)) : 0;
        const modInvalid = modYear > new Date().getFullYear() + 1 || modYear < 1990;
        seen.set(uri, {
          uri, id,
          title:        val(b, "title"),
          description:  val(b, "description"),
          modified:     modInvalid ? "" : modRaw,
          modifiedRaw:  modRaw,
          modInvalid,
          rightsHolder: val(b, "rhName") || (rh || ""),
          publisher:    val(b, "rhName") || (rh || ""),
          ipaCode:      (() => {
            const v = val(b, "ipaCode");
            if (/^\d{11}$/.test(v)) return "";
            if (v.length > 30) return "";
            return v;
          })(),
          keywords:     [], // non disponibile nella ricerca avanzata (GROUP_CONCAT causa 403)
          catalogUri:   catalog || "",
          catalogLabel: catalog ? catInput.split(" (")[0] : "",
          viewUrl,
          csvResources: [],
        });
      }
      let datasets = [...seen.values()];
      datasets = postFilterAdv(datasets, effectiveQ);
      datasets = datasets.slice(0, 8);
      onResults(datasets, label);
    } catch(e) {
      onResults([], `Errore: ${e.message}`);
    }
    onLoading(false);
  }

  function reset() {
    setQ(""); setTheme(""); setHvd(""); setRh("");
    setFormat(""); setLicense(""); setSort("modified");
    setAcList([]); setShowAc(false);
    setCatalog(""); setCatInput(""); setShowCat(false);
  }

  return (
    <div className="adv-container">
      <button id="tour-advanced" className="adv-toggle-btn" onClick={() => setOpen(v => !v)}>
        ⚙️ Ricerca avanzata {open ? "▲" : "▼"}
      </button>

      {open && (
        <div className="adv-panel">
          <div className="adv-grid">
            <div className="adv-field">
              <label>Parole chiave</label>
              <input type="text" value={q} onChange={e => setQ(e.target.value)}
                placeholder="es. parcheggi, aria, covid…"
                onKeyDown={e => e.key === "Enter" && doSearch()} />
            </div>

            <div className="adv-field">
              <label>Tema DCAT-AP</label>
              <select value={theme} onChange={e => setTheme(e.target.value)}>
                <option value="">— tutti —</option>
                {THEMES.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
              </select>
            </div>

            <div className="adv-field">
              <label>Categoria HVD</label>
              <select value={hvd} onChange={e => setHvd(e.target.value)}>
                <option value="">— tutte —</option>
                {HVD_CATS.map(h => <option key={h.code} value={h.code}>{h.label}</option>)}
              </select>
            </div>

            <div className="adv-field" style={{ position: "relative" }}>
              <label>Titolare dati</label>
              <input type="text" value={rh} onChange={e => handlePubInput(e.target.value)}
                placeholder="es. Comune di Bari, Regione Puglia…"
                onBlur={() => setTimeout(() => setShowAc(false), 200)}
                autoComplete="off" />
              {showAc && (
                <div className="ac-dropdown">
                  {acList.map((m, i) => (
                    <div key={i} className="ac-item" onMouseDown={() => { setRh(m.name); setShowAc(false); }}>
                      <span>{m.name}</span>
                      <span className="ac-count">{m.count.toLocaleString("it")} ds</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="adv-field" style={{ position: "relative" }}>
              <label>Catalogo sorgente</label>
              <input type="text" value={catInput}
                onChange={e => handleCatInput(e.target.value)}
                onFocus={handleCatFocus}
                onBlur={() => setTimeout(() => setShowCat(false), 200)}
                placeholder={catLoading ? "Caricamento cataloghi…" : "es. dati.toscana.it, geodati.gov.it…"}
                autoComplete="off" />
              {showCat && filteredCats.length > 0 && (
                <div className="ac-dropdown">
                  {filteredCats.map((c, i) => (
                    <div key={i} className="ac-item" onMouseDown={() => selectCatalog(c)}>
                      <span>{c.label}</span>
                      <span className="ac-count">{c.count.toLocaleString("it")} ds</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="adv-field">
              <label>Formato distribuzione</label>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                <option value="">— tutti —</option>
                {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            <div className="adv-field">
              <label>Licenza</label>
              <select value={license} onChange={e => setLicense(e.target.value)}>
                <option value="">— tutte —</option>
                <option value="CC_BY">CC BY 4.0</option>
                <option value="CC_ZERO">CC0 / Public Domain</option>
                <option value="IODL">IODL 2.0</option>
                <option value="CC_BYSA">CC BY-SA 4.0</option>
              </select>
            </div>

            <div className="adv-field">
              <label>Ordinamento</label>
              <select value={sort} onChange={e => setSort(e.target.value)}>
                <option value="modified">Più recenti</option>
                <option value="title">Titolo A→Z</option>
              </select>
            </div>
          </div>

          <div className="adv-actions">
            <button className="adv-btn-primary" onClick={() => doSearch(0)}>🔍 Cerca</button>
            <button className="adv-btn-secondary" onClick={reset}>✕ Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}
