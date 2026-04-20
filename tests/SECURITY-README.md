# SIMBA — Security Audit

Scripts per verificare che le mitigazioni di sicurezza di SIMBA reggano contro
classi di attacchi tipici. Output: report Markdown sintetico allegabile a
documentazione interna.

## ⚠ Ambito e limiti

Questi test sono un **security smoke test automatizzato**, NON una Vulnerability
Assessment formale con asseverazione. In particolare:

- Verificano **regressioni** su mitigazioni già in essere, non scoprono
  vulnerabilità nuove come farebbe un pentester umano
- Non coprono code review manuale, supply chain, analisi TLS, social engineering
- Se SIMBA entra in gare PA o perimetri AgID con requisiti formali di sicurezza,
  serve un pentest di terza parte certificata (costo tipico 2000-5000€)

## Scope dei test

6 suite tematiche, ~50 test totali, durata ~6 minuti (include pause per far
sgonfiare i rate limiter tra una suite e l'altra):

1. **Input fuzzing** — payload estremi, caratteri di controllo, JSON malformato
2. **Prompt injection** — tentativi di manipolare il classifier LLM
3. **SPARQL injection** — query malevole al proxy sparql
4. **SSRF** — URL interni, cloud metadata, IP privati su `/api/enrich`
5. **Rate limit** — burst + tentativo bypass via X-Forwarded-For
6. **DoS leggero** — carico concorrente con payload al limite, health check
   post-stress

## Prerequisiti

- Node.js 20+ (nessuna dipendenza npm, solo API native)
- Accesso HTTP(S) al target (tipicamente dominio pubblico o localhost)
- Target operativo con rate limiter attivi (condizione produzione standard —
  NON disabilitare `LOADTEST_BYPASS_IP` per questi test, servono i limiter)

## Esecuzione

```bash
# 1. Lancia l'audit (circa 6 minuti)
BASE_URL=https://chatbot.piersoftckan.biz node tests/security-audit.mjs

# 2. Genera il report Markdown dal JSON prodotto
node tests/report-generator.mjs

# 3. Apri il report
less VA-report.md
```

### File di output

| File | Descrizione |
|------|-------------|
| `security-audit-results.json` | Dati raw, 1 entry per ogni test, timestamp inclusi |
| `VA-report.md` | Report sintetico formattato, da allegare a documentazione |

## Interpretazione esito

**✅ CONFORME** (0 fallimenti): tutte le mitigazioni reggono. Il sistema è
robusto contro le classi di attacco testate.

**⚠ CONFORME CON RISERVE** (1-2 fallimenti): anomalie localizzate, non
critiche ma da investigare. Il report elenca quali test sono falliti e
suggerisce azioni correttive.

**❌ NON CONFORME** (3+ fallimenti): il sistema presenta debolezze su più
dimensioni. Fixare le anomalie e rilanciare prima di allegare il report a
documentazione esterna.

## Frequenza consigliata

- **Prima di ogni release** importante
- **Settimanale** in CI se automatizzato
- **Mensile** in produzione come verifica periodica
- **Immediatamente dopo** cambiamenti a: rate limiters, validatori input,
  pipeline intent, filtri SSRF

## Test complementari (non inclusi in questo audit)

Da lanciare separatamente:

```bash
# CVE su dipendenze npm
cd ckan-chat/backend && npm audit

# CVE su immagini Docker (richiede trivy installato)
trivy image ckan-mcp-server-docker-ollama-backend:latest
trivy image ckan-mcp-server-docker-ollama-validatore-mcp:latest
trivy image ckan-mcp-server-docker-ollama-rdf-mcp:latest
trivy image ckan-mcp-server-docker-ollama-analytics-service:latest

# Analisi TLS e security headers
# curl -I https://chatbot.piersoftckan.biz
# Oppure https://www.ssllabs.com/ssltest/ e https://securityheaders.com/
```

## Modifica / estensione

Ogni suite è una funzione `suiteN_Name()` isolata in `security-audit.mjs`.
Per aggiungere un test nuovo:

1. Aggiungi la chiamata `recordTest(suite, nome, atteso, ottenuto, passed, note)`
   dentro la suite appropriata
2. Se è una classe nuova di attacco, crea una nuova `suiteN_...` e chiamala
   da `main()`
3. Aggiorna `SUITE_DESC` in `report-generator.mjs` con titolo e descrizione

## Note importanti

- I test girano contro il **dominio pubblico**. Durante l'esecuzione il rate
  limiter si attiva per ~1-2 minuti rendendo SIMBA inaccessibile dall'IP del
  tester (NON da altri utenti). Pause fra le suite permettono il reset.
- La Suite 6 invia payload CSV da ~9MB. Verifica di avere banda sufficiente
  se esegui da rete lenta.
- Il codice di uscita è 0 se tutti i test passano, 1 altrimenti — utilizzabile
  in CI/CD come gate di rilascio.

## Riferimenti standard

- [OWASP API Security Top 10 (2023)](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [OWASP LLM Top 10 (2025)](https://genai.owasp.org/)
- [OWASP Top 10 (2021)](https://owasp.org/Top10/)
- [CWE Top 25](https://cwe.mitre.org/top25/)
