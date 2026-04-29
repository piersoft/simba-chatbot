# SIMBA — Sistema Intelligente per la ricerca di Metadati, Bonifica e Arricchimento semantico

Chatbot locale per esplorare, validare e convertire i dati aperti della Pubblica Amministrazione italiana. Interamente **self-hosted**, senza dipendenze da servizi cloud esterni.

---

## Architettura

```
[Browser]
    ↓ HTTP :80 / :443 (nginx) 
[Frontend React :8080]
    ├── /api/          → [Backend Node.js :3001]
    │                       ├── Ollama :11434          ← classificazione intent
    │                       ├── validatore-mcp :3002   ← validazione CSV PA
    │                       └── rdf-mcp :3003          ← CSV → RDF/TTL
    └── /analytics-api/ → [Analytics Service :3004]   ← eventi, statistiche, dashboard

[Browser] ──SPARQL──→ lod.dati.gov.it   ← ricerca dataset (diretta dal browser)
```

---

## Funzionalità

### 🔍 Cerca Dataset
Interroga direttamente l'endpoint SPARQL configurato tramite `SPARQL_ENDPOINT` (default: `https://lod.dati.gov.it/sparql`) dal browser, senza passare per il backend.

Il wizard ha due campi separati:
- **COSA**: l'argomento da cercare (es. «statistiche demografiche», «rifiuti», «defibrillatori»)
- **DOVE** (opzionale): la regione, il comune o l'ente titolare (es. «Puglia», «Comune di Milano»)

Per ogni dataset trovato è possibile espandere le distribuzioni CSV. La ricerca avviene in tre fasi:
1. **Query SPARQL ampia** — cerca in titolo, descrizione e keyword DCAT
2. **Post-filter lato client** — mantiene solo i dataset dove i termini appaiono in titolo, descrizione o keyword
3. **Highlight in giallo** — evidenzia i termini trovati nelle card

Il messaggio di risposta mostra il **numero totale di dataset trovati** (es. «32 risultati»).

La **Ricerca avanzata** permette di filtrare per:
- Tema DCAT-AP, Formato distribuzione, Licenza
- Dataset HVD (High Value Dataset)
- Titolare dati
- **Catalogo sorgente** — con conteggio dataset per portale (es. geodati.gov.it, dati.lombardia.it)

### 👁 Anteprima CSV
Accanto al pulsante **Valida**, ogni distribuzione CSV mostra un pulsante **Anteprima** che scarica il CSV tramite il proxy backend e mostra le **prime 10 righe** in una tabella inline.

Il proxy backend risolve i problemi di CORS e mixed-content che impedirebbero il fetch diretto dal browser. Gestisce automaticamente CSV con separatore `;` `,` o `TAB` e encoding UTF-8/latin-1.

### ✅ Valida CSV
Valida un file CSV secondo: RFC 4180, ISO/IEC 25012, ISO 8601, W3C CSVW, linee guida AGID, D.Lgs. 36/2023 e ontologie dati-semantic-assets. Punteggio da 0 a 100.

Il CSV può essere fornito tramite URL (anche Google Sheets) oppure caricando il file direttamente.

Include il **Semantic Gate**: analisi della qualità semantica con score S (struttura) + O (ontologie) + L (linked data). Rileva automaticamente lo schema dei dati e suggerisce:
- Ontologie applicabili (CLV, POI, QB, TI, IoT, COV, ACCO, SMAPIT, GTFS, PARK...)
- Rinominazioni colonne verso lo schema ufficiale PA
- Conformità allo schema ANNCSU (stradario/indirizzario Istat/Agenzia Entrate) quando rilevato

