/**
 * SIMBA — Sistema Intelligente per la ricerca di Metadati, Bonifica e Arricchimento semantico
 * Realizzato da @piersoft (https://github.com/piersoft) per AgID
 * Repo: https://github.com/piersoft/simba-chatbot
 * Licenza: MIT
 */
import { useState, useRef, useEffect } from "react";
import StatusBar from "./components/StatusBar";
import DatasetCard from "./components/DatasetCard";
import ValidateReport from "./components/ValidateReport";
import Icon from "./components/Icon";
import AdvancedSearch from "./components/AdvancedSearch";
import AnalyticsDashboard from "./components/AnalyticsDashboard";
import AdminPanel from "./components/AdminPanel";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "";

// ── Session ID — generato una volta per sessione browser ──────────────────────
if (!sessionStorage.getItem("ckan_sid")) {
  sessionStorage.setItem("ckan_sid", crypto.randomUUID());
}
const SESSION_ID = sessionStorage.getItem("ckan_sid");

// Header comuni a tutte le richieste verso il backend
function apiHeaders(extra = {}) {
  return { "Content-Type": "application/json", "x-session-id": SESSION_ID, ...extra };
}

// Invia evento analytics fire-and-forget dal frontend
// Usato per eventi che non passano per il backend (es. ricerca SPARQL diretta)
function emitAnalytics(type, payload = {}) {
  fetch("/analytics-api/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      session_id: SESSION_ID,
      ts: new Date().toISOString(),
      ...payload,
    }),
  }).catch(() => {});
}

const SUGGESTIONS = [
  { text: "Cerca dataset sulla qualità dell'aria", icon: "" },
  { text: "Trova dati sui rifiuti urbani",          icon: "" },
  { text: "Dataset sulla mobilità e trasporti",     icon: "" },
  { text: "Dati sull'energia rinnovabile",           icon: "" },
  { text: "Valida CSV da URL",                       icon: "✅", action: "validate_prompt" },
];

const BLOCKLIST = [
  // Prompt injection
  "ignore previous","system prompt","forget instructions","jailbreak","prompt injection",
  "ignore instructions","disregard","bypass",
  // Contenuti esplicitamente illeciti/pornografici
  "porn","porno","pornograph","xxx","nude","naked","escort","prostitut",
  "pedofil","pedophil","child abuse","snuff","gore",
  "cumshot","blowjob","handjob","gangbang","creampie","onlyfans","milf","dildo","vibrat",
  "cocain","eroina","metanfetamin","drug deal","narcotic"
];

const SPARQL_EP = import.meta.env.VITE_SPARQL_ENDPOINT || "https://lod.dati.gov.it/sparql";

