// server.js — validatore-mcp
// Espone il validatore CSV PA come MCP server HTTP (JSON-RPC 2.0 / SSE)
// compatibile con il backend ckan-chat esistente.

import express from 'express';
import fetch from 'node-fetch';
import { validateCSV } from './validator.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3002;

// ─── Definizione tool MCP ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'csv_validate',
    description: 'Valida un file CSV secondo le linee guida della PA italiana (qualità strutturale, contenuto, open data, compatibilità Linked Data). Accetta il testo CSV diretto o un URL da cui scaricarlo. Restituisce score, verdict e lista di check con esito pass/warn/fail.',
    inputSchema: {
      type: 'object',
      properties: {
        csv_text: {
          type: 'string',
          description: 'Contenuto CSV grezzo da validare (alternativo a csv_url).',
        },
        csv_url: {
          type: 'string',
          description: 'URL pubblico del file CSV da scaricare e validare (alternativo a csv_text).',
        },
        summary_only: {
          type: 'boolean',
          description: 'Se true restituisce solo score, verdict e summary senza la lista completa dei check. Default: false.',
          default: false,
        },
        dataset_title: {
          type: 'string',
          description: 'Titolo del dataset DCAT (opzionale) — migliora il rilevamento delle ontologie.',
        },
        dataset_description: {
          type: 'string',
          description: 'Descrizione del dataset DCAT (opzionale) — migliora il rilevamento delle ontologie.',
        },
      },
      required: [],
    },
  },
  {
    name: 'csv_validate_url',
    description: 'Scarica un CSV da un URL CKAN (resource URL) e lo valida. Utile dopo aver trovato una risorsa con ckan_package_search o ckan_datastore_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL diretto del file CSV (es. da una risorsa CKAN).',
        },
      },
      required: ['url'],
    },
  },
];

// ─── Handler tool calls ───────────────────────────────────────────────────────

async function handleToolCall(name, args) {
  if (name === 'csv_validate_url') {
    // Alias conveniente: scarica e passa a csv_validate
    args = { csv_url: args.url, summary_only: args.summary_only };
    name = 'csv_validate';
  }

  if (name === 'csv_validate') {
    let raw = '';

    if (args.csv_url) {
      try {
        const resp = await fetch(args.csv_url, { headers: { 'User-Agent': 'validatore-mcp/1.0' } });
        if (!resp.ok) return `Errore nel download del CSV: HTTP ${resp.status} — ${args.csv_url}`;
        raw = await resp.text();
      } catch (e) {
        return `Impossibile scaricare il CSV da ${args.csv_url}: ${e.message}`;
      }
    } else if (args.csv_text) {
      raw = args.csv_text;
    } else {
      return 'Errore: fornire csv_text oppure csv_url.';
    }

    if (!raw.trim()) return 'Il CSV ricevuto è vuoto.';

    const result = validateCSV(raw, args.dataset_title || "", args.dataset_description || "");

    if (args.summary_only) {
      return formatSummary(result);
    }
    return formatFull(result);
  }

  return `Tool sconosciuto: ${name}`;
}

// ─── Formattatori output ──────────────────────────────────────────────────────

function formatSummary(r) {
  const verdictLabel = {
    buona_qualita: '✅ Buona qualità — idoneo alla pubblicazione',
    accettabile_con_riserva: '⚠️ Accettabile con riserva — risolvere gli avvisi',
    non_accettabile: '❌ Non accettabile — correggere gli errori critici',
  };
  return [
    `**Risultato validazione CSV**`,
    `Verdict: ${verdictLabel[r.verdict] || r.verdict}`,
    `Score qualità: ${r.score}/100`,
    `Righe dati: ${r.summary.rows} | Colonne: ${r.summary.columns}`,
    `Check superati: ${r.summary.pass} ✅  Avvisi: ${r.summary.warn} ⚠️  Errori: ${r.summary.fail} ❌`,
    r.criticalFail ? '\n⛔ Errori critici rilevati: il CSV non può essere pubblicato senza correzioni.' : '',
  ].filter(Boolean).join('\n');
}

function formatFull(r) {
  const lines = [formatSummary(r), ''];

  const sections = [
    ['Struttura', r.checks.struttura],
    ['Contenuto', r.checks.contenuto],
    ['Qualità Open Data', r.checks.opendata],
    ['Linked Data / Ontologie', r.checks.linkeddata],
  ];

  const icons = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️', skip: '⏭️' };

  for (const [label, checks] of sections) {
    const relevant = checks.filter(c => c.status !== 'skip');
    if (!relevant.length) continue;
    lines.push(`**${label}**`);
    for (const c of relevant) {
      const icon = icons[c.status] || 'ℹ️';
      lines.push(`${icon} [${c.id}] ${c.title}${c.detail ? ': ' + c.detail : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ─── MCP JSON-RPC handler ─────────────────────────────────────────────────────

function mcpResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body;

  try {
    if (method === 'tools/list') {
      const body = JSON.stringify(mcpResponse(id, { tools: TOOLS }));
      // Supporta sia JSON puro che SSE (il backend ckan-chat legge entrambi)
      const acceptSSE = (req.headers.accept || '').includes('text/event-stream');
      if (acceptSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${body}\n\n`);
        res.end();
      } else {
        res.json(mcpResponse(id, { tools: TOOLS }));
      }
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      const text = await handleToolCall(name, args);
      const result = { content: [{ type: 'text', text }] };

      const acceptSSE = (req.headers.accept || '').includes('text/event-stream');
      if (acceptSSE) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify(mcpResponse(id, result))}\n\n`);
        res.end();
      } else {
        res.json(mcpResponse(id, result));
      }
      return;
    }

    res.json(mcpError(id, -32601, `Metodo non supportato: ${method}`));
  } catch (e) {
    console.error('[validatore-mcp] errore:', e);
    res.status(500).json(mcpError(id, -32603, e.message));
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'validatore-mcp', port: PORT }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[validatore-mcp] pronto su http://0.0.0.0:${PORT}/mcp`);
  console.log(`[validatore-mcp] tool esposti: ${TOOLS.map(t => t.name).join(', ')}`);
});
