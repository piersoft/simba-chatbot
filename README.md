# Assistente Open Data Italiani

Chatbot locale per esplorare, validare e convertire i dati aperti della Pubblica Amministrazione italiana. Interamente **self-hosted**, senza dipendenze da Cloudflare o altri servizi cloud esterni.

---

## Architettura

```
[Browser]
    ↓ HTTP :80 / :443 (nginx) oppure :8080 (diretto)
[Frontend React :8080]
    ├── /api/          → [Backend Node.js :3001]
    │                       ├── Ollama :11434          ← classificazione intenzione
    │                       ├── validatore-mcp :3002   ← validazione CSV PA
    │                       └── rdf-mcp :3003          ← CSV → RDF/TTL
    └── /analytics-api/ → [Analytics Service :3004]   ← eventi, statistiche, dashboard

[Browser] ──SPARQL──→ lod.dati.gov.it   ← ricerca dataset (diretta dal browser)
```


---

## Funzionalità

### 🔍 Cerca Dataset
Interroga direttamente l'endpoint SPARQL di **lod.dati.gov.it** (`https://lod.dati.gov.it/sparql`) dal browser, senza passare per il backend. La query SPARQL cerca per parole chiave in titolo, descrizione e keyword dei dataset DCAT-AP IT.

Per ogni dataset trovato è possibile espandere le distribuzioni CSV, recuperate tramite una seconda query SPARQL usando la proprietà `dcat:downloadURL`.

La **Ricerca avanzata** permette di filtrare per tema DCAT, formato, licenza, dataset HVD e publisher.

### ✅ Valida CSV
Valida un file CSV secondo le **linee guida AgID** per la qualità dei dati aperti della PA italiana. Controlla struttura, contenuto, conformità open data e linked data.

Il CSV può essere fornito tramite URL (anche Google Sheets) oppure caricando il file direttamente. Punteggio da 0 a 100. Esito: **Ottima qualità** / **Accettabile con riserva** / **Non accettabile**.