// Sanitizza input utente per SPARQL — rimuove caratteri pericolosi
function sanitizeSparql(s) {
  return (s || "")
    .replace(/["{}<>\\|^`]/g, "")  // rimuove caratteri SPARQL pericolosi
    .slice(0, 200);                   // limite lunghezza
}


const TOUR_STEPS = [
  {
    title: "Benvenuto in SIMBA 🦁",
    text: "Sistema Intelligente per la ricerca di Metadati, Bonifica e Arricchimento semantico. Ti guido nelle funzionalità principali.",
    target: null, pos: "center",
  },
  {
    title: "Campo COSA",
    text: "Scrivi l'argomento che ti interessa: «defibrillatori», «rifiuti», «bilancio comunale». Se conosci il titolo esteso di un dataset (es. oltre 30 caratteri), puoi incollarlo direttamente per trovarlo con precisione.",
    target: "wizard-cosa", pos: "above",
  },
  {
    title: "Campo DOVE (opzionale)",
    text: "Filtra per territorio: «Puglia», «Comune di Milano», «Regione Toscana». Inizia a digitare e scegli dall'autocompletamento.",
    target: "wizard-dove", pos: "above",
  },
  {
    title: "Ricerca avanzata",
    text: "Clicca qui per filtrare per tema DCAT, formato, licenza, dataset HVD e Titolare. Utile per ricerche mirate su categorie specifiche della PA italiana.",
    target: "tour-advanced", pos: "above",
  },
  {
    title: "Valida CSV",
    text: "Clicca qui per verificare la qualità di un file CSV secondo gli standard PA italiani (RFC 4180, ISO 25012, linee guida AGID). Punteggio da 0 a 100.",
    target: "tour-validate",
  },
  {
    title: "Converti in RDF",
    text: "Trasforma un CSV in RDF Linked Data conforme alle ontologie ufficiali dati-semantic-assets. Richiede il Codice IPA dell'ente.",
    target: "tour-enrich",
  },
  {
    title: "Strumenti consigliati",
    text: "Qui trovi i link per attività specifiche complementari a SIMBA. Fortemente consigliati.",
    target: "sidebar-tools",
  },
];

export default function App() {
  // Route semplice: /analytics mostra la dashboard, tutto il resto il chatbot
  if (window.location.pathname.endsWith("/analytics") || window.location.pathname.endsWith("/analytics/")) {
    return <AnalyticsDashboard />;
  }
  if (window.location.pathname.includes("/admin") || new URLSearchParams(window.location.search).get("page") === "admin") {
    return <AdminPanel />;
  }

  const [messages,    setMessages]    = useState([]);
  const [pageTitle,   setPageTitle]   = useState("Chatbot");
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [health,      setHealth]      = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [csvUrl,      setCsvUrl]      = useState("");
  const [csvTab,      setCsvTab]      = useState("url"); // "url" | "upload"
  const [csvFile,     setCsvFile]     = useState(null);
  const [showTtlBox,  setShowTtlBox]  = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(() => !localStorage.getItem("privacy_ok"));
  const [showHelp,    setShowHelp]    = useState(false);
  const [tourStep,    setTourStep]    = useState(-1); // -1 = tour non attivo
  const [tourActive,  setTourActive]  = useState(false);
  const [blocklist,   setBlocklist]   = useState(BLOCKLIST);

  // Tour guidato — mostra al primo avvio se non già visto
  useEffect(() => {
    if (!localStorage.getItem("simba_tour_done")) {
      setTimeout(() => { setTourActive(true); setTourStep(0); }, 800);
    }
  }, []);

  function startTour() { setTourActive(true); setTourStep(0); setShowHelp(false); }
  function nextTourStep() {
    const next = tourStep + 1;
    if (next >= 4 && next <= 6) {
      setSidebarOpen(true);
      // Aspetta che la sidebar finisca l'animazione prima di mostrare l'highlight
      setTimeout(() => {
        if (next < TOUR_STEPS.length) setTourStep(next); else endTour();
      }, 350);
    } else {
      if (next < TOUR_STEPS.length) setTourStep(next); else endTour();
    }
  }
  function endTour() { setTourActive(false); setTourStep(-1); }
  function skipTourForever() { localStorage.setItem("simba_tour_done", "1"); endTour(); }

  // Carica blocklist dinamica dal backend all'avvio
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/admin/blocklist`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.blocklist?.length) setBlocklist(data.blocklist); })
      .catch(() => {}); // fallback alla BLOCKLIST hardcodata
  }, []);
  const [wizardDove,  setWizardDove]  = useState("");
  const [doveAcList,  setDoveAcList]  = useState([]);
  const [showDoveAc,  setShowDoveAc]  = useState(false);
  const doveAcTimer = useRef(null);
  const doveRef     = useRef(null);
  const [ttlUrl,      setTtlUrl]      = useState("");
  const [ttlFile,     setTtlFile]     = useState(null);
  const [ttlTab,      setTtlTab]      = useState("url");
  const [ttlIpa,      setTtlIpa]      = useState("");
  const [ttlPa,       setTtlPa]       = useState("");
  const [ttlFmt,      setTtlFmt]      = useState("ttl");
  const [ttlCsvText,  setTtlCsvText]  = useState(null);
  const [showCsvBox,  setShowCsvBox]  = useState(false);

  const bottomRef   = useRef(null);
  const csvFileRef   = useRef(null);
  const ttlFileRef   = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => { fetchHealth(); }, []);
  useEffect(() => { document.title = `SIMBA · ${pageTitle}`; }, [pageTitle]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const h = (e) => { if (!e.target.closest(".sidebar")) setSidebarOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [sidebarOpen]);

  async function fetchHealth() {
    try {
      const r = await fetch(`${BACKEND_URL}/api/health`);
      setHealth(await r.json());
    } catch { setHealth({ backend: "error", ollama: "error", mcp: "error" }); }
  }

  // ── Classifica intenzione (Ollama, 1 token) ──────────────────────────────
  async function classifyIntent(text) {
    try {
      const r = await fetch(`${BACKEND_URL}/api/intent`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok) return { intent: "SEARCH", aiUsed: false };
      const data = await r.json();
      return { intent: data.intent ?? "SEARCH", aiUsed: data.ai_used ?? false };
    } catch { return { intent: "SEARCH", aiUsed: false }; }
  }

  // ── Ricerca SPARQL — chiamata diretta dal browser (come l'assistente CKAN) ──
  async function doSearch(query, offset = 0, dove = "") {
    const FETCH_SIZE = 32; // come l'assistente: fetch più righe per deduplicare
    const PAGE_SIZE  = 8;
    const STOPWORDS = new Set(["il","lo","la","i","gli","le","un","una","uno",
      "di","a","da","in","con","su","per","tra","fra","e","o","ma","non","che",
      "del","dei","delle","della","degli","al","ai","alle","alla","nel","nei",
      "sul","sui","sulla","sulle",
      // Verbi colloquiali di richiesta — non sono keyword di dataset
      "fammi","mostra","mostrami","dimmi","elenca","cerca","trova","voglio",
      "vorrei","puoi","potrei","vedere","dammi","serve","servono","trovare",
      "come","cosa","dove","quando","sono","tutti","tutte","questo","questa",
      // Altre parole comuni non utili come keyword di dataset
      "dati","dato","file","open","data","anche","però","oppure","pure",
      "miei","tuoi","suoi","nostri","vostri","loro","controllare","verificare",
      "analizzare","scaricare","aprire","leggere","usare","utilizzare",
      // Verbi italiani comuni non utili come keyword PA
      "fare","fatto","fai","fate","fanno","facendo","faccio","facciamo",
      "potere","potrei","potresti","potrebbe","posso","puoi","può",
      "avere","avrei","avresti","avrebbe","aver","avendo",
      "essere","sarei","saresti","sarebbe","siamo","siete",
      "volere","vorresti","vorrebbe","vuoi","vuole",
      "dovere","dovrei","dovresti","dovrebbe","devo","devi","deve"]);

    const allWords = query.replace(/[''`]/g, " ").split(/\s+/).filter(w => w.length >= 2);
    const sigWords = allWords.filter(w => !STOPWORDS.has(w.toLowerCase()));

    // Se non ci sono parole significative dopo le stopwords → nessun dataset possibile
    if (sigWords.length === 0) {
      return { datasets: [], total: 0 };
    }
    // Limita a max 4 parole significative — query troppo lunghe causano SPARQL 500
    const useWords = sigWords.slice(0, 4);

    // kwFilter: AND con ricerca in titolo, descrizione E keyword
    function kwFilter(words, useOr = false) {
      // Cerca in titolo + descrizione + keyword (massima copertura)
      const parts = words.map((w, i) => {
        const wl = sanitizeSparql(w.toLowerCase());
        return `(CONTAINS(LCASE(?title),"${wl}")||CONTAINS(LCASE(STR(?description)),"${wl}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?kw${i} . FILTER(CONTAINS(LCASE(STR(?kw${i})),"${wl}")) })`;
      });
      return parts.join(useOr ? " || " : " && ");
    }

    // Post-filter: mantieni solo dataset dove almeno un termine appare in titolo, desc o keyword
    function postFilter(datasets, words) {
      if (!words || words.length === 0) return datasets;
      return datasets.filter(d => {
        const haystack = [
          d.title || "",
          d.description || "",
          ...(d.keywords || [])
        ].join(" ").toLowerCase();
        return words.every(w => haystack.includes(w.toLowerCase()));
      });
    }

    async function runQuery(words, useOr, off) {
      const doveFilter = dove
        ? `  ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName .
  FILTER(LCASE(STR(?rhName)) = "${sanitizeSparql(dove.toLowerCase())}")
`
        : `  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }
`;
      const sparqlQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?d ?title ?description ?modified ?rhName ?landingPage (GROUP_CONCAT(DISTINCT STR(?kw);separator=",") AS ?keywords) WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
  OPTIONAL { ?d dcat:keyword ?kw FILTER(LANG(?kw)='it'||LANG(?kw)='') }
${doveFilter}  FILTER(${kwFilter(words, useOr)})
} GROUP BY ?d ?title ?description ?modified ?rhName ?landingPage ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${off}`;
      // Prima prova dal browser, poi proxy backend come fallback
      try {
        const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(sparqlQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (rd.ok) return (await rd.json()).results?.bindings ?? [];
      } catch {}
      // Fallback proxy — usa User-Agent browser realistico
      try {
        const r = await fetch(`${BACKEND_URL}/api/sparql`, {
          method: "POST", headers: apiHeaders(),
          body: JSON.stringify({ query: sparqlQ }),
        });
        if (r.ok) return (await r.json()).results?.bindings ?? [];
      } catch {}
      return [];
    }

    // Se la query è lunga (titolo esatto?), prova prima la frase intera nel titolo
    if (query.length > 30) {
      const fullPhrase = sanitizeSparql(query.toLowerCase()).slice(0, 100);
      const phraseQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?d ?title ?description ?modified ?rhName ?landingPage (GROUP_CONCAT(DISTINCT STR(?kw);separator=",") AS ?keywords) WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
  OPTIONAL { ?d dcat:keyword ?kw FILTER(LANG(?kw)='it'||LANG(?kw)='') }
${dove ? `  ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName .\n  FILTER(LCASE(STR(?rhName)) = "${sanitizeSparql(dove.toLowerCase())}")\n` : `  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }\n`}  FILTER(CONTAINS(LCASE(STR(?title)),"${fullPhrase}"))
} GROUP BY ?d ?title ?description ?modified ?rhName ?landingPage ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${offset}`;
      try {
        const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(phraseQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (rd.ok) {
          const phraseBindings = (await rd.json()).results?.bindings ?? [];
          if (phraseBindings.length > 0) {
            const seenP = new Map();
            for (const b of phraseBindings) {
              const uri = b.d?.value ?? ""; if (!uri || seenP.has(uri)) continue;
              const id = uri.split("/").pop();
              const landingPage = b.landingPage?.value;
              const viewUrl = landingPage || `https://www.dati.gov.it/view-dataset/dataset?id=${id}`;
              seenP.set(uri, { uri, id, title: b.title?.value ?? "", description: b.description?.value ?? "", modified: b.modified?.value?.slice(0,10) ?? "", publisher: b.rhName?.value || "", ipaCode: "", keywords: b.keywords?.value ? b.keywords.value.split(",").map(k=>k.trim()).filter(k=>k&&k!=="N_A"&&k.length>2).slice(0,8) : [], viewUrl, csvResources: [] });
            }
            return { datasets: [...seenP.values()], query, offset };
          }
        }
      } catch {}
    }

    // Strategia: prima cerca solo nel TITOLO (più preciso), poi allarga a desc+keyword se trova < 3 risultati
    const titleOnlyFilter = (words) => words.map((w,i) => {
      const wl = sanitizeSparql(w.toLowerCase());
      return `CONTAINS(LCASE(?title),"${wl}")`;
    }).join(" && ");

    const titleOnlyQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?d ?title ?description ?modified ?rhName ?landingPage (GROUP_CONCAT(DISTINCT STR(?kw);separator=",") AS ?keywords) WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
  OPTIONAL { ?d dcat:keyword ?kw FILTER(LANG(?kw)='it'||LANG(?kw)='') }
