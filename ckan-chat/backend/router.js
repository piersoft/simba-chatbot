// router.js — routing deterministico domanda → tool MCP
// Nessun LLM coinvolto nella decisione: regex + keyword matching.
// L'LLM entra solo DOPO per sintetizzare la risposta in italiano.

const DEFAULT_CKAN = "https://www.dati.gov.it/opendata";

// Estrae un URL CKAN dalla domanda se presente
function extractServerUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : DEFAULT_CKAN;
}

// Estrae un URL CSV dalla domanda
function extractCsvUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+\.csv[^\s]*/i)
    || text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : null;
}

// Estrae la query di ricerca togliendo solo le parole di comando iniziali
function extractQuery(text) {
  return text
    .replace(/^(cerca|trovami|mostrami|dammi|elenca|mostra|trova)\s+/i, "")
    .replace(/\b(dataset|dati aperti|open data|portale ckan)\b/gi, "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Estrae un ID dataset dalla domanda
function extractDatasetId(text) {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    || text.match(/id[:\s]+([a-z0-9_-]+)/i);
  return m ? m[1] || m[0] : null;
}

// ─── Regole di routing ────────────────────────────────────────────────────────
// Ogni regola: { pattern, tool, args(text) }
// Ordine importante: le più specifiche prima.

const RULES = [
  // Validazione CSV
  {
    pattern: /valid[ai]|qualit[àa] (del )?csv|controlla (il )?csv|analizza (il )?csv/i,
    tool: "csv_validate",
    args: (text) => {
      const url = extractCsvUrl(text);
      return url ? { csv_url: url, summary_only: false } : null;
    },
    fallback: "Per validare un CSV dimmi l'URL del file oppure incolla il contenuto.",
  },

  // Dettaglio dataset per ID/nome
  {
    pattern: /dettagli|mostra (il )?dataset|info su|informazioni su|scheda/i,
    tool: "ckan_package_show",
    args: (text) => {
      const id = extractDatasetId(text);
      const server_url = extractServerUrl(text);
      return id ? { id, server_url } : null;
    },
    fallback: "Per vedere i dettagli di un dataset dimmi il suo ID o nome.",
  },

  // Lista organizzazioni
  {
    pattern: /organizzazion[ei]|enti|publisher|chi pubblica/i,
    tool: "ckan_organization_list",
    args: (text) => ({ server_url: extractServerUrl(text) }),
  },

  // Lista tag
  {
    pattern: /tag|categor[ie]|argomenti|temi/i,
    tool: "ckan_tag_list",
    args: (text) => ({ server_url: extractServerUrl(text) }),
  },

  // Ricerca dati dentro una risorsa (datastore)
  {
    pattern: /dati (dentro|nella|nella risorsa)|resource[_ ]id|datastore/i,
    tool: "ckan_datastore_search",
    args: (text) => {
      const id = extractDatasetId(text);
      const q = extractQuery(text);
      const server_url = extractServerUrl(text);
      return id ? { resource_id: id, server_url, q, limit: 10 } : null;
    },
    fallback: "Per cercare dati in una risorsa ho bisogno del resource_id.",
  },

  // Ricerca dataset generica — regola di default, deve stare per ultima
  {
    pattern: /.+/,
    tool: "ckan_package_search",
    args: (text) => {
      const q = extractQuery(text) || text.trim();
      const server_url = extractServerUrl(text);
      return { q, server_url, rows: 5 };
    },
  },
];

// ─── Funzione principale ──────────────────────────────────────────────────────
export function routeQuestion(userText) {
  for (const rule of RULES) {
    if (rule.pattern.test(userText)) {
      const args = rule.args(userText);
      if (!args && rule.fallback) {
        return { tool: null, args: null, fallback: rule.fallback };
      }
      return { tool: rule.tool, args: args || {}, fallback: null };
    }
  }
  // Fallback finale: ricerca generica
  return {
    tool: "ckan_package_search",
    args: { q: userText.trim(), server_url: DEFAULT_CKAN, rows: 5 },
    fallback: null,
  };
}
