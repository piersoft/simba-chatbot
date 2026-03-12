# ckan-mcp-server-docker-ollama

Chat in linguaggio naturale sui dati aperti CKAN, con LLM configurabile (Mistral AI, Ollama locale o Ollama Cloud).

```
[Browser]
    ↓ HTTP :80
[nginx reverse proxy]          ← consigliato in produzione
    ↓ /chatbot         ↓ /api/
[Frontend :8080]   [Backend :3001]
                        ↓                    ↓
               [Mistral AI ☁️]   [ckan-mcp-server :3000]
                 oppure               (dati.gov.it, ecc.)
               [Ollama locale :11434]
                 oppure
               [Ollama Cloud ☁️]
```

## Struttura della repo

```
ckan-mcp-server-docker-ollama/
├── .env                          ← configurazione (vedi sezione sotto)
├── docker-compose-full.yml       ← orchestrazione completa
├── stdio-bridge.js               ← bridge per Claude Desktop
├── ckan-mcp-server/              ← MCP server CKAN (submodule/fork)
│   ├── Dockerfile
│   └── src/
└── ckan-chat/
    ├── backend/
    │   ├── server.js             ← Express + agentic loop LLM ↔ MCP
    │   ├── package.json
    │   └── Dockerfile
    └── frontend/
        ├── src/
        │   ├── App.jsx
        │   ├── index.css
        │   └── components/
        │       ├── ChatMessage.jsx
        │       ├── ToolCallBadge.jsx
        │       └── StatusBar.jsx
        ├── index.html
        ├── package.json
        ├── vite.config.js
        └── Dockerfile
```

## Prerequisiti

