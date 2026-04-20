# SIMBA — Regression tests

Test suite per verificare il comportamento del chatbot SIMBA prima di ogni
deploy. Al momento è incluso un solo test: il classificatore di intent.

## intent-classifier.mjs

Stress test del classificatore `/api/intent` con **40 domande in 8 categorie**
scelte per coprire sia i casi d'uso tipici che i casi-trappola.

### Categorie

| Categoria       | Casi | Scopo                                                      |
|-----------------|:----:|------------------------------------------------------------|
| `base`          |  20  | Mix rappresentativo di SEARCH/VALIDATE/ENRICH/OFF_TOPIC    |
| `fact-trap`     |   4  | Fatti puntuali travestiti da search (sindaco, prezzi, orari) |
| `meta-bot`      |   4  | Domande sul bot stesso (chi sei, cosa fai, quanto costi)   |
| `llm-task`      |   3  | Task generici da LLM (traduci, riassumi, scrivi email)     |
| `search-ambig`  |   3  | SEARCH con parole-trappola (sportivi, eventi, ricette)     |
| `enrich-alt`    |   2  | Varianti ENRICH per robustezza pre-filtro                  |
| `validate-alt`  |   2  | Varianti VALIDATE per robustezza pre-filtro                |
| `sigle-pa`      |   2  | Whitelist sigle PA corte (PNRR, CIG)                       |

### Come lanciarlo

**`BASE_URL` è obbligatoria**: senza di essa il test si rifiuta di partire
(nessun default hardcoded a un dominio specifico, così se il dominio
di produzione cambia il test non gira per sbaglio contro l'URL vecchio).

```bash
# puntando al backend di produzione
BASE_URL=https://tuo-dominio.it node tests/intent-classifier.mjs

# puntando al backend locale in dev
BASE_URL=http://localhost:3001 node tests/intent-classifier.mjs

# via npm script (imposta BASE_URL nell'ambiente prima)
BASE_URL=https://tuo-dominio.it npm --prefix ckan-chat/backend run test:intent

# con delay diverso (default 3500ms per rispettare rate limit 20/min)
BASE_URL=http://localhost:3001 DELAY_MS=2000 node tests/intent-classifier.mjs
```

Il backend deve essere up e raggiungibile all'URL passato.
Nessuna dipendenza esterna: usa solo `fetch` nativo di Node 18+.

Durata stimata: ~2m20s (40 domande × 3.5s delay per rispettare lo
`strictLimiter` del backend — 20 req/min).

### Output

**Console**: tabella colorata raggruppata per categoria, con colonne:
- `#`, `Cat`, `Q` (query), `Atteso`, `Ricevuto`, `AI` (llm/det), `ms`, `✓/✗`

**File generati nella cwd**:
- `simba-intent-results.csv` — tabellare, importabile in spreadsheet
- `simba-intent-results.json` — dump completo con raw body per debug

**Exit code**: 0 se tutto pass, 1 se ci sono mismatch, 2 se errore fatale.

### Cosa misura

Per ogni domanda viene chiamato `POST /api/intent` e confrontato il campo
`intent` della risposta con il valore atteso. Il campo `ai_used` nella
risposta distingue decisioni deterministiche (pre-filtro parole-chiave o
SPARQL ASK) da decisioni LLM (qwen3:1.7b o Mistral).

La pipeline testata nel backend è:

1. **Pre-filtro deterministico** (`preFilterIntent` in `server.js`)
   - `validateKw` → VALIDATE
   - `enrichKw` → ENRICH
   - `offTopicKw` → OFF_TOPIC
   - `searchPatterns` (regex `/^elenco/`, `/^dati su/`, `/^quant[ie].*ci sono/`) → SEARCH
2. **SPARQL ASK** su lod.dati.gov.it: se il catalogo non contiene le keyword → OFF_TOPIC
3. **LLM**: disambigua i casi rimanenti con `INTENT_PROMPT`

### Casi accettanti più esiti

Alcune domande ammettono più classificazioni corrette (vedi `expected`
come array), perché sono deliberatamente border. Esempio: #19 "Che
significa DCAT-AP_IT?" può ragionevolmente essere OFF_TOPIC (domanda
educational) o SEARCH (meta-ricerca su standard dati.gov.it).

### Aggiungere nuovi casi

Edita l'array `TESTS` in `intent-classifier.mjs`. Convenzioni:
- `id` incrementale
- `cat` una delle categorie esistenti o una nuova
- `q` la domanda esatta che l'utente scriverebbe
- `expected` stringa o array di stringhe ammesse
- `note` motivo/ipotesi del caso (utile per il debug dei mismatch)


## load-test.mjs

Load test con N worker concorrenti che simulano utenti che fanno query miste
(intent/sparql/enrich con pesi realistici 60/35/5%) per M secondi. Misura
latenze percentili (p50/p75/p95/p99), throughput, error rate.

### Preparazione (obbligatoria)

Il backend ha rate limiter aggressivi (20 req/min su /api/intent). Per un
load test devi bypassarli per l'IP del tester:

1. Aggiungi al `.env` sul server: `LOADTEST_BYPASS_IP=127.0.0.1`
2. Ricrea il backend: `docker compose ... stop backend && rm -f backend && up -d backend`
3. Verifica nel log: dovresti poter fare >20 richieste/min da localhost
4. **Al termine del test, rimuovi la variabile dal .env e ricrea backend**

### Come lanciarlo

```bash
# Sul server, in 2 finestre separate

# Finestra 1 — campionamento risorse Docker
bash tests/resource-sampler.sh

# Finestra 2 — carico generato
BASE_URL=http://localhost:3001 node tests/load-test.mjs

# Oppure con parametri custom
BASE_URL=http://localhost:3001 CONCURRENCY=50 DURATION_SEC=300 node tests/load-test.mjs
```

### Output

- Console: progress ogni 10s, report finale tabellare
- `load-test-results.json` — dump completo
- `load-test-stats.csv` — campionamento CPU/MEM di ollama, backend, validatore, rdf-mcp

### Parametri (tutti via env var)

| Var | Default | Note |
|---|---|---|
| `BASE_URL` | (obbligatoria) | URL backend, tipicamente `http://localhost:3001` |
| `CONCURRENCY` | 50 | Worker paralleli |
| `DURATION_SEC` | 300 | Durata test in secondi |
| `THINK_MIN_MS` | 200 | Min delay tra richieste dello stesso worker |
| `THINK_MAX_MS` | 800 | Max delay tra richieste dello stesso worker |
| `TIMEOUT_MS` | 30000 | Timeout per singola richiesta |

### Interpretazione risultati

- **p50**: latenza mediana — esperienza tipica utente
- **p95**: il 5% dei casi peggiori — sensazione di lentezza percepita
- **p99**: code estrema — outlier, spesso correlati a SPARQL esterno lento
- **Error rate > 5%**: sistema sovraccarico
- **p95 > 5s**: UX inaccettabile (soglia oltre cui l'utente abbandona)
