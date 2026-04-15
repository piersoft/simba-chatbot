# 🏛 Assistente Open Data Italiani

Chatbot locale per esplorare, validare e convertire i dati aperti della Pubblica Amministrazione italiana. Interamente **self-hosted**, senza dipendenze da Cloudflare o altri servizi cloud esterni.

---

## Architettura

```
[Browser]
    ↓ HTTP :80 (nginx) oppure :8080 (diretto)
[Frontend React :8080]
    ↓ /api/
[Backend Node.js :3001]
    ├── Ollama :11434          ← classificazione intenzione (AI locale)
    ├── validatore-mcp :3002   ← validazione CSV PA italiana
    └── rdf-mcp :3003          ← conversione CSV → RDF/TTL (worker.js CSV-to-RDF)

[Browser] ──SPARQL──→ lod.dati.gov.it   ← ricerca dataset (direttamente dal browser)
```

### Ruolo dell'AI (Ollama)

Ollama interviene **esclusivamente** per classificare l'intenzione dell'utente quando scrive nella casella di testo libera. Riceve il messaggio e risponde con una sola parola tra: `SEARCH`, `VALIDATE`, `ENRICH`, `OFF_TOPIC`.

Prima di chiamare Ollama, il sistema applica un **pre-filtro deterministico** basato sulle keyword del corpus reale di 468 dataset PA italiani (`fixtures_v9.json`): se il testo non contiene nessuna parola riconducibile agli open data, viene classificato `OFF_TOPIC` senza coinvolgere l'AI.

Tutto il resto — ricerca dataset, validazione CSV, conversione RDF — è **completamente deterministico** e non usa AI.

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
│       │       ├── DatasetCard.jsx    ← card con distribuzioni SPARQL
│       │       ├── ValidateReport.jsx ← report validazione
│       │       ├── AdvancedSearch.jsx ← filtri DCAT-AP
│       │       └── StatusBar.jsx
│       └── Dockerfile
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
docker compose -f docker-compose-full.yml up --build frontend -d
docker compose -f docker-compose-full.yml up --build backend -d
docker compose -f docker-compose-full.yml down --remove-orphans
```

---

## API Backend

| Metodo | Path | Descrizione |
|---|---|---|
| `GET` | `/api/health` | Stato backend, Ollama, validatore, rdf-mcp |
| `POST` | `/api/intent` | Classifica intenzione utente (Ollama) |
| `POST` | `/api/sparql` | Proxy SPARQL verso lod.dati.gov.it |
| `POST` | `/api/validate` | Valida CSV da URL |
| `POST` | `/api/validate-text` | Valida CSV da testo grezzo |
| `POST` | `/api/enrich` | Converti CSV in RDF/TTL o RDF/XML |

---

## Troubleshooting

**Pallini rossi nel frontend** → Verifica che `VITE_BACKEND_URL` sia vuoto con nginx, poi `--build frontend`.

**rdf-mcp non parte** → Verifica internet del container: `docker logs rdf-mcp`.

**Ricerca SPARQL lenta o assente** → `lod.dati.gov.it` può avere picchi di carico, riprova. L'endpoint blocca le richieste server-side (403) ma accetta quelle dal browser.

**Ollama lento** → Normale su CPU senza GPU (5-15s). Considera un modello più piccolo o hardware con GPU.

**Orphan containers** → `docker compose -f docker-compose-full.yml up -d --remove-orphans`

---

## Progetti collegati

- [CSV-to-RDF](https://github.com/piersoft/CSV-to-RDF) — tool conversione CSV → RDF e worker.js
- [ckan-opendata-assistant](https://piersoft.github.io/ckan-opendata-assistant/) — versione standalone HTML
- [ckan-mcp-server](https://github.com/ondata/ckan-mcp-server/) — MCP server CKAN di OnData
- [dati-semantic-assets](https://github.com/italia/dati-semantic-assets) — ontologie ufficiali PA italiana

---

## Licenza

MIT — [Piersoft](https://github.com/piersoft)