- Docker + Docker Compose
- **nginx** (per l'accesso via porta 80 in produzione — vedi sezione [Nginx reverse proxy](#nginx-reverse-proxy))
- Per Mistral AI: API key gratuita da [console.mistral.ai](https://console.mistral.ai)
- Per Ollama Cloud: API key da [ollama.com](https://ollama.com)
- Per Ollama locale: almeno **8 GB di RAM** disponibili per il modello

## Configurazione

Il file `.env` nella root del progetto controlla tutto lo stack. Crea il tuo partendo dall'esempio:

```bash
cp .env.example .env
nano .env
```

### Contenuto del file `.env`

```env
# ── Rete ─────────────────────────────────────────────────────────────────────
SERVER_IP=192.168.0.126
MCP_PORT=3000
BACKEND_PORT=3001
FRONTEND_PORT=8080

# ── Provider LLM: "mistral" oppure "ollama" ───────────────────────────────────
LLM_PROVIDER=mistral

# ── Mistral API ───────────────────────────────────────────────────────────────
MISTRAL_API_KEY=la-tua-chiave-mistral
MISTRAL_MODEL=mistral-small-latest

# ── Ollama (locale o cloud) ───────────────────────────────────────────────────
# Locale:   OLLAMA_URL=http://ollama:11434
# Cloud:    OLLAMA_URL=https://ollama.com

OLLAMA_URL=http://ollama:11434
OLLAMA_API_KEY=
OLLAMA_MODEL=qwen2.5:1.5b

# ── Produzione con nginx reverse proxy ───────────────────────────────────────
# Se usi nginx come reverse proxy sullo stesso server (consigliato):
#   VITE_BACKEND_URL=           ← lascia vuoto, le chiamate /api/ passano per nginx
#   CORS_ORIGIN=http://31.14.xxx.x  ← il tuo IP o dominio pubblico
#
# Se accedi direttamente senza nginx (sviluppo):
#   VITE_BACKEND_URL=http://31.14.xxx.x:3001
#   CORS_ORIGIN=http://31.14.xxx.x:8080
VITE_BACKEND_URL=
CORS_ORIGIN=
```

**Per cambiare provider basta modificare `LLM_PROVIDER` nel `.env`** — nessun altro file va toccato.

## Nginx reverse proxy

In produzione è **fortemente consigliato** usare nginx come reverse proxy davanti ai container Docker. Questo permette di:
- Accedere al chatbot via porta **80** (standard) invece di `:8080`
- Servire `/chatbot` (frontend) e `/api/` (backend) dallo stesso host
- Gestire correttamente gli header `X-Forwarded-For` per il rate limiting

### Installazione e configurazione

```bash
# Installa nginx
apt install -y nginx

# Crea la configurazione
cat > /etc/nginx/sites-available/ckan << 'EOF'
server {
    listen 80;
    server_name _;   # oppure il tuo dominio/IP pubblico

    location /chatbot {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /assets/ {
        proxy_pass http://127.0.0.1:8080/assets/;
        proxy_set_header Host $host;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /favicon.ico { return 204; }
    location / { return 444; }
}
EOF

# Attiva la configurazione
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ckan /etc/nginx/sites-enabled/ckan
nginx -t && systemctl enable nginx && systemctl restart nginx
```

### Configurazione `.env` con nginx

```env
# Con nginx sullo stesso server: VITE_BACKEND_URL vuoto (le chiamate /api/ passano per nginx)
VITE_BACKEND_URL=
# CORS: il tuo IP o dominio pubblico
CORS_ORIGIN=http://31.14.xxx.x
```

Poi rebuilda frontend e backend:

```bash
docker compose -f docker-compose-full.yml up --build frontend backend -d
```

Il chatbot sarà disponibile su `http://<IP>/chatbot` (porta 80).

### Senza nginx (sviluppo locale)

Se preferisci accedere direttamente senza proxy, imposta l'IP nel `.env`:

```env
VITE_BACKEND_URL=http://31.14.xxx.x:3001
CORS_ORIGIN=http://31.14.xxx.x:8080
```

E accedi su `http://<IP>:8080/chatbot`.

### Firewall

Se usi un firewall (UFW o firewall del provider cloud), assicurati di aprire la porta 80:

```bash
# UFW locale
ufw allow 80/tcp
ufw allow 443/tcp
ufw reload

# Su Aruba Cloud / altri provider: aprire la porta 80 nel pannello Security Groups
```

## Avvio

### Scenario 1 — Mistral AI (consigliato)

```bash
# Nel .env: LLM_PROVIDER=mistral

docker compose -f docker-compose-full.yml up --build -d
```

### Scenario 2 — Ollama Cloud

```bash
# Nel .env:
# LLM_PROVIDER=ollama
# OLLAMA_URL=https://ollama.com
# OLLAMA_API_KEY=la-tua-key
# OLLAMA_MODEL=qwen3:4b-cloud

docker compose -f docker-compose-full.yml up --build -d
```

### Scenario 3 — Ollama locale

```bash
# Nel .env:
# LLM_PROVIDER=ollama
# OLLAMA_URL=http://ollama:11434
# OLLAMA_MODEL=qwen2.5:3b

docker compose --profile ollama-local -f docker-compose-full.yml up --build -d
```

> Il profilo `ollama-local` avvia anche i container `ollama` e `ollama-pull` che scaricano automaticamente il modello scelto.

### Comandi utili

```bash
# Rebuild solo del backend (dopo modifiche a server.js o .env)
docker compose -f docker-compose-full.yml up --build backend -d

# Rebuild solo del frontend
docker compose -f docker-compose-full.yml up --build frontend -d

# Stop di tutto
docker compose -f docker-compose-full.yml down

# Stato container
docker compose -f docker-compose-full.yml ps
```

Il chatbot sarà disponibile su:
- **`http://<SERVER_IP>/chatbot`** se usi nginx (consigliato)
- `http://<SERVER_IP>:8080/chatbot` se accedi direttamente ai container

---

## Usare Mistral AI 🇫🇷 (consigliato)

Mistral è un provider europeo (Francia), gratuito per sviluppo e demo, e il più affidabile per il tool calling con CKAN.

1. Registrati su [console.mistral.ai](https://console.mistral.ai)
2. Crea una API key
3. Nel `.env` imposta:

```env
LLM_PROVIDER=mistral
MISTRAL_API_KEY=la_tua_key
MISTRAL_MODEL=mistral-small-latest
```

### Modelli disponibili

| Modello | Piano | Note |
|---|---|---|
| `mistral-small-latest` | Gratuito | Consigliato — ottimo tool calling |
| `open-mistral-nemo` | Gratuito | Completamente open source |
| `mistral-medium-latest` | A pagamento | Più potente |

> Il piano gratuito ha un limite di 1 richiesta/secondo e ~500k token/mese — sufficiente per sviluppo e demo.

---

## Usare Ollama

### Ollama Cloud ☁️

Ollama offre un piano gratuito con GPU cloud potenti — nessun hardware necessario.

1. Registrati su [ollama.com](https://ollama.com)
2. Ottieni la API key
3. Nel `.env` imposta:

```env
LLM_PROVIDER=ollama
OLLAMA_URL=https://ollama.com
OLLAMA_API_KEY=la-tua-key
OLLAMA_MODEL=qwen3:4b-cloud
```

### Ollama locale

Richiede hardware adeguato (vedi tabella sotto). Al primo avvio il container `ollama-pull` scarica automaticamente il modello scelto.

```env
LLM_PROVIDER=ollama
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL=qwen2.5:3b
```

Avviare con il profilo apposito:

```bash
docker compose --profile ollama-local -f docker-compose-full.yml up --build -d
```

### Modelli consigliati con tool calling

| Modello | RAM necessaria | Tool calling | Note |
|---|---|---|---|
| `qwen2.5:1.5b` | 2 GB | ✅ | Minimo assoluto, lento |
| `qwen3:1.7b` | 2 GB | ✅ | Più recente |
| `qwen3:4b` | 4 GB | ✅ | Buon equilibrio |
| `qwen2.5:7b` | 8 GB | ✅ | Consigliato per produzione |
| `mistral-nemo` | 8 GB | ✅ | 🇫🇷 europeo |

### Requisiti hardware minimi per Ollama locale in produzione

| Hardware | RAM | Modello usabile | Velocità stimata |
|---|---|---|---|
| VM con CPU virtuale | 4 GB | `qwen2.5:1.5b` | ~1 tok/sec (lenta) |
| Mac Mini M2 8 GB | 8 GB | `qwen2.5:3b` | ~25 tok/sec |
| Mac Mini M2 16 GB | 16 GB | `qwen2.5:7b` | ~30 tok/sec |
| PC con RTX 3060 12 GB | 16 GB + GPU | `qwen2.5:7b` | ~40 tok/sec |

> ⚠️ Su VM cloud senza GPU (es. VPS Aruba, Hetzner standard) Ollama è molto lento o inutilizzabile. In questi casi usa **Mistral AI** o **Ollama Cloud**.

---

## Integrare con Claude Desktop

Per usare il CKAN MCP server anche da Claude Desktop, aggiungi al file di configurazione:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ckan": {
      "command": "node",
      "args": ["/percorso/stdio-bridge.js"],
      "env": {
        "MCP_URL": "http://<SERVER_IP>:3000/mcp"
      }
    }
  }
}
```

> Vedi `stdio-bridge.js` per il bridge stdio→HTTP necessario con Claude Desktop (le versioni ≤1.1 non supportano URL MCP diretti).

---

## API Backend

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/api/health` | Stato di backend, LLM e MCP |
| GET | `/api/models` | Lista modelli disponibili |
| GET | `/api/tools` | Lista strumenti MCP CKAN |
| POST | `/api/chat` | Invia messaggio, ricevi risposta |

### POST /api/chat

```json
// Request
{
  "messages": [
    { "role": "user", "content": "Cerca dataset sulla qualità dell'aria" }
  ],
  "model": "mistral-small-latest"
}

// Response
{
  "reply": "Ho trovato 399 dataset sulla qualità dell'aria...",
  "toolCalls": [
    {
      "tool": "ckan_package_search",
      "args": {
        "server_url": "https://www.dati.gov.it/opendata",
        "q": "qualità aria"
      }
    }
  ]
}
```

---

## Portali CKAN supportati

Qualsiasi portale CKAN è interrogabile. Esempi:

| Portale | URL |
|---|---|
| Italia | `https://www.dati.gov.it/opendata` |
| USA | `https://catalog.data.gov` |
| Canada | `https://open.canada.ca/data` |
| Australia | `https://data.gov.au` |
| UK | `https://data.gov.uk` |

---

## Log e troubleshooting

```bash
# Log backend
docker logs -f ckan-chat-backend

# Log MCP server
docker logs -f ckan-mcp-server

# Log Ollama (solo con profilo ollama-local)
docker logs -f ollama
```

**Pallini rossi nel frontend (backend/ollama/mcp non raggiungibili)** → Il frontend chiama `localhost:3001` invece di passare per nginx. Verifica che `VITE_BACKEND_URL` sia vuoto nel `.env` e che nginx abbia la `location /api/` configurata. Poi rebuilda il frontend.

**Warning `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`** → Il backend non ha `trust proxy` abilitato. Il `server.js` aggiornato lo include già; se vedi questo warning dopo un aggiornamento, rebuilda il backend.

**Porta 80 non raggiungibile dall'esterno** → Controlla il firewall locale (`ufw status`) e il pannello Security Groups del tuo provider cloud (es. Aruba Cloud → Virtual Private Cloud → Security Groups). Aggiungi la regola TCP porta 80 da `0.0.0.0/0`.

 → rate limit superato; il backend riprova automaticamente dopo 2 secondi.

**Errore `EAI_AGAIN`** → il container non risolve il DNS. Verifica che nel `docker-compose-full.yml` il servizio backend abbia:
```yaml
dns:
  - 8.8.8.8
  - 1.1.1.1
```

**Ollama lento o bloccato** → RAM insufficiente o CPU virtuale senza GPU. Usa Mistral AI o Ollama Cloud.

**Link dataset sbagliati** → I link corretti di dati.gov.it usano il formato `https://www.dati.gov.it/view-dataset/dataset?id=<UUID>`. Il backend è configurato per usare il campo `view_url` restituito dalle API CKAN.

**SyntaxError nel backend** → Controllare che i backtick nelle template literal in `server.js` siano tutti chiusi correttamente.

---

## Licenza

MIT

## Credits

MCP server a cura di [OnData](https://ondata.it)