Il validatore è basato su [`validatore-csv-pa.html`](https://piersoft.github.io/CSV-to-RDF/validatore-csv-pa.html) e gira interamente in locale.

### 🔄 Trasforma in RDF TTL/XML
Converte un file CSV in **RDF/Turtle** o **RDF/XML** conforme alle ontologie ufficiali [dati-semantic-assets](https://github.com/italia/dati-semantic-assets).

Il motore è il `worker.js` di [CSV-to-RDF](https://github.com/piersoft/CSV-to-RDF), che riconosce automaticamente 29 ontologie basandosi su un corpus di 468 fixture PA italiane reali.

**Aggiornamento automatico**: il `rdf-mcp` scarica il `worker.js` aggiornato ogni notte alle 3:00, recependo nuovi corpus e ontologie senza intervento manuale.

Prima della conversione è possibile specificare il **codice IPA** e il **nome della PA** per costruire URI RDF corretti.

---

## Prerequisiti

- **Docker** e **Docker Compose** v2+
- **nginx** (consigliato in produzione per l'accesso via porta 80)
- Almeno **2 GB di RAM** libera per Ollama con `qwen2.5:1.5b`
- Accesso a internet per la ricerca SPARQL su `lod.dati.gov.it`

---

## Installazione

### 1. Clona la repo

```bash
git clone https://github.com/piersoft/ckan-mcp-server-docker-ollama.git
cd ckan-mcp-server-docker-ollama
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
OLLAMA_MODEL=qwen2.5:1.5b

# Con nginx (consigliato):
VITE_BACKEND_URL=
CORS_ORIGIN=http://YOUR_SERVER_IP

# Senza nginx (sviluppo):
# VITE_BACKEND_URL=http://YOUR_SERVER_IP:3001
# CORS_ORIGIN=http://YOUR_SERVER_IP:8080
```

### 3. Avvia i container

**Con Ollama incluso nel Docker (scarica il modello automaticamente):**

```bash
docker compose --profile ollama-local -f docker-compose-full.yml up --build -d
```

Il profilo `ollama-local` avvia anche i container `ollama` e `ollama-pull` che scaricano automaticamente il modello `qwen2.5:1.5b` (~1 GB).

**Con Ollama già installato e avviato sul server (senza profilo):**

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
    # Analytics service — protetto da HTTP Basic Auth
    location /chatbot/analytics {
        auth_basic "Analytics — accesso riservato";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
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

Il chatbot sarà disponibile su `http://YOUR_SERVER_IP/chatbot`.

Per proteggere la dashboard analytics con login HTTP Basic:

```bash
apt install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd admin
# inserisci la password quando richiesto
nginx -t && systemctl reload nginx
```

La dashboard analytics sarà disponibile su `http://YOUR_SERVER_IP/chatbot/analytics`.

---

## Struttura della repo

```
ckan-mcp-server-docker-ollama/
├── .env                          ← configurazione
├── docker-compose-full.yml       ← orchestrazione
├── ckan-chat/
│   ├── backend/
│   │   ├── server.js             ← Express: intent, SPARQL proxy, validate, enrich
│   │   └── Dockerfile
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx
│       │   └── components/
│       │       ├── DatasetCard.jsx         ← card con distribuzioni SPARQL
│       │       ├── ValidateReport.jsx      ← report validazione
│       │       ├── AdvancedSearch.jsx      ← filtri DCAT-AP
│       │       ├── AnalyticsDashboard.jsx  ← dashboard analytics
│       │       └── StatusBar.jsx
│       └── Dockerfile
├── analytics-service/
│   ├── server.js                 ← Express: eventi, statistiche, retention 90gg
│   ├── db/sqlite.js              ← adapter SQLite (drop-in per ClickHouse)
│   └── Dockerfile
├── validatore-mcp/
│   └── src/validator.js          ← validazione CSV PA italiana
└── rdf-mcp/
    ├── server.js                 ← adapter worker.js CSV-to-RDF
    └── Dockerfile
```

---

## Aggiornamento

```bash
git pull
docker compose -f docker-compose-full.yml up --build -d --remove-orphans
```

---

## Comandi utili

```bash
docker compose -f docker-compose-full.yml ps
docker logs -f ckan-chat-backend
docker logs -f rdf-mcp --tail=20
docker logs -f validatore-mcp --tail=20
docker logs -f analytics-service --tail=50
docker compose -f docker-compose-full.yml up --build frontend -d
docker compose -f docker-compose-full.yml up --build backend -d
docker compose -f docker-compose-full.yml up --build analytics-service -d
docker compose -f docker-compose-full.yml down --remove-orphans
```

---

## Analytics

Il sistema include un servizio di analytics (`analytics-service :3004`) che raccoglie eventi anonimi per monitorare l'utilizzo del chatbot.

### Dati raccolti

| Evento | Cosa viene salvato |
|--------|--------------------|
| `search` | Query cercata, rightsHolder, numero dataset trovati, latenza |
| `validate` | Nome dataset/file, esito validazione, numero errori |
| `ttl_create` | Nome dataset, formato (ttl/rdf), numero triple |
| `off_topic` | Prime 100 caratteri del messaggio bloccato |
| `error` | Tipo errore, endpoint coinvolto |

### Privacy e GDPR

- **IP anonimizzato**: ultimo ottetto azzerato (`1.2.3.0`) — impossibile risalire all'utente
- **User agent**: salvato solo come `OS / Browser` (es. `Windows / Chrome`), senza versione
- **Session ID**: UUID casuale generato nel browser, senza correlazione con l'identità
- **Retention automatica**: i dati vengono cancellati automaticamente dopo **90 giorni**
- **Nessun dato personale** identificabile viene conservato

### Dashboard

Disponibile su `/chatbot/analytics` (protetta da HTTP Basic Auth).

Mostra: sessioni uniche, ricerche per giorno, top keyword, top dataset validati/TTL, tasso off-topic, latenza Ollama, errori per tipo.

### Scalabilità

Il database SQLite è sufficiente fino a ~50.000 eventi/giorno. Per volumi maggiori, sostituire `db/sqlite.js` con `db/clickhouse.js` (stessa interfaccia) senza modificare nient'altro.

---

## Sicurezza

Il backend applica i seguenti controlli su tutti gli endpoint:

- **Rate limiting globale**: max 60 richieste/minuto per IP su `/api/`
- **Rate limiting strict**: max 20 richieste/minuto su validate, enrich, intent
- **Blocco SSRF**: gli endpoint che accettano URL esterni rifiutano indirizzi IP privati, localhost e link non HTTPS
- **Limite payload**: body JSON max 2 MB, CSV max 2 MB
- **Validazione input**: lunghezza massima messaggi (500 caratteri), codice IPA solo alfanumerico
- **Header di sicurezza**: `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`

---

## Troubleshooting

**Pallini rossi nel frontend** → Verifica che `VITE_BACKEND_URL` sia vuoto con nginx, poi `--build frontend`.

**rdf-mcp non parte** → Verifica internet del container: `docker logs rdf-mcp`.

**Ricerca SPARQL lenta o assente** → `lod.dati.gov.it` può avere picchi di carico, riprova. L'endpoint blocca le richieste server-side (403) ma accetta quelle dal browser.

**Ollama lento** → Normale su CPU senza GPU (5-15s). Considera un modello più piccolo o hardware con GPU.

**Orphan containers** → `docker compose -f docker-compose-full.yml up -d --remove-orphans`

---

### Ruolo dell'AI (Ollama) — flusso di classificazione

Quando l'utente scrive nella casella di testo libera, il sistema segue questo flusso a tre livelli:

```
Utente scrive un messaggio
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  1. PRE-FILTRO DETERMINISTICO (istantaneo)          │
│     Keyword univoche → risposta certa               │
│     "valida", "check csv"       → VALIDATE          │
│     "ttl", "rdf", "converti in" → ENRICH            │
└─────────────────┬───────────────────────────────────┘
                  │ ambiguo
                  ▼
┌─────────────────────────────────────────────────────┐
│  2. SPARQL ASK su lod.dati.gov.it (max 5 sec)       │
│     Il catalogo reale decide se esistono dataset    │
│     "torta della nonna" → ASK → false → OFF_TOPIC   │
│     "defibrillatori"    → ASK → true  → continua   │
│     "ricette pugliesi"  → ASK → true  → continua   │
└─────────────────┬───────────────────────────────────┘
                  │ dataset trovati, intent ancora ambiguo
                  ▼
┌─────────────────────────────────────────────────────┐
│  3. OLLAMA (solo per disambiguare ~5% dei casi)     │
│     "ho un file da controllare" → VALIDATE          │
│     "voglio i linked data"      → ENRICH            │
│     "defibrillatori Mesagne"    → SEARCH            │
└─────────────────────────────────────────────────────┘
```

**Il 95% delle richieste viene gestito deterministicamente** dai livelli 1 e 2.  
**Ollama interviene solo** quando esistono dataset sull'argomento ma l'intenzione è ambigua.

Tutto il resto — esecuzione della ricerca SPARQL, validazione CSV, conversione RDF — è **completamente deterministico** e non usa AI.


---

## Progetti collegati

- [CSV-to-RDF](https://github.com/piersoft/CSV-to-RDF) — tool conversione CSV → RDF e worker.js
- [ckan-opendata-assistant](https://piersoft.github.io/ckan-opendata-assistant/) — versione standalone HTML
- [ckan-mcp-server](https://github.com/ondata/ckan-mcp-server/) — MCP server CKAN di OnData
- [dati-semantic-assets](https://github.com/italia/dati-semantic-assets) — ontologie ufficiali PA italiana

---

## Licenza

MIT — [Piersoft](https://github.com/piersoft)