${dove ? `  ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName .\n  FILTER(LCASE(STR(?rhName)) = "${sanitizeSparql(dove.toLowerCase())}")\n` : `  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }\n`}  FILTER(${titleOnlyFilter(useWords)})
} GROUP BY ?d ?title ?description ?modified ?rhName ?landingPage ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${offset}`;

    try {
      const titleUrl = `${SPARQL_EP}?query=${encodeURIComponent(titleOnlyQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
      const rt = await fetch(titleUrl, { headers: { Accept: "application/sparql-results+json" } });
      if (rt.ok) {
        const titleBindings = (await rt.json()).results?.bindings ?? [];
        if (titleBindings.length >= 1) {
          // Abbastanza risultati solo dal titolo — usa quelli (più precisi)
          const seenT = new Map();
          for (const b of titleBindings) {
            const uri = b.d?.value ?? ""; if (!uri || seenT.has(uri)) continue;
            const id = uri.split("/").pop();
            const landingPage = b.landingPage?.value;
            const viewUrl = landingPage || `https://www.dati.gov.it/view-dataset/dataset?id=${id}`;
            const modRaw = b.modified?.value?.slice(0,10) ?? "";
            const modYear = modRaw ? parseInt(modRaw.slice(0,4)) : 0;
            const modInvalid = modYear > new Date().getFullYear()+1 || (modYear < 1990 && modYear > 0);
            seenT.set(uri, { uri, id, title: b.title?.value ?? "", description: b.description?.value ?? "",
              modified: modInvalid ? "" : modRaw, modifiedRaw: modRaw, modInvalid,
              publisher: b.rhName?.value || (dove || ""), ipaCode: "",
              keywords: b.keywords?.value ? b.keywords.value.split(",").map(k=>k.trim()).filter(k=>k&&k!=="N_A"&&k.length>2).slice(0,8) : [],
              viewUrl, csvResources: [], catalogUri: "", catalogLabel: "" });
          }
          return { datasets: [...seenT.values()].slice(0, PAGE_SIZE), query, offset };
        }
      }
    } catch {}

    // Prima prova AND su titolo+desc+keyword, se non trova nulla riprova con OR ma mantieni termini geografici in AND
    const geoTerms = new Set(["puglia","sicilia","lombardia","campania","lazio","veneto","toscana","emilia","romagna","piemonte","calabria","sardegna","liguria","marche","abruzzo","friuli","trentino","umbria","basilicata","molise","valle","aosta","bolzano","trento","roma","milano","napoli","torino","palermo","genova","bologna","firenze","bari","catania","venezia","verona","messina","padova","trieste","brescia","taranto","prato","reggio","modena","parma","perugia","ravenna","livorno","cagliari","foggia","rimini","salerno","ferrara","sassari","latina","giugliano","bergamo","siracusa","pescara","monza","lecce","novara","ancona","udine","arezzo","cesena","andria","vicenza","terni","forlì","trento","piacenza","como","brindisi","massa","grosseto","ragusa","catanzaro","crotone","cosenza","vibo","reggio_calabria","matera","potenza","campobasso","isernia","aosta","nuoro","oristano","agrigento","caltanissetta","enna","siracusa","trapani"]);
    const hasGeoTerm = useWords.some(w => geoTerms.has(w.toLowerCase()));
    let bindings = await runQuery(useWords, false, offset);
    if (bindings.length === 0 && useWords.length > 1) {
      if (hasGeoTerm) {
        // Con termini geografici: OR solo sulle parole non geografiche, geo rimane in AND
        const geoWords = useWords.filter(w => geoTerms.has(w.toLowerCase()));
        const nonGeoWords = useWords.filter(w => !geoTerms.has(w.toLowerCase()));
        if (nonGeoWords.length > 0) {
          // Costruisci query mista: geo in AND, resto in OR
          const mixedQ = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT DISTINCT ?d ?title ?description ?modified ?rhName ?landingPage WHERE {
  ?d a dcat:Dataset .
  ?d dct:title ?title .
  FILTER(LANG(?title)='it'||LANG(?title)='')
  OPTIONAL { ?d dct:description ?description FILTER(LANG(?description)='it'||LANG(?description)='') }
  OPTIONAL { ?d dct:modified ?modified }
  OPTIONAL { ?d <http://www.w3.org/ns/dcat#landingPage> ?landingPage }
  OPTIONAL { ?d dct:rightsHolder ?rh . ?rh foaf:name ?rhName }
  FILTER(
    ${geoWords.map((w,i) => `(CONTAINS(LCASE(?title),"${w.toLowerCase()}")||CONTAINS(LCASE(STR(?description)),"${w.toLowerCase()}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?gkw${i} . FILTER(CONTAINS(LCASE(STR(?gkw${i})),"${w.toLowerCase()}")) })`).join(" && ")}
    && (${nonGeoWords.map((w,i) => `CONTAINS(LCASE(?title),"${w.toLowerCase()}")||CONTAINS(LCASE(STR(?description)),"${w.toLowerCase()}")||EXISTS { ?d <http://www.w3.org/ns/dcat#keyword> ?nkw${i} . FILTER(CONTAINS(LCASE(STR(?nkw${i})),"${w.toLowerCase()}")) }`).join(" || ")})
  )
} ORDER BY DESC(?modified) LIMIT ${FETCH_SIZE} OFFSET ${offset}`;
          try {
            const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(mixedQ)}&format=${encodeURIComponent("application/sparql-results+json")}`;
            const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
            if (rd.ok) bindings = (await rd.json()).results?.bindings ?? [];
          } catch {}
        }
      } else {
        bindings = await runQuery(useWords, true, offset);
      }
    }

    // Deduplicazione e costruzione risultati
    // Il rightsHolder (titolare dati) viene da dct:rightsHolder
    const seen = new Map();
    for (const b of bindings) {
      const uri = b.d?.value ?? "";
      if (!uri || seen.has(uri)) continue;
      const id = uri.split("/").pop();
      const landingPage = b.landingPage?.value;
      const viewUrl = landingPage || `https://www.dati.gov.it/view-dataset/dataset?id=${id}`;
      const modRaw = b.modified?.value?.slice(0,10) ?? "";
      const modYear = modRaw ? parseInt(modRaw.slice(0,4)) : 0;
      const modInvalid = modYear > new Date().getFullYear()+1 || (modYear < 1990 && modYear > 0);
      seen.set(uri, {
        uri, id,
        title:       b.title?.value ?? "",
        description: b.description?.value ?? "",
        modified:    modInvalid ? "" : modRaw,
        modifiedRaw: modRaw,
        modInvalid,
        publisher:   b.rhName?.value || (dove || ""),
        ipaCode:     "",
        keywords:    b.keywords?.value ? b.keywords.value.split(",").map(k=>k.trim()).filter(k=>k && k!=="N_A" && k.length > 2).slice(0,8) : [],
        viewUrl,
        csvResources: [],
      });
    }
    let datasets = [...seen.values()];
    // Post-filter: mantieni solo dataset con tutti i termini visibili in titolo/desc/keyword
    datasets = postFilter(datasets, useWords);
    datasets = datasets.slice(0, PAGE_SIZE);

    return { datasets, query, offset };
  }

  // ── Validazione CSV ───────────────────────────────────────────────────────
  async function doValidate(url, datasetTitle = "", datasetDescription = "", csvText = null) {
    const title = datasetTitle || url.split("/").pop().split("?")[0] || url;
    // 1. Prima prova dal browser (segue redirect, nessun CORS problem su CSV diretti)
    try {
      const csvRes = await fetch(url);
      if (csvRes.ok) {
        // Controlla Content-Type della risposta reale (dopo redirect)
        const ct = (csvRes.headers.get("content-type") || "").toLowerCase();
        const isHtmlCt = ct.includes("text/html") || ct.includes("application/xhtml");
        const isZipCt = ct.includes("application/zip") || ct.includes("application/x-zip")
          || ct.includes("application/x-zip-compressed") || ct.includes("application/octet-stream")
          || url.toLowerCase().endsWith(".zip");
        const isPdfCt = ct.includes("application/pdf") || url.toLowerCase().endsWith(".pdf");
        const isExcelCt = ct.includes("spreadsheetml") || ct.includes("ms-excel")
          || url.toLowerCase().endsWith(".xlsx") || url.toLowerCase().endsWith(".xls");

        const urlIsCsv = url.toLowerCase().includes('.csv') || url.toLowerCase().includes('/download/') || url.toLowerCase().includes('output=csv') || url.toLowerCase().includes('format=csv') || url.toLowerCase().includes('export=csv');
        if ((isHtmlCt && !urlIsCsv) || isZipCt || isPdfCt || isExcelCt) {
          throw new Error(
            `La risorsa non è un file CSV — Content-Type rilevato: "${ct || "non dichiarato"}". ` +
            (isHtmlCt ? "L'URL punta a una pagina web, non al file diretto. Cerca il link diretto al CSV nel portale open data." : "") +
            (isZipCt && !isHtmlCt ? "La risorsa è un archivio ZIP. Scaricalo, estrailo e valida il CSV all'interno." : "") +
            (isPdfCt ? "La risorsa è un PDF, non un CSV." : "") +
            (isExcelCt ? "La risorsa è un file Excel. Esportalo come CSV prima di validarlo." : "")
          );
        }

        const csv_text = await csvRes.text();
        const isHtml = csv_text.trimStart().startsWith("<");

        // Doppio controllo sul contenuto — anche se il Content-Type non è dichiarato
        if (isHtml) {
          throw new Error(
            "L'URL restituisce una pagina HTML, non un file CSV. " +
            "Probabilmente è il link alla scheda del dataset, non al file diretto. " +
            "Cerca il link diretto al CSV nel portale open data."
          );
        }

        const firstLine = csv_text.trim().split("\n")[0] || "";
        const hasSep = firstLine.includes(",") || firstLine.includes(";") || firstLine.includes("\t");
        if (hasSep) {
          const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
            method: "POST",
            headers: apiHeaders(),
            body: JSON.stringify({ csv_text, filename: title, dataset_title: datasetTitle, dataset_description: datasetDescription }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const rData = await r.json();
          // Estrai headers dal csv_text scaricato dal browser
          let bHeaders = [];
          const bFirstLine = csv_text.split(/\r?\n/).find(l => l.trim()) || "";
          if (bFirstLine) {
            const bSep = (bFirstLine.match(/;/g)||[]).length > (bFirstLine.match(/,/g)||[]).length ? ";" : ",";
            bHeaders = bFirstLine.split(bSep).map(h => h.trim().replace(/^"|"$/g,"")).filter(Boolean);
          }
          return { report: rData.report ?? "", headers: bHeaders, csvText: csv_text };
        }
      }
    } catch(e) {
      // Se l'errore è nostro (HTML/ZIP/PDF rilevato), rilancia direttamente
      if (e.message.includes("Content-Type") || e.message.includes("pagina HTML") || e.message.includes("pagina web") || e.message.includes("ZIP") || e.message.includes("PDF") || e.message.includes("Excel")) {
        throw e;
      }
      // Errore di rete/SSL/CORS — il browser non riesce, passa al backend
      if (e.message.includes("SSL") || e.message.includes("Failed to fetch") || e.message.includes("NetworkError") || e.message.includes("CORS")) {
        console.warn("[doValidate] browser fetch fallito (SSL/CORS), provo backend:", e.message);
        // non rilanciare — lascia cadere al fallback backend
      } else {
        console.warn("[doValidate] browser fetch fallito:", e.message);
      }
    }
    // 2. CORS bloccato o browser fetch fallito — passa al backend con controllo Content-Type
    const r = await fetch(`${BACKEND_URL}/api/validate`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
          url,
          dataset_title: title,
          dataset_description: datasetDescription,
          ...(csvText ? { csv_text: csvText } : {}),
        }),
    });
    if (r.status === 422) {
      const data = await r.json();
      throw new Error(data.error || "Formato non CSV");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bkData = await r.json();
    return { report: bkData.report ?? "", headers: bkData.headers || [], csvText: null };
  }

  // ── Callback per risultati ricerca avanzata ─────────────────────────────
  function handleAdvLoading(isLoading, label) {
    if (isLoading && label) {
      setMessages([]);  // nuova ricerca — pulisce la chat
    }
  }

  function handleAdvResults(datasets, label) {
    emitAnalytics("search", {
      query: label.slice(0, 500),
      datasets_found: datasets.length,
    });
    // Rimuovi messaggio "in corso" se presente
    setMessages(prev => prev.filter(m => m.type !== "searching"));
    if (!datasets.length) {
      addMsg("assistant", `Nessun dataset trovato per **"${label}"**.`);
      return;
    }
    addMsg("assistant", `Trovati risultati per **"${label}"**:`, {
      type: "search_results", datasets, query: label, offset: 0,
    });
  }

  // ── Aggiunge un messaggio alla chat ───────────────────────────────────────
  function addMsg(role, content, extra = {}) {
    setMessages(prev => [...prev, { role, content, ...extra }]);
  }

  function replaceLastMsg(role, content, extra = {}) {
    setMessages(prev => {
      const msgs = [...prev];
      // Trova e sostituisce l'ultimo messaggio loading_ttl
      const idx = msgs.map(m => m.type).lastIndexOf("loading_ttl");
      if (idx !== -1) msgs[idx] = { role, content, ...extra };
      else msgs.push({ role, content, ...extra });
      return msgs;
    });
  }

  // ── Handler principale ────────────────────────────────────────────────────
  function resetChat() {
    setMessages([]);
    setInput("");
    setWizardDove("");
    setShowCsvBox(false);
    setShowTtlBox(false);
    setTtlCsvText(null);
    setCsvFile(null);
    setTtlFile(null);
  }

  // Autocomplete DOVE — rightsHolder live SPARQL
  async function handleDoveInput(v) {
    setWizardDove(v);
    clearTimeout(doveAcTimer.current);
    if (v.length < 2) { setShowDoveAc(false); return; }
    doveAcTimer.current = setTimeout(async () => {
      try {
        const ql = v.toLowerCase().replace(/"/g, "");
        const q = `PREFIX dcat: <http://www.w3.org/ns/dcat#>
PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name (COUNT(DISTINCT ?d) AS ?count) WHERE {
  ?d a dcat:Dataset .
  ?d dct:rightsHolder ?rh .
  ?rh foaf:name ?name .
  FILTER(CONTAINS(LCASE(STR(?name)),"${ql}"))
} GROUP BY ?name ORDER BY DESC(?count) LIMIT 10`;
        // Prova diretta dal browser, fallback al proxy
        let data;
        try {
          const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`;
          const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
          if (rd.ok) data = await rd.json();
        } catch {}
        if (!data) {
          const r = await fetch(`${BACKEND_URL}/api/sparql`, {
            method: "POST", headers: apiHeaders(),
            body: JSON.stringify({ query: q }),
          });
          if (!r.ok) return;
          data = await r.json();
        }
        const seen = new Set();
        const results = [];
        for (const b of data.results?.bindings ?? []) {
          const name = b.name?.value?.trim();
          if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            results.push({ name, count: parseInt(b.count?.value || "0") });
          }
        }
        setDoveAcList(results);
        setShowDoveAc(results.length > 0);
      } catch {}
    }, 350);
  }

  // Recupera codice IPA preciso del rightsHolder tramite query dedicata
  async function fetchIpaCode(datasetUri) {
    try {
      const q = `PREFIX dct: <http://purl.org/dc/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX dcat: <http://www.w3.org/ns/dcat#>
SELECT ?ipaCode WHERE {
  <${datasetUri}> dct:rightsHolder ?rh .
  ?rh dct:identifier ?ipaCode .
} LIMIT 1`;
      let data;
      try {
        const directUrl = `${SPARQL_EP}?query=${encodeURIComponent(q)}&format=${encodeURIComponent("application/sparql-results+json")}`;
        const rd = await fetch(directUrl, { headers: { Accept: "application/sparql-results+json" } });
        if (rd.ok) data = await rd.json();
      } catch {}
      if (!data) {
        const r = await fetch(`${BACKEND_URL}/api/sparql`, {
          method: "POST", headers: apiHeaders(),
          body: JSON.stringify({ query: q }),
        });
        if (!r.ok) return "";
        data = await r.json();
      }
      const val = data.results?.bindings?.[0]?.ipaCode?.value || "";
      // Se è una partita IVA (11 cifre numeriche) = errore nei metadati, scarta
      return /^\d{11}$/.test(val) ? "" : val;
    } catch { return ""; }
  }

  async function sendMessage(rawText) {
    const text = rawText.trim();
    setMessages([]);  // nuova ricerca — pulisce la chat
    if (!text || loading) return;
    if (blocklist.some(p => text.toLowerCase().includes(p.toLowerCase()))) {
      emitAnalytics("off_topic", { query_preview: text.slice(0, 100), guardrail_layer: "blocklist" });
      addMsg("assistant", "Richiesta non consentita. SIMBA risponde esclusivamente a domande sugli open data della Pubblica Amministrazione italiana.");
      return;
    }
    if (text.length > 2000) { alert("Messaggio troppo lungo."); return; }

    setSidebarOpen(false);
    setShowCsvBox(false);
    addMsg("user", text);
    setInput("");
    setLoading(true);

    try {
      const { intent, aiUsed } = await classifyIntent(text);
      if (aiUsed) addMsg("assistant", "🤖 *Classificazione AI attiva* — il motore AI ha interpretato la tua richiesta per indirizzarla correttamente.", { type: "ai_note" });

      if (intent === "SEARCH") setPageTitle("Ricerca Dataset");
      else if (intent === "VALIDATE") setPageTitle("Validazione CSV");
      else if (intent === "ENRICH") setPageTitle("Conversione RDF");

      if (intent === "OFF_TOPIC") {
        addMsg("assistant", `Mi dispiace, posso aiutarti solo con:\n- Ricerca dataset open data italiani\n- Validazione file CSV per la PA\n- Conversione CSV → RDF Linked Data\n\nProva con: *"Cerca defibrillatori nel Comune di Mesagne"*`);
        return;
      }

      if (intent === "VALIDATE") {
        const url = text.match(/https?:\/\/[^\s]+/)?.[0];
        if (!url) {
          addMsg("assistant", "Per validare un CSV dimmi l'URL del file.\n\nOppure usa il box qui sotto per incollarlo:");
          setShowCsvBox(true);
          return;
        }
        addMsg("assistant", `Validazione in corso per:\n\`${url}\``, { type: "validating" });
        const report = await doValidate(url);
        addMsg("assistant", report, { type: "validate_report", url });
        return;
      }

      if (intent === "ENRICH") {
        setShowTtlBox(true);
        return;
      }

      // SEARCH — estrae la query e chiama SPARQL
      // query = versione pulita per SPARQL (senza verbi e stopword)
      // displayQuery = testo originale per mostrarlo all'utente
      const displayQuery = text;
      const query = text
        // Rimuovi frasi introduttive comuni + articolazioni su/sul/sulla/sull'/degli ecc.
        .replace(/^(cerca|trovami|mostrami|dammi|elenca|trova|ho bisogno di|mi servono|vorrei|voglio|puoi darmi|puoi trovarmi|sto cercando|cerco|fammi vedere|hai|ci sono|esistono|dove trovo|come trovo)\s+/i, "")
        .replace(/^(dati|informazioni|dataset|statistiche|numeri)\s+(su[gli']?\s*|dell[aeo']?\s*|d[ie]\s+)/i, "")
        .replace(/\s+(su[gli']?|dell[aeo']?|d[ie])\s+/gi, " ")
        .replace(/\b(dataset|open data)\b/gi, "")
        .replace(/[?!.]+$/, "")
        .replace(/\s+/g, " ").trim() || text;

      setPageTitle("Ricerca Dataset");


      const t0search = Date.now();
      const { datasets } = await doSearch(query);
      emitAnalytics("search", {
        query: query.slice(0, 500),
        where: null,
        datasets_found: datasets.length,
        latency_ms: Date.now() - t0search,
      });

      if (!datasets.length) {
        addMsg("assistant", `Nessun dataset trovato per **"${displayQuery}"**.\n\nProva con termini più generici.`);
        return;
      }

      addMsg("assistant", `Trovati risultati per **"${displayQuery}"** — clicca ▼ su un dataset per vedere le risorse CSV e validarle:`, {
        type: "search_results",
        datasets,
        query,
        offset: 0,
      });

    } catch (e) {
      addMsg("assistant", `❌ Errore: ${e.message}`);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  // ── Conversione CSV → RDF ────────────────────────────────────────────────────
  async function doEnrich(url, datasetTitle, ipa = "ente", fmt = "ttl") {
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${url}`);
    setPageTitle("Conversione RDF");
    addMsg("assistant", `Conversione in RDF/${fmt.toUpperCase()} di **"${datasetTitle}"** in corso…`, { type: "loading_ttl" });
    setLoading(true);
    try {
      // Passa sempre l'URL al backend — rdf-mcp lo scarica direttamente
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ url, pa: datasetTitle, ipa, fmt }),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`HTTP ${r.status}: ${err.slice(0,200)}`);
      }
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      // Anteprima: tutto se < 1000 righe, altrimenti prime 500 (utili per CSV multi-ontologia)
      const preview = lines.length < 1000 ? ttl : lines.slice(0, 500).join("\n");
      const mimeType = fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle";
      const ext      = fmt === "rdfxml" ? "rdf" : "ttl";
      const blob = new Blob([ttl], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      replaceLastMsg("assistant", `Conversione completata: ${lines.length} triple generate.`, {
        type: "ttl_result", blobUrl, filename: `${ipa}-${Date.now()}.${ext}`, preview, fmt
      });
    } catch (e) {
      addMsg("assistant", `❌ Errore conversione: ${e.message}`);
    }
    setLoading(false);
  }

  // ── "Carica altri" ────────────────────────────────────────────────────────
  async function loadMore(query, currentOffset) {
    const newOffset = currentOffset + 8;
    setLoadingMore(true);
    try {
      let { datasets } = await doSearch(query, newOffset);
      if (!datasets.length) { addMsg("assistant", "Nessun altro risultato disponibile."); return; }
      addMsg("assistant", `Altri risultati per **"${query}"**:`, {
        type: "search_results", datasets, query, offset: newOffset,
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoadingMore(false); }
  }

  // ── Valida CSV da card ────────────────────────────────────────────────────
  async function validateFromCard(url, datasetTitle, publisher = "", datasetUri = "", datasetDescription = "") {
    addMsg("user",      `Valida CSV: ${url}`);
    setPageTitle("Validazione CSV");
    addMsg("assistant", `Validazione CSV di **"${datasetTitle}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      // Scarica il CSV dal browser — se riesce, lo manda direttamente al backend
      // evitando i 403 che i server PA danno alle richieste server-side
      let csvText = null;
      try {
        const csvRes = await fetch(url, { headers: { "Accept": "text/csv,text/plain,*/*" } });
        if (csvRes.ok) {
          const ct = (csvRes.headers.get("content-type") || "").toLowerCase();
          const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");
          const urlIsCsv = url.toLowerCase().includes(".csv") || url.toLowerCase().includes("/download/") || url.toLowerCase().includes("output=csv") || url.toLowerCase().includes("format=csv");
          if (!isHtml || urlIsCsv) csvText = await csvRes.text();
          // Se il contenuto è HTML nonostante urlIsCsv, scarta
          if (csvText && csvText.trimStart().startsWith("<")) csvText = null;
        }
      } catch { /* CORS o rete — lascia null, ci pensa il backend */ }
      const vResult = await doValidate(url, datasetTitle, datasetDescription, csvText);
      const report = typeof vResult === "string" ? vResult : vResult.report;
      const vHeaders = typeof vResult === "string" ? [] : (vResult.headers || []);
      const vCsvText = typeof vResult === "string" ? csvText : (vResult.csvText || csvText);
      const ipaCode = datasetUri ? await fetchIpaCode(datasetUri) : "";
      addMsg("assistant", report, { type: "validate_report", url, publisher, ipaCode, csvText: vCsvText, csvHeaders: vHeaders, datasetTitle });
    } catch (e) {
      let msg;
      if (e.message.includes("Content-Type") || e.message.includes("non sembra un file CSV")) {
        msg = `❌ **Formato non supportato**\n\nL'URL punta a una risorsa che non è un file CSV scaricabile direttamente (potrebbe essere una API JSON, una pagina HTML o un archivio ZIP).\n\n**Suggerimento:** cerca il link diretto al file .csv nel portale open data e incollalo nel campo di validazione manuale.`;
      } else if (e.message.includes("503") || e.message.includes("502") || e.message.includes("500")) {
        msg = `❌ **Server non raggiungibile**\n\nIl server che ospita il file CSV ha risposto con un errore temporaneo (${e.message}). Il file potrebbe essere temporaneamente non disponibile.\n\n**Suggerimento:** riprova tra qualche minuto o scarica il file manualmente dal portale open data.`;
      } else if (e.message.includes("400")) {
        msg = `❌ **URL non valido**\n\nIl link non punta a un file CSV scaricabile direttamente (potrebbe essere una pagina web, un file vuoto o un formato non supportato).\n\n**Suggerimento:** cerca il link diretto al file .csv nel portale open data.`;
      } else if (e.message.includes("404")) {
        msg = `❌ **File non trovato**\n\nL'URL non esiste o il file è stato spostato (HTTP 404).\n\n**Suggerimento:** verifica l'URL sul portale open data.`;
      } else {
        msg = `❌ Errore: ${e.message}`;
      }
      addMsg("assistant", msg);
    }
    finally { setLoading(false); }
  }

  // ── Valida CSV da box manuale ─────────────────────────────────────────────
  async function validateFromUpload() {
    if (!csvFile) return;
    setShowCsvBox(false);
    if (csvFile.size === 0) {
      addMsg("assistant", `❌ **File vuoto**\n\nIl file "${csvFile.name}" è vuoto (0 byte) e non può essere validato.`);
      setCsvFile(null);
      return;
    }
    addMsg("user", `Valida CSV: ${csvFile.name}`);
    addMsg("assistant", `Validazione CSV di **"${csvFile.name}"** in corso…`, { type: "validating" });
    setLoading(true);
    try {
      const text = await csvFile.text();
      const r = await fetch(`${BACKEND_URL}/api/validate-text`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text: text, filename: csvFile.name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      // Estrai headers dal csv caricato
      let ulHeaders = [];
      const ulFirstLine = text.split(/\r?\n/).find(l => l.trim()) || "";
      if (ulFirstLine) {
        const ulSep = (ulFirstLine.match(/;/g)||[]).length > (ulFirstLine.match(/,/g)||[]).length ? ";" : ",";
        ulHeaders = ulFirstLine.split(ulSep).map(h => h.trim().replace(/^"|"$/g,"")).filter(Boolean);
      }
      addMsg("assistant", data.report ?? "Errore nella validazione", { type: "validate_report", url: csvFile.name, csvText: text, csvHeaders: ulHeaders });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setCsvFile(null); }
  }

  async function doEnrichText(csv_text, filename, fmt = "ttl", paName = "") {
    // Conversione diretta da testo CSV (file già caricato) — niente box IPA/PA
    const title = paName || filename.replace(/\.csv$/i,"");

    // ── Semantic Gate via helper ─────────────────────────────────────────────
    const _gateBlocked = await runGateCheck(csv_text, title);
    if (_gateBlocked) {
      addMsg("user", `Converti in ${fmt.toUpperCase()}: ${title}`);
      return;
    }
    // ── Fine Gate ─────────────────────────────────────────────────────────────

    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${title}`);
    addMsg("assistant", `Conversione in RDF/${fmt.toUpperCase()} di **"${title}"** in corso…`);
    setLoading(true);
    try {
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text, pa: title, ipa: "ente", fmt, filename: filename }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      // Anteprima: tutto se < 1000 righe, altrimenti prime 500 (utili per CSV multi-ontologia)
      const preview = lines.length < 1000 ? ttl : lines.slice(0, 500).join("\n");
      const ext = fmt === "rdfxml" ? "rdf" : "ttl";
      const blob = new Blob([ttl], { type: fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle" });
      const blobUrl = URL.createObjectURL(blob);
      addMsg("assistant", `Conversione completata: ${lines.length} righe generate.`, {
        type: "ttl_result", blobUrl, filename: `${filename.replace(/\.csv$/i,"")}.${ext}`, preview, fmt
      });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    setLoading(false);
  }

  function openTtlBox(url, fmt = "ttl", csvText = null, pa = "", ipa = "") {
    setShowCsvBox(false);
    setTtlCsvText(csvText);
    setTtlUrl(url || ""); // conserva sempre l'URL originale per il nome file
    setTtlTab(csvText ? "upload" : "url");
    setTtlFmt(fmt);
    setTtlIpa(ipa);
    setTtlPa(pa);
    setShowTtlBox(true);
  }


  // ── Helper gate semantico ─────────────────────────────────────────────────
  async function runGateCheck(csv_text, title) {
    try {
      const csvLines = (csv_text || "").split(/\r?\n/).filter(l => l.trim());
      if (csvLines.length === 0) return false;
      // Parser CSV che gestisce campi quoted con virgole interne
      function parseCSVLine(line, sep) {
        const result = []; let field = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { if (inQ && line[i+1]==='"') { field+='"'; i++; } else inQ=!inQ; }
          else if (ch === sep && !inQ) { result.push(field.trim()); field = ""; }
          else { field += ch; }
        }
        result.push(field.trim());
        return result;
      }
      const sep = (csvLines[0].match(/;/g)||[]).length > (csvLines[0].match(/,/g)||[]).length ? ";" : ",";
      const headers = parseCSVLine(csvLines[0], sep).map(h => h.replace(/^"|"$/g,"").trim());
      if (headers.length === 0) return false;
      const rows = [];
      for (let i = 1; i < Math.min(csvLines.length, 6); i++) {
        const vals = parseCSVLine(csvLines[i], sep).map(v => v.replace(/^"|"$/g,"").trim());
        const row = {}; headers.forEach((h,j) => { row[h] = vals[j] || ""; }); rows.push(row);
      }
      if (rows.length === 0) { rows.push({}); rows.push({}); rows.push({}); }
      const gateRes = await fetch(`${BACKEND_URL}/api/validate-semantic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers, rows, ontos: [], title }),
        signal: AbortSignal.timeout(8000),
      });
      if (!gateRes.ok) return false;
      const gate = await gateRes.json();
      if (gate.stato === "BLOCCANTE" || gate.stato === "MIGLIORABILE") {
        const icon = gate.stato === "BLOCCANTE" ? "⊗" : "⚠";
        const sd = gate.score_detail || {};
        let msg = `${icon} **CSV ${gate.stato} per la conversione RDF** (score: ${gate.score}/100)\n\n`;
        msg += `Struttura: ${sd.struttura||0}/40 | Ontologie: ${sd.ontologie||0}/40 | Linked Data: ${sd.linked_data||0}/20\n\n`;
        if (gate.blockers?.length)  msg += gate.blockers.map(b => `❌ ${b.msg}`).join("\n") + "\n\n";
        if (gate.warnings?.length)  msg += gate.warnings.map(w => `⚠️ ${w.msg}`).join("\n") + "\n\n";
        if (gate.suggestions?.length) {
          msg += "**Suggerimenti per abilitare la conversione:**\n";
          gate.suggestions.forEach(s => {
            msg += `\n**${s.label}**\n`;
            (s.renames||[]).forEach(r => { msg += `• Rinomina \`${r.da}\` → \`${r.a}\`\n`; });
            (s.aggiungi||[]).filter(a => a.priorita !== "bassa").forEach(a => { msg += `• Aggiungi [${a.priorita}]: \`${a.colonna}\`\n`; });
          });
        }
        msg += `\n*Correggi il CSV e ricaricalo per procedere con la conversione.*`;
        addMsg("assistant", msg);
        return true; // bloccato
      }
    } catch (_) {}
    return false; // passa
  }

  async function enrichFromBox() {
    if (!ttlUrl.trim()) return;
    if (!ttlIpa.trim()) { alert("Inserisci il Codice IPA dell'ente (es. c_b220)"); return; }
    if (!ttlPa.trim())  { alert("Inserisci il Nome della PA (es. Comune di Bari)"); return; }
    setShowTtlBox(false);
    const pa = ttlPa.trim();
    const ipa = ttlIpa.trim();
    // Gate solo se abbiamo il CSV in memoria (da URL non possiamo scaricare qui)
    if (ttlCsvText) {
      const gateBlocked = await runGateCheck(ttlCsvText, pa);
      if (gateBlocked) { return; }
    }
    await doEnrich(ttlUrl.trim(), pa, ipa, ttlFmt);
    setTtlUrl(""); setTtlIpa(""); setTtlPa(""); setTtlFmt("ttl");
  }

  async function enrichFromUpload() {
    const hasMemory = !!ttlCsvText;
    if (!ttlFile && !hasMemory) return;
    if (!ttlIpa.trim()) { alert("Inserisci il Codice IPA dell'ente (es. c_b220)"); return; }
    if (!ttlPa.trim())  { alert("Inserisci il Nome della PA (es. Comune di Bari)"); return; }
    setShowTtlBox(false);
    const pa = ttlPa.trim();
    const ipa = ttlIpa.trim();
    // Se non c'è file fisico ma c'è un URL (ttlUrl) o memoria da ValidateReport,
    // estrai il nome file dall'URL originale invece di usare il generico "CSV"
    // Estrai nome file dall'URL originale (anche quando il CSV è già in memoria)
    const fnameFromUrl = ttlUrl ? ttlUrl.split("/").pop().split("?")[0] : null;
    const fname = ttlFile?.name || fnameFromUrl || "CSV";
    const fmt = ttlFmt || "ttl";
    const ext = fmt === "rdfxml" ? "rdf" : "ttl";
    const mimeType = fmt === "rdfxml" ? "application/rdf+xml" : "text/turtle";
    addMsg("user", `Converti in ${fmt.toUpperCase()}: ${fname}`);
    addMsg("assistant", `Conversione in RDF/${fmt === "rdfxml" ? "XML" : "Turtle"} di **"${pa}"** in corso…`);
    setLoading(true);
    try {
      const csv_text = hasMemory ? ttlCsvText : await ttlFile.text();
      // ── Semantic Gate ───────────────────────────────────────────────────────
      const gateBlocked = await runGateCheck(csv_text, pa);
      if (gateBlocked) { setLoading(false); setTtlFile(null); return; }
      // ── Fine Gate ───────────────────────────────────────────────────────────
      const r = await fetch(`${BACKEND_URL}/api/enrich`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ csv_text, pa, ipa, fmt, filename: fname }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ttl = await r.text();
      const lines = ttl.split("\n").filter(Boolean);
      // Anteprima: tutto se < 1000 righe, altrimenti prime 500 (utili per CSV multi-ontologia)
      const preview = lines.length < 1000 ? ttl : lines.slice(0, 500).join("\n");
      const blob = new Blob([ttl], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      replaceLastMsg("assistant", `✅ Conversione completata!`, { type: "ttl_result", blobUrl, filename: `${ipa}-${Date.now()}.${ext}`, preview, fmt });
    } catch (e) { addMsg("assistant", `❌ Errore: ${e.message}`); }
    finally { setLoading(false); setTtlFile(null); setTtlIpa(""); setTtlPa(""); setTtlCsvText(null); }
  }

  async function validateFromBox() {
    if (!csvUrl.trim()) return;
    setShowCsvBox(false);
    await validateFromCard(csvUrl.trim(), "CSV fornito");
    setCsvUrl("");
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  // ── Render messaggio ──────────────────────────────────────────────────────
  function renderMessage(m, i) {
    if (m.type === "search_results") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <p dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />
            <div className="dataset-list">
              {m.datasets.map((d, j) => (
                <DatasetCard key={j} dataset={d} onValidate={validateFromCard} onEnrich={doEnrich} searchTerms={(m.query || "").replace(/['‘’`]/g," ").split(/\s+/).filter(w=>w.length>2)} />
              ))}
            </div>
            <button className="load-more-btn" onClick={() => loadMore(m.query, m.offset)} disabled={loadingMore} aria-label="Carica altri dataset">
              {loadingMore
                ? <><i className="bi bi-arrow-repeat spin" /> Caricamento…</>
                : <><i className="bi bi-chevron-down" /> Carica altri risultati</>
              }
            </button>
          </div>
        </div>
      );
    }

    if (m.type === "loading_ttl") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble loading-ttl-bubble">
            <i className="bi bi-arrow-repeat spin" style={{fontSize:"18px",color:"#0066CC"}} />
            <span>{m.content}</span>
          </div>
        </div>
      );
    }

    if (m.type === "ttl_result") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <p>Conversione completata.</p>
            {m.preview && (
              <>
                <p className="ttl-preview-label">{m.preview.split("\n").filter(Boolean).length >= 500 ? "Anteprima (prime 500 righe) — scarica il file per il contenuto completo:" : "Anteprima completa:"}</p>
                <pre className="ttl-preview">{m.preview}{m.preview.split("\n").filter(Boolean).length >= 500 ? "\n…" : ""}</pre>
              </>
            )}
            <div className="ttl-download-btns">
              <a href={m.blobUrl} download={m.filename} className="btn-small btn-download">
                ⬇ Scarica {m.fmt === "rdfxml" ? "RDF/XML" : "Turtle (.ttl)"}
              </a>
            </div>
          </div>
        </div>
      );
    }

    if (m.type === "validate_report") {
      return (
        <div key={i} className="message assistant">
          <div className="message-bubble">
            <ValidateReport report={m.content} url={m.url} csvText={m.csvText} csvHeaders={m.csvHeaders || []} onEnrich={(url, fmt) => openTtlBox(url, fmt, m.csvText, m.publisher || "", m.ipaCode || "")} onEnrichText={(csv_text, filename, fmt) => doEnrichText(csv_text, filename, fmt, m.datasetTitle || m.publisher || "")} />
          </div>
        </div>
      );
    }

    return (
      <div key={i} className={`message ${m.role}`}>
        <div className="message-bubble">
          {m.content.split("\n").map((line, j) => (
            <p key={j} dangerouslySetInnerHTML={{ __html: mdToHtml(line) || "&nbsp;" }} />
          ))}
        </div>
      </div>
    );
  }

  function escapeHtml(s) {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function mdToHtml(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,   "<em>$1</em>")
      .replace(/`(.+?)`/g,     "<code>$1</code>")
      .replace(/(https?:\/\/[^\s&]+)/g, (url) => {
        const safeUrl = url.replace(/&amp;/g, "&");
        return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });
  }

  return (
    <div className="app">
      {showPrivacy && (
        <div className="privacy-banner">
          <span>
            Questo servizio raccoglie dati anonimi sull'utilizzo (query, sessione, IP parziale) per migliorare il servizio.
            Nessun dato personale identificabile viene conservato.
          </span>
          <button onClick={() => { localStorage.setItem("privacy_ok", "1"); setShowPrivacy(false); }}>
            Ho capito ✕
          </button>
        </div>
      )}
      <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Apri menu strumenti">☰</button>
      <div className={`sidebar-overlay ${sidebarOpen ? "open" : ""}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-logo">
          <img src="/chatbot/logo-agid.png" alt="AgID" className="sidebar-agid-logo" />
          <div className="sidebar-agid-title">
            <span className="sidebar-agid-name">SIMBA</span>
            <span className="sidebar-agid-sub">Open Data · dati.gov.it</span>
          </div>
        </div>

        {/* Strumenti integrati — card colorate */}
        <div className="sidebar-section">
          <div className="section-label">Strumenti integrati</div>
          <button className="tool-card tool-search" aria-label="Cerca dataset open data" onClick={() => { resetChat(); setSidebarOpen(false); inputRef.current?.focus(); }} disabled={loading}>
            Cerca dataset
          </button>
          <button id="tour-validate" className="tool-card tool-validate" aria-label="Valida un file CSV" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }} disabled={loading}>
            Valida CSV
          </button>
          <button id="tour-enrich" className="tool-card tool-ttl" aria-label="Converti CSV in RDF" onClick={() => { setSidebarOpen(false); setMessages([]); setShowTtlBox(true); setShowCsvBox(false); }} disabled={loading}>
            Trasforma in RDF TTL/XML
          </button>
        </div>

        {/* Link strumenti — testo semplice */}
        <div id="sidebar-tools" className="sidebar-section">
          <div className="section-label">Strumenti consigliati</div>
          <a className="sidebar-plain-link" href="https://piersoft.github.io/CSV-to-RDF/" target="_blank" rel="noopener noreferrer">
            CSV to RDF completo <span className="plain-tag plain-tag-agid">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/piersoft/opendata-pa-quality-audit" target="_blank" rel="noopener noreferrer">
            Tool validazione CSV massivo <span className="plain-tag plain-tag-agid">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://lod.dati.gov.it/sparql/" target="_blank" rel="noopener noreferrer">
            SPARQL Endpoint dati.gov.it <span className="plain-tag plain-tag-agid">AgID</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/ondata/ckan-mcp-server" target="_blank" rel="noopener noreferrer">
            CKAN MCP Server <span className="plain-tag plain-tag-ondata">OnData</span>
          </a>
          <a className="sidebar-plain-link" href="https://github.com/ondata/istat_mcp_server" target="_blank" rel="noopener noreferrer">
            ISTAT MCP Server <span className="plain-tag plain-tag-ondata">OnData</span>
          </a>
        </div>

        <button className="help-sidebar-btn" onClick={startTour} aria-label="Tour funzionalità">
          <Icon name="map" size={13} /> Tour funzionalità
        </button>

        <button className="clear-btn" aria-label="Nuova conversazione" onClick={() => { resetChat(); }}>
          Nuova conversazione
        </button>

        <StatusBar health={health} onRefresh={fetchHealth} compact />

        <div className="sidebar-github">
          <a href="https://github.com/piersoft/simba-chatbot"
             target="_blank" rel="noopener noreferrer"
             aria-label="Codice sorgente su GitHub">
            <i className="bi bi-github" /> GitHub
          </a>
        </div>
      </aside>

      <main className="chat-area">
        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>SIMBA</h2>
              <p className="welcome-acronym"><span className="simba-letter">S</span>istema <span className="simba-letter">I</span>ntelligente per la ricerca di <span className="simba-letter">M</span>etadati, <span className="simba-letter">B</span>onifica e <span className="simba-letter">A</span>rricchimento semantico</p>
              <p>Ricerca, valida e arricchisce i dataset della PA.</p>
              <div className="welcome-chips">
                <span className="chip" onClick={() => sendMessage("Cerca dataset sulla qualità dell'aria")}>Cerca dataset</span>
                <span className="chip" onClick={() => { resetChat(); setShowCsvBox(true); setSidebarOpen(false); }}>Valida CSV</span>
                <span className="chip" onClick={() => sendMessage("Converti CSV in RDF")}>🔄 CSV → RDF</span>
              </div>
            </div>
          )}

          {messages.map(renderMessage)}

          {loading && (
            <div className="message assistant">
              <div className="message-bubble typing"><span className="dot"/><span className="dot"/><span className="dot"/></div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Box validazione CSV — URL o Upload */}
        {showCsvBox && (
          <div className="csv-box">
            <div className="csv-box-tabs">
              <button className={`csv-tab ${csvTab==="url" ? "active":""}`} onClick={() => setCsvTab("url")}><Icon name="link-45deg" /> Da URL</button>
              <button className={`csv-tab ${csvTab==="upload" ? "active":""}`} onClick={() => setCsvTab("upload")}><Icon name="upload" /> Carica file</button>
            </div>
            {csvTab === "url" ? (
              <>
                <p>Incolla l'URL del file CSV:</p>
                <div className="csv-box-row">
                  <input type="url" className="csv-url-input"
                    placeholder="https://esempio.com/dati.csv"
                    value={csvUrl} onChange={e => setCsvUrl(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && validateFromBox()} />
                  <button className="btn-validate-box" onClick={validateFromBox} disabled={!csvUrl.trim()}>
                    ✅ Valida
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Carica un file CSV dal tuo computer (max 10 MB):</p>
                <div className="csv-box-row">
                  <input type="file" accept=".csv,.tsv,.txt" ref={csvFileRef} style={{display:"none"}}
                    onChange={e => setCsvFile(e.target.files[0] || null)} />
                  <button className="btn-file-pick" onClick={() => csvFileRef.current?.click()}>
                    <Icon name="upload" size={14} /> {csvFile ? csvFile.name : "Scegli file CSV…"}
                  </button>
                  <button className="btn-validate-box" onClick={validateFromUpload} disabled={!csvFile}>
                    <Icon name="check2-circle" size={14} /> Valida
                  </button>
                </div>
                {csvFile && <p style={{fontSize:"12px",color:"#555",marginTop:"6px"}}>📄 {csvFile.name} ({(csvFile.size/1024).toFixed(1)} KB)</p>}
              </>
            )}
          </div>
        )}

        {/* Box conversione TTL */}
        {showTtlBox && (
          <div className="csv-box ttl-box">
            {!ttlCsvText && (
              <div className="csv-box-tabs">
                <button className={`csv-tab ${ttlTab==="url" ? "active":""}`} onClick={() => setTtlTab("url")}><Icon name="link-45deg" /> Da URL</button>
                <button className={`csv-tab ${ttlTab==="upload" ? "active":""}`} onClick={() => setTtlTab("upload")}><Icon name="upload" /> Carica file</button>
              </div>
            )}
            <div className="ttl-meta-row">
              <div className="ttl-field">
                <label className="ttl-label">Nome PA *</label>
                <input type="text" className="csv-url-input" placeholder="es. Comune di Bari"
                  value={ttlPa} onChange={e => setTtlPa(e.target.value)} />
              </div>
              <div className="ttl-field">
                <label className="ttl-label">Codice IPA *</label>
                <input type="text" className="csv-url-input" placeholder="es. c_b220"
                  value={ttlIpa} onChange={e => setTtlIpa(e.target.value)} />
              </div>
            </div>
            <div className="ttl-fmt-row">
              <span className="convert-label">Formato output:</span>
              <button className={`fmt-btn ${ttlFmt==="ttl" ? "active" : ""}`} onClick={() => setTtlFmt("ttl")}>
                🐢 RDF/Turtle (.ttl)
              </button>
              <button className={`fmt-btn ${ttlFmt==="rdfxml" ? "active" : ""}`} onClick={() => setTtlFmt("rdfxml")}>
                📄 RDF/XML (.rdf)
              </button>
            </div>
            {ttlTab === "url" ? (
              <>
                <p>URL del file CSV da convertire {ttlFmt === "rdfxml" ? "(→ RDF/XML)" : "(→ RDF/Turtle)"}:</p>
                <div className="csv-box-row">
                  <input type="url" className="csv-url-input"
                    placeholder="https://esempio.it/dataset.csv"
                    value={ttlUrl} onChange={e => setTtlUrl(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && enrichFromBox()} />
                  <button className="btn-validate-box btn-ttl-box" onClick={enrichFromBox} disabled={!ttlUrl.trim()}>
                    🔄 Converti
                  </button>
                </div>
              </>
            ) : (
              <>
                {ttlCsvText ? (
                  <div className="csv-box-row">
                    <span style={{fontSize:"13px",color:"#555",flex:1}}>📄 CSV già in memoria dalla validazione</span>
                    <button className="btn-validate-box btn-ttl-box" onClick={enrichFromUpload}>
                      🔄 Converti
                    </button>
                  </div>
                ) : (
                  <>
                    <p>Carica un file CSV da convertire:</p>
                    <div className="csv-box-row">
                      <input type="file" accept=".csv,.tsv,.txt" ref={ttlFileRef} style={{display:"none"}}
                        onChange={e => setTtlFile(e.target.files[0] || null)} />
                      <button className="btn-file-pick" onClick={() => ttlFileRef.current?.click()}>
                        <Icon name="upload" size={14} /> {ttlFile ? ttlFile.name : "Scegli file CSV…"}
                      </button>
                      <button className="btn-validate-box btn-ttl-box" onClick={enrichFromUpload} disabled={!ttlFile || !ttlIpa.trim() || !ttlPa.trim()}>
                        <Icon name="diagram-3" size={14} /> Converti
                      </button>
                    </div>
                    {ttlFile && <p style={{fontSize:"12px",color:"#555",marginTop:"6px"}}>📄 {ttlFile.name} ({(ttlFile.size/1024).toFixed(1)} KB)</p>}
                  </>
                )}
              </>
            )}
            <p style={{fontSize:"11px",color:"#888",marginTop:"8px"}}>
              Ontologie rilevate automaticamente secondo dati-semantic-assets
            </p>
          </div>
        )}


        {showHelp && (
          <div className="help-popup" role="dialog" aria-label="Guida all'uso">
            <button className="help-close" onClick={() => setShowHelp(false)} aria-label="Chiudi guida">
              <Icon name="x-lg" size={14} />
            </button>

            <h4><Icon name="search" size={14} /> Cerca dataset</h4>
            <p>Usa i due campi separati per risultati più precisi:</p>
            <ul>
              <li><strong>COSA</strong>: l'argomento che ti interessa — es. <em>«statistiche demografiche»</em>, <em>«rifiuti»</em>, <em>«defibrillatori»</em></li>
              <li><strong>DOVE</strong> (opzionale): la regione, il comune o l'ente — es. <em>«Puglia»</em>, <em>«Comune di Milano»</em></li>
            </ul>
            <p>Puoi anche incollare direttamente il titolo esatto di un dataset nel campo COSA.</p>
            <p className="help-warn"><Icon name="exclamation-triangle" size={12} /> Il sistema risponde solo a domande sugli open data PA italiani. Saluti, domande generiche e argomenti non pertinenti vengono ignorati.</p>

            <h4><Icon name="check2-circle" size={14} /> Valida CSV</h4>
            <p>Clicca <strong>Valida CSV</strong> nella sidebar, poi scegli:</p>
            <ul>
              <li><strong>Da URL</strong> — incolla il link diretto al file CSV (anche Google Sheets)</li>
              <li><strong>Carica file</strong> — carica un file .csv dal tuo computer (max 10 MB)</li>
            </ul>
            <p>Il validatore controlla struttura, contenuto, qualità open data e linked data secondo le linee guida AgID. Punteggio da 0 a 100.</p>

            <h4><Icon name="diagram-3" size={14} /> Converti in RDF TTL/XML</h4>
            <p>Clicca <strong>Trasforma in RDF TTL/XML</strong> nella sidebar, poi:</p>
            <ul>
              <li>Scegli il formato: <strong>RDF/Turtle (.ttl)</strong> o <strong>RDF/XML (.rdf)</strong></li>
              <li>Inserisci il <strong>Codice IPA</strong> dell'ente (es. <em>c_b220</em>) — <strong>obbligatorio</strong></li>
              <li>Inserisci il <strong>Nome della PA</strong> (es. <em>Comune di Bari</em>) — <strong>obbligatorio</strong></li>
              <li>Fornisci l'URL del CSV o carica il file</li>
            </ul>
            <p>Le ontologie vengono rilevate automaticamente dal corpus di 468 dataset PA italiani reali.</p>

            <p className="help-tip"><Icon name="lightbulb" size={12} /> Questo assistente risponde <strong>esclusivamente</strong> a richieste riguardanti open data della Pubblica Amministrazione italiana. Domande su altri argomenti verranno rifiutate.</p>
          </div>
        )}
        {/* ── Tour guidato ────────────────────────────────────────────── */}
      {tourActive && tourStep >= 0 && tourStep < TOUR_STEPS.length && (() => {
        const step = TOUR_STEPS[tourStep];
        const el = step.target ? document.getElementById(step.target) : null;
        const rect = el ? el.getBoundingClientRect() : null;
        return (
          <div className="tour-overlay" onClick={e => e.target === e.currentTarget && endTour()}>
            {rect && (
              <div className="tour-highlight" style={{
                top: rect.top - 8, left: rect.left - 8,
                width: rect.width + 16, height: rect.height + 16,
              }} />
            )}
            <div className="tour-bubble" style={(() => {
              const isMobile = window.innerWidth < 600;
              if (!rect) return { top: "50%", left: "50%", transform: "translate(-50%,-50%)" };
              // Su mobile: bubble centrata in alto per step "above", in basso per gli altri
              if (isMobile) {
                const pos = step.pos || "below";
                if (pos === "above") return {
                  top: 16, left: "50%", transform: "translateX(-50%)",
                  width: "calc(100vw - 32px)", maxWidth: 360,
                };
                return {
                  bottom: 16, left: "50%", transform: "translateX(-50%)",
                  width: "calc(100vw - 32px)", maxWidth: 360,
                };
              }
              const pos = step.pos || "below";
              if (pos === "above") return {
                bottom: window.innerHeight - rect.top + 16,
                left: Math.min(Math.max(rect.left, 12), window.innerWidth - 320),
              };
              if (pos === "right") return {
                top: Math.max(rect.top, 12),
                left: rect.right + 16,
              };
              return {
                top: rect.bottom + 16,
                left: Math.min(Math.max(rect.left, 12), window.innerWidth - 320),
              };
            })()}>
              <div className="tour-step-counter">{tourStep + 1} / {TOUR_STEPS.length}</div>
              <h4 className="tour-title">{step.title}</h4>
              <p className="tour-text">{step.text}</p>
              <div className="tour-actions">
                <button className="tour-btn-skip" onClick={skipTourForever}>Non mostrare più</button>
                <div style={{display:"flex",gap:8}}>
                  <button className="tour-btn-close" onClick={endTour}>Salta</button>
                  <button className="tour-btn-next" onClick={nextTourStep}>
                    {tourStep < TOUR_STEPS.length - 1 ? "Avanti →" : "Fine ✓"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <AdvancedSearch onResults={handleAdvResults} onLoading={setLoading} onLoadingMsg={handleAdvLoading} />
        <div className="wizard-bar">
          <div className="wizard-step">
            <span className="wizard-num">1</span>
            <span className="wizard-label">Cosa</span>
            <textarea
              ref={inputRef}
              id="wizard-cosa"
              className="wizard-input"
              aria-label="Cosa vuoi cercare"
              value={input}
              onChange={e => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
              }}
              onKeyDown={handleKey}
              placeholder="es. defibrillatori, rifiuti, bilancio…"
              rows={1}
              disabled={loading}
            />
          </div>
          <div id="wizard-dove" className="wizard-step" style={{position:"relative"}}>
            <span className="wizard-num">2</span>
            <span className="wizard-label">Dove</span>
            <input
              ref={doveRef}
              type="text"
              className="wizard-input"
              aria-label="Amministrazione (opzionale)"
              value={wizardDove}
              onChange={e => handleDoveInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { setShowDoveAc(false); sendMessage(input); } if (e.key === "Escape") setShowDoveAc(false); }}
              onBlur={() => setTimeout(() => setShowDoveAc(false), 200)}
              placeholder="es. Comune di Bari… (vuoto = tutti)"
              disabled={loading}
              autoComplete="off"
            />
            {showDoveAc && (
              <div className="dove-ac-list">
                {doveAcList.map((m, i) => (
                  <div key={i} className="dove-ac-item" onMouseDown={() => { setWizardDove(m.name); setShowDoveAc(false); }}>
                    <span>{m.name}</span>
                    <span className="dove-ac-count">{m.count.toLocaleString("it")} ds</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="wizard-actions">
            <button className="wizard-search-btn" aria-label="Cerca" onClick={async () => {
              if (!input.trim()) return;
              if (!wizardDove) {
                // Solo COSA → usa il flusso normale con intent+SPARQL ASK
                sendMessage(input.trim());
                return;
              }
              // COSA + DOVE → query SPARQL diretta con filtro rightsHolder
              const userMsg = `${input.trim()} · ${wizardDove}`;
              setMessages([]);  // nuova ricerca — pulisce la chat
              addMsg("user", userMsg);
              setLoading(true);
              try {
                const t0w = Date.now();
                const { datasets, offset } = await doSearch(input.trim(), 0, wizardDove);
                emitAnalytics("search", {
                  query: input.trim().slice(0, 500),
                  where: wizardDove || null,
                  datasets_found: datasets.length,
                  latency_ms: Date.now() - t0w,
                });
                if (!datasets.length) {
                  addMsg("assistant", `Nessun dataset trovato per **"${userMsg}"**.`);
                } else {
                  addMsg("assistant", `Trovati risultati per **"${userMsg}"**:`, {
                    type: "search_results", datasets, query: userMsg, offset,
                  });
                }
              } catch(e) {
                addMsg("assistant", `❌ Errore: ${e.message}`);
              } finally {
                setLoading(false);
              }
            }} disabled={loading || !input.trim()}>
              {loading ? <Icon name="hourglass-split" /> : <><Icon name="search" size={15}/> Cerca</>}
            </button>
          </div>
        </div>

      </main>
    </div>
  );
}