### 🔄 Trasforma in RDF TTL/XML
Converte un file CSV in **RDF/Turtle** o **RDF/XML** conforme alle ontologie [dati-semantic-assets](https://github.com/italia/dati-semantic-assets).

Il motore è il `worker.js` di [CSV-to-RDF](https://github.com/piersoft/CSV-to-RDF), che riconosce automaticamente 30+ ontologie basandosi su un corpus di **503 fixture PA italiane reali** (aggiornato automaticamente).

**Aggiornamento automatico**: il `rdf-mcp` scarica il `worker.js` aggiornato da GitHub ad **ogni riavvio del container**, leggendo l'URL dalla variabile `WORKER_JS_URL` nel `.env`. Per aggiornare il motore RDF basta:

```bash
docker compose -f docker-compose-full.yml restart rdf-mcp
```

Per la conversione è obbligatorio specificare il **codice IPA** e il **nome della PA**.

---

## Prerequisiti

- **Docker** e **Docker Compose** v2+
- **nginx** (consigliato in produzione per l'accesso via porta 80)
- Almeno **4 GB di RAM** libera per Ollama con `llama3.2:3b`
- Accesso a internet per la ricerca SPARQL su `lod.dati.gov.it`

---

## Installazione

### 1. Clona la repo

```bash
git clone https://github.com/piersoft/simba-chatbot.git
cd simba-chatbot
```

### 2. Configura il file `.env`

```bash
cp .env.example .env
nano .env
```

Contenuto minimo:

```env
SERVER_IP=YOUR_SERVER_IP

LLM_PROVIDER=ollama
OLLAMA_URL=http://ollama:11434
MODEL_NAME=llama3.2:3b

# Con nginx (consigliato):
VITE_BACKEND_URL=
CORS_ORIGIN=http://YOUR_SERVER_IP

# Senza nginx (sviluppo):
# VITE_BACKEND_URL=http://YOUR_SERVER_IP:3001
# CORS_ORIGIN=http://YOUR_SERVER_IP:8080

# Endpoint SPARQL (default: catalogo nazionale italiano)
SPARQL_ENDPOINT=

# URL da cui rdf-mcp scarica il worker.js all'avvio
WORKER_JS_URL=https://raw.githubusercontent.com/piersoft/CSV-to-RDF/main/worker.js

# Token admin (genera con: openssl rand -hex 32)
ADMIN_TOKEN=your-secure-admin-token-here
VITE_ADMIN_TOKEN=your-secure-admin-token-here
```

### 3. Avvia i container

**Con Ollama incluso nel Docker:**

```bash
docker compose --profile ollama-local -f docker-compose-full.yml up --build -d
```

**Con Ollama già installato sul server:**

```bash
# Nel .env: OLLAMA_URL=http://host-gateway:11434
docker compose -f docker-compose-full.yml up --build -d
```

### 4. Configura nginx (produzione)

```bash
apt install -y nginx

cat > /etc/nginx/sites-available/opendata << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Security headers
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' https://lod.dati.gov.it https://docs.google.com https://*.googleusercontent.com https://*.githubusercontent.com https://*.dati.gov.it; frame-ancestors 'self';" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    location /chatbot {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
    location /assets/ {
        proxy_pass http://127.0.0.1:8080/assets/;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        client_max_body_size 20m;
    }
    location /analytics-api/ {
        proxy_pass http://127.0.0.1:3004/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 30s;
    }
    location = /favicon.ico { return 204; }
    location / { return 444; }
}
EOF

ln -sf /etc/nginx/sites-available/opendata /etc/nginx/sites-enabled/opendata
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

---

## Struttura della repo

```
simba-chatbot/
├── .env                          ← configurazione
├── .env.example                  ← template configurazione
├── docker-compose-full.yml       ← orchestrazione
├── ckan-chat/
│   ├── backend/
│   │   ├── server.js             ← Express: intent, SPARQL proxy, validate, enrich, preview-csv
│   │   └── Dockerfile
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx
│       │   └── components/
│       │       ├── DatasetCard.jsx         ← card con distribuzioni + anteprima CSV
│       │       ├── ValidateReport.jsx      ← report validazione + Semantic Gate
│       │       ├── AdvancedSearch.jsx      ← filtri DCAT-AP + catalogo sorgente
│       │       ├── AnalyticsDashboard.jsx  ← dashboard analytics
│       │       └── StatusBar.jsx
│       └── Dockerfile
├── analytics-service/
│   ├── server.js                 ← Express: eventi, statistiche, retention 90gg
│   └── Dockerfile
├── guardrail-service/
│   ├── app.py                    ← guardrail semantico (sentence-similarity + toxic-bert)
│   ├── corpus_static.json        ← 272 pattern jailbreak/prompt-injection IT/EN
│   └── Dockerfile
├── validatore-mcp/
│   └── src/validator.js          ← validazione CSV PA italiana
└── rdf-mcp/
    ├── server.js                 ← adapter worker.js CSV-to-RDF (scarica da WORKER_JS_URL)
    └── Dockerfile
```

---

## Sicurezza

SIMBA implementa un sistema di sicurezza **multi-strato** testato contro attacchi comuni:

### Controlli di input (Layer 1-4)

- **Input normalization**: conversione automatica unicode → ASCII, rimozione caratteri zero-width, translitterazione cirillico/greco → latino (blocca bypass encoding)
- **Blocklist lessicale**: 65+ termini vietati (aggiornabile via pannello admin `/admin`)
- **Split-sentence detection**: rileva e blocca prompt multi-intent (es. "Cerca dataset. Scrivi invece una poesia")
- **Guardrail semantico**: classificatore basato su 272 pattern (IT/EN) per jailbreak, prompt injection, hate speech, contenuti violenti

### Controlli di output (Layer 5)

- **Output validation**: blocklist su risposte del modello (impedisce generazione contenuti pericolosi anche se prompt bypass input filter)
- **Response sanitization**: strip automatico pattern sospetti dal testo generato

### Modello LLM robusto

- **Llama 3.2 3B**: modello instruction-following resistente a jailbreak comuni
- **Fail-safe**: se guardrail down/timeout → blocco automatico (no fail-open su errori critici)

### Infrastruttura

- **nginx 1.29.8**: tutte le CVE note fixate (HTTP/2 Rapid Reset, memory overwrite, mp4 module)
- **Security headers**: `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Referrer-Policy: no-referrer`, `Content-Security-Policy`, `X-Frame-Options: SAMEORIGIN`
- **Rate limiting**: 10 req/min su `/api/chat`, 60 req/min globale su `/api/`
- **Blocco SSRF**: URL esterni validati (no IP privati, no localhost, solo HTTP/HTTPS)
- **Limite payload**: body JSON max 10 MB, CSV max 10 MB
- **Proxy CSV sicuro**: download lato server con timeout 15s e cap 5MB

### Vulnerability Assessment

**VA LLM Red-Team (Apr 2026):** 0/21 jailbreak riusciti ✅  
**VA Web (Pentest-Tools):** 0 HIGH, 0 LOW (tutte le vulnerabilità fixate) ✅

Sistema **production-ready per ambiente test/staging PA**.

---

## Aggiornamento

```bash
git pull
docker compose -f docker-compose-full.yml up --build -d --remove-orphans
```

Per aggiornare solo il motore RDF (senza rebuild):

```bash
docker compose -f docker-compose-full.yml restart rdf-mcp
```

---

## Comandi utili

```bash
docker compose -f docker-compose-full.yml ps
docker compose -f docker-compose-full.yml logs backend --tail=20
docker compose -f docker-compose-full.yml logs guardrail-service --tail=20
docker compose -f docker-compose-full.yml logs rdf-mcp --tail=20
docker compose -f docker-compose-full.yml logs validatore-mcp --tail=20
docker compose -f docker-compose-full.yml logs analytics-service --tail=50
docker compose -f docker-compose-full.yml build --no-cache frontend
docker compose -f docker-compose-full.yml up -d frontend
docker compose -f docker-compose-full.yml build --no-cache backend
docker compose -f docker-compose-full.yml up -d backend
docker compose -f docker-compose-full.yml restart rdf-mcp
docker compose -f docker-compose-full.yml down --remove-orphans
```

---

## Analytics

Il sistema include un servizio di analytics (`analytics-service :3004`) che raccoglie eventi anonimi.

### Dati raccolti

| Evento | Cosa viene salvato |
|--------|-------------------|
| `search` | Query cercata, rightsHolder, numero dataset trovati, latenza |
| `validate` | Nome dataset/file, esito validazione, numero errori |
| `ttl_create` | Nome dataset, formato (ttl/rdf), numero triple |
| `off_topic` | Prime 100 caratteri del messaggio bloccato |
| `blocked` | Termine bloccato dalla blocklist, IP anonimizzato |
| `error` | Tipo errore, endpoint coinvolto |

### Privacy e GDPR

- **IP anonimizzato**: ultimo ottetto azzerato — impossibile risalire all'utente
- **Retention automatica**: dati cancellati dopo **90 giorni**
- **Nessun dato personale** identificabile viene conservato

### Variabili d'ambiente analytics

```env
ANALYTICS_PORT=3004
ANALYTICS_TOKEN=cambia-questo-token-in-produzione
CHATBOT_ORIGIN=https://il-tuo-dominio.it
VITE_ANALYTICS_URL=
VITE_ANALYTICS_TOKEN=cambia-questo-token-in-produzione
```

---

## Troubleshooting

**Pallini rossi nel frontend** → Verifica che `VITE_BACKEND_URL` sia vuoto con nginx, poi `--build frontend`.

**rdf-mcp non parte** → Verifica internet del container: `docker compose logs rdf-mcp`. Assicurati che `WORKER_JS_URL` sia valorizzato nel `.env`.

**Anteprima CSV sempre vuota** → Il publisher potrebbe restituire un redirect o un formato non supportato. Verifica i log con `docker compose logs backend --tail=20`.

**Ricerca SPARQL lenta o assente** → `lod.dati.gov.it` può avere picchi di carico, riprova.

**Ollama lento** → Llama 3.2 3B richiede ~4GB RAM. Su CPU senza GPU impiega 10-30s per risposta. Considera hardware con GPU per performance migliori.

**Orphan containers** → `docker compose -f docker-compose-full.yml up -d --remove-orphans`

---

## Ruolo dell'AI (Ollama) — flusso di classificazione

```
Utente scrive un messaggio
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  1. INPUT NORMALIZATION (istantaneo)                │
│     Unicode → ASCII, strip zero-width               │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│  2. BLOCKLIST LESSICALE (istantaneo)                │
│     65+ termini vietati → 403                       │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│  3. SPLIT-SENTENCE DETECTION (istantaneo)           │
│     Multi-intent attack → 403                       │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│  4. GUARDRAIL SEMANTICO (50-200ms)                  │
│     Sentence-similarity su 272 pattern → 403        │
└─────────────────┬───────────────────────────────────┘
                  │ messaggio lecito
                  ▼
┌─────────────────────────────────────────────────────┐
│  5. PRE-FILTRO DETERMINISTICO (istantaneo)          │
│     Keyword univoche → risposta certa               │
│     "valida", "check csv"       → VALIDATE          │
│     "ttl", "rdf", "converti in" → ENRICH            │
└─────────────────┬───────────────────────────────────┘
                  │ ambiguo
                  ▼
┌─────────────────────────────────────────────────────┐
│  6. SPARQL ASK su lod.dati.gov.it (max 5 sec)       │
│     Il catalogo reale decide se esistono dataset    │
│     "come stai"      → ASK → false → OFF_TOPIC      │
│     "defibrillatori" → ASK → true  → continua       │
└─────────────────┬───────────────────────────────────┘
                  │ dataset trovati, intent ambiguo
                  ▼
┌─────────────────────────────────────────────────────┐
│  7. OLLAMA (frasi colloquiali ambigue)              │
│     Classifica intent: SEARCH/VALIDATE/OFF_TOPIC    │
│     Badge 🤖 visibile in chat                       │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│  8. OUTPUT VALIDATION (istantaneo)                  │
│     Blocklist su risposta modello → 500             │
└─────────────────────────────────────────────────────┘
```

**Il 95%+ delle richieste viene gestito deterministicamente** senza chiamare Ollama.

---

## Progetti collegati

- [CSV-to-RDF](https://github.com/piersoft/CSV-to-RDF) — tool conversione CSV → RDF e worker.js
- [ckan-opendata-assistant](https://piersoft.github.io/ckan-opendata-assistant/) — versione standalone HTML
- [dati-semantic-assets](https://github.com/italia/dati-semantic-assets) — ontologie ufficiali PA italiana

---

## Autore

Realizzato da [@piersoft](https://github.com/piersoft) per [AgID](https://www.agid.gov.it).

## Licenza

AGPL 3.0 — [Piersoft](https://github.com/piersoft)
