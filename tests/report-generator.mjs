#!/usr/bin/env node
/**
 * SIMBA — Generatore report VA
 * ============================
 * Prende security-audit-results.json e produce un report Markdown sintetico
 * pronto da allegare al committente.
 *
 * Uso:
 *   node tests/report-generator.mjs
 *   node tests/report-generator.mjs --input security-audit-results.json --output VA-report.md
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i+1] : def;
};
const INPUT  = getArg("--input",  "security-audit-results.json");
const OUTPUT = getArg("--output", "VA-report.md");

if (!fs.existsSync(INPUT)) {
  console.error(`File ${INPUT} non trovato. Lancia prima: node tests/security-audit.mjs`);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(INPUT, "utf-8"));

const SUITE_DESC = {
  "input-fuzzing": {
    title: "1. Input fuzzing (payload estremi)",
    what: "Invio di payload malformati, stringhe molto lunghe, caratteri di controllo/null bytes, JSON invalido per verificare che le validazioni di input non falliscano silenziosamente o causino crash.",
    coverage: "OWASP API4:2023 (Unrestricted Resource Consumption), OWASP API8:2023 (Security Misconfiguration).",
  },
  "prompt-injection": {
    title: "2. Prompt injection sul classifier LLM",
    what: "Tentativi di manipolare il prompt di sistema del classificatore intent (qwen2.5:0.5b) per fargli produrre classificazioni arbitrarie. Include tentativi in italiano, inglese, con marker di ruolo e con payload Markdown.",
    coverage: "OWASP LLM01:2025 (Prompt Injection).",
  },
  "sparql-injection": {
    title: "3. SPARQL injection",
    what: "Invio di query SPARQL malevole (LOAD, CLEAR, DROP, INSERT DATA, UNION malformati) al proxy /api/sparql per verificare che il backend non esegua operazioni pericolose in locale e che il triplestore remoto gestisca correttamente.",
    coverage: "OWASP API8:2023, CWE-943 (Improper Neutralization of Special Elements in Data Query Logic).",
  },
  "ssrf": {
    title: "4. SSRF (Server-Side Request Forgery)",
    what: "Tentativi di far scaricare all'endpoint /api/enrich URL interni (localhost, cloud metadata, IP privati RFC1918, link-local, IPv6 loopback, schemi file:// e gopher://). Verifica i filtri isPrivateOrDangerous() e isResolvedIpSafe().",
    coverage: "OWASP API8:2023, CWE-918 (SSRF), OWASP Top 10 A10:2021.",
  },
  "rate-limit": {
    title: "5. Rate limiting e anti-abuso",
    what: "Burst di 40 richieste per verificare il triggering dei limiter (20/min strict su endpoint critici, 60/min global) e tentativo di bypass via rotazione X-Forwarded-For.",
    coverage: "OWASP API4:2023 (Unrestricted Resource Consumption), Rate Limiting Best Practices.",
  },
  "dos-resilience": {
    title: "6. Resilienza DoS leggero",
    what: "5 richieste /api/enrich concorrenti con CSV da 9MB (vicino al limite 10MB) per verificare che il sistema non esaurisca memoria o crashi. Health check post-stress per verificare recupero.",
    coverage: "OWASP API4:2023, CWE-400 (Uncontrolled Resource Consumption).",
  },
};

const OVERALL_STATUS = (() => {
  if (data.meta.total_fail === 0) return "✅ **CONFORME**";
  if (data.meta.total_fail <= 2)   return "⚠️ **CONFORME CON RISERVE**";
  return "❌ **NON CONFORME**";
})();

let md = `# SIMBA — Report Vulnerability Assessment interna

**Target:** \`${data.meta.base_url}\`
**Data esecuzione:** ${new Date(data.meta.started_at).toLocaleString("it-IT")}
**Durata:** ${Math.round((new Date(data.meta.ended_at) - new Date(data.meta.started_at))/1000)}s
**Esito complessivo:** ${OVERALL_STATUS}

---

## Sommario esecutivo

Sono stati eseguiti **${data.meta.total_tests} controlli di sicurezza automatici** suddivisi in **6 suite tematiche**, con un pass rate complessivo del **${data.meta.pass_rate}%** (${data.meta.total_pass} pass / ${data.meta.total_fail} fail).

I test verificano che le mitigazioni di sicurezza implementate in SIMBA (input validation, rate limiting, filtri SSRF, guardrail LLM) resistano a una serie di attacchi classici secondo le categorie OWASP Top 10 per API e LLM.

${data.meta.total_fail === 0
  ? "**Tutti i controlli hanno esito positivo.** Le mitigazioni in essere resistono alle classi di attacco testate."
  : `**${data.meta.total_fail} controlli richiedono attenzione.** Vedere dettaglio in fondo al report.`}

### Tabella sintetica per suite

| # | Suite | Pass | Fail | Esito |
|---|-------|------|------|-------|
`;

for (const s of data.suites) {
  const icon = s.failed === 0 ? "✅" : "⚠️";
  const desc = SUITE_DESC[s.name]?.title || s.name;
  md += `| ${data.suites.indexOf(s)+1} | ${desc} | ${s.passed} | ${s.failed} | ${icon} |\n`;
}

md += `
---

## Scope dichiarato

**Cosa copre questo test:**
- Input validation e gestione errori (payload lunghi, caratteri speciali, JSON malformato)
- Resistenza del classificatore LLM a prompt injection
- Filtri SSRF sugli endpoint che scaricano risorse esterne
- Injection attacks su proxy SPARQL
- Efficacia dei rate limiter e resistenza al bypass
- Resilienza sotto carico concorrente con payload al limite

**Cosa NON copre (da valutare separatamente se richiesto):**
- Code review manuale (audit del codice sorgente)
- Pentest autenticato con credenziali admin
- CVE scanning delle dipendenze (suggerito: \`npm audit\` + \`trivy image\`)
- Supply chain attacks
- Analisi TLS/headers (suggerito: SSL Labs, securityheaders.com)
- Social engineering, phishing
- Test su infrastrutture esterne (triplestore pubblico, etc.)

**Natura del test:** security smoke test automatizzato, eseguito in ambiente di produzione con traffico controllato. Non sostituisce una Vulnerability Assessment formale con asseverazione di terza parte certificata.

---

## Dettaglio per suite

`;

for (const s of data.suites) {
  const desc = SUITE_DESC[s.name];
  md += `### ${desc?.title || s.name}

**Descrizione:** ${desc?.what || "(nessuna descrizione)"}

**Copertura standard:** ${desc?.coverage || "—"}

**Risultati:** ${s.passed}/${s.tests.length} test passati${s.failed > 0 ? ` — ⚠️ ${s.failed} fallimenti` : " — ✅ tutto OK"}

`;

  if (s.failed > 0) {
    md += `**Test falliti:**\n\n`;
    for (const t of s.tests) {
      if (!t.passed) {
        md += `- **${t.name}**\n  - Atteso: \`${t.expected}\`\n  - Ottenuto: \`${t.actual}\`\n`;
        if (t.details) md += `  - Note: ${t.details}\n`;
        md += `\n`;
      }
    }
  } else {
    md += `Tutti i ${s.tests.length} test della suite hanno esito positivo.\n\n`;
  }

  md += `<details>
<summary>Elenco completo test eseguiti (${s.tests.length})</summary>

| # | Test | Esito |
|---|------|-------|
`;
  s.tests.forEach((t, i) => {
    md += `| ${i+1} | ${t.name} | ${t.passed ? "✅" : "❌"} |\n`;
  });
  md += `
</details>

---

`;
}

md += `## Mitigazioni attualmente in essere in SIMBA

Per riferimento del committente, di seguito le principali misure di sicurezza verificate:

**Input validation:**
- Lunghezza massima messaggio \`/api/chat\`: 2000 caratteri
- Lunghezza massima CSV \`/api/enrich\`: 10MB
- Lunghezza massima URL \`/api/enrich\`: 2048 caratteri
- Validazione regex su codice IPA (\`^[a-z0-9_]{1,20}$\`)
- Content-Type check su upload CSV (blocca HTML/ZIP/PDF camuffati)

**Rate limiting (express-rate-limit):**
- Global: 60 req/min per IP su tutto \`/api/\`
- Strict: 20 req/min per IP su \`/api/intent\`, \`/api/validate\`, \`/api/enrich\`
- Chat: 10 req/min per IP su \`/api/chat\`
- Health: 10 req/min per IP
- Admin: 30 req/min per IP

**Anti-SSRF (\`/api/enrich\`):**
- Whitelist di schemi ammessi (HTTPS/HTTP soltanto)
- Blocco pattern IP privati (RFC1918, link-local, loopback, cloud metadata)
- Risoluzione DNS controllata (\`isResolvedIpSafe\`) contro DNS rebinding

**LLM hardening:**
- Classificatore intent con temperatura 0 e \`num_predict=10\` (output controllato)
- Pipeline pre-filtro → SPARQL ASK → LLM (il modello vede solo input pre-validato)
- Guardrail topic classifier prima di \`/api/chat\`
- Timeout 90s su inferenze Ollama

**Access control:**
- Pannello admin \`/chatbot/admin\` con basic auth (htpasswd)
- Token ADMIN_TOKEN richiesto per modifiche blocklist
- Analytics \`/stats/*\` con basic auth separata
- CORS configurato con origin esplicito (CHATBOT_ORIGIN obbligatoria)

**Blocklist dinamica:**
- Parole bannate configurabili via \`/chatbot/admin\`
- Persistente su volume Docker, caricata all'avvio
- Applicata prima dell'invio al modello LLM

**Infrastruttura:**
- Log rotation (10m×3 default, 20m×3 ollama) — previene disk exhaustion
- Healthcheck su rdf-mcp con dependency del backend
- Container restart automatico (\`unless-stopped\`) — resilienza a crash
- Isolamento Docker network tra servizi

---

## Raccomandazioni

`;

if (data.meta.total_fail === 0) {
  md += `Nessuna vulnerabilità rilevata dai test automatici. Si suggerisce comunque di:

1. **Schedulare esecuzione periodica** di questo test (es. settimanale in CI) per rilevare regressioni
2. **Eseguire \`npm audit\` mensilmente** sulle dipendenze per CVE note
3. **Valutare \`trivy image\`** sulle immagini Docker in uso
4. **Considerare un pentest professionale** con asseverazione se SIMBA entra in perimetro AgID o in gare PA con requisiti di sicurezza formali
5. **Monitoraggio continuo** via \`/api/admin/blocklist\` — aggiornare la blocklist se emergono nuovi pattern abusivi in produzione
`;
} else {
  md += `In base ai test falliti, si suggerisce di:

`;
  let n = 1;
  for (const s of data.suites) {
    for (const t of s.tests) {
      if (!t.passed) {
        md += `${n}. **[${SUITE_DESC[s.name]?.title || s.name}]** ${t.name}: verificare \`${t.expected}\` vs \`${t.actual}\` — ${t.details || "da investigare"}\n`;
        n++;
      }
    }
  }
  md += `
Una volta risolte le anomalie, rilanciare il test per confermare la risoluzione.
`;
}

md += `
---

## Metodologia

**Strumento:** \`tests/security-audit.mjs\` (Node.js 20+, zero dipendenze esterne)
**Codice sorgente:** [github.com/piersoft/simba-chatbot/tests/security-audit.mjs](https://github.com/piersoft/simba-chatbot/tree/main/tests)
**Esecuzione:** HTTP(S) diretto contro il dominio pubblico, nessun accesso privilegiato
**Raw data:** \`security-audit-results.json\` (${data.meta.total_tests} test, timestamp per singolo run)

Il test è **riproducibile** lanciando:
\`\`\`bash
BASE_URL=${data.meta.base_url} node tests/security-audit.mjs
node tests/report-generator.mjs
\`\`\`

---

*Report generato automaticamente. Per dettagli tecnici sui singoli test consultare il codice sorgente e il file JSON di output.*
`;

fs.writeFileSync(OUTPUT, md);
console.log(`✓ Report generato: ${OUTPUT} (${(fs.statSync(OUTPUT).size/1024).toFixed(1)} KB)`);
console.log(`  Preview: head ${OUTPUT}`);
