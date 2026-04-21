import Icon from "./Icon";
import { useState, useEffect } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "";

const STANDARDS_TABLE = [
  { check: "S1–S6", cosa: "Struttura CSV: separatore, intestazioni, colonne", ref: "RFC 4180", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S7", cosa: "Dimensione file (soglia 5 MB)", ref: "Nessuno standard normativo — soglia pratica", url: null, tipo: "Scelta pragmatica" },
  { check: "S8", cosa: "Caratteri illeggibili (encoding errato)", ref: "RFC 4180 § 2 • Unicode Standard", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S9", cosa: "Lettere accentate corrotte (Windows-1252 vs UTF-8)", ref: "RFC 4180 • W3C CSVW", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Standard formale" },
  { check: "S10", cosa: "Marcatore BOM", ref: "W3C CSVW raccomanda UTF-8 senza BOM", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "S11", cosa: "Caratteri di controllo non visibili", ref: "RFC 4180 — i campi devono contenere testo leggibile", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S12", cosa: "Righe completamente vuote", ref: "RFC 4180 — ogni riga deve avere lo stesso numero di campi", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "C1", cosa: "Righe duplicate", ref: "ISO/IEC 25012 — dimensione Unicità", url: "https://www.iso.org/standard/35736.html", tipo: "Standard formale" },
  { check: "C2", cosa: "Valori mancanti", ref: "ISO/IEC 25012 — dimensione Completezza", url: "https://www.iso.org/standard/35736.html", tipo: "Standard formale" },
  { check: "C3", cosa: "Colonna identificatore univoco", ref: "Buona pratica per interoperabilità e Linked Data", url: null, tipo: "Buona pratica" },
  { check: "C4", cosa: "Coerenza tipi per colonna", ref: "ISO/IEC 25012 — dimensione Consistenza (applicazione pratica)", url: "https://www.iso.org/standard/35736.html", tipo: "Buona pratica" },
  { check: "C5", cosa: "Date in formato ISO 8601", ref: "ISO 8601:2019", url: "https://www.iso.org/iso-8601-date-and-time-format.html", tipo: "Standard formale" },
  { check: "C6", cosa: "Separatore decimale: punto, non virgola", ref: "W3C CSVW — datatype xsd:decimal usa il punto", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Standard formale" },
  { check: "C7", cosa: "Valori statisticamente anomali (outlier)", ref: "ISO/IEC 25012 — dimensione Accuratezza (applicazione pratica)", url: "https://www.iso.org/standard/35736.html", tipo: "Buona pratica" },
  { check: "C8", cosa: "Celle molto lunghe (>500 caratteri)", ref: "Scelta pragmatica — segnale di dati non normalizzati", url: null, tipo: "Scelta pragmatica" },
  { check: "O1–O2", cosa: "Numero minimo di righe e colonne", ref: "Buona pratica consolidata — non esiste una soglia normativa", url: null, tipo: "Buona pratica" },
  { check: "O3", cosa: "Intestazioni descrittive (non 'col1', 'campo2')", ref: "Linee guida AGID Open Data v1.0 (2024)", url: "https://www.agid.gov.it/sites/agid/files/2024-05/lg-open-data_v.1.0_1.pdf", tipo: "Linee guida" },
  { check: "O4", cosa: "Intestazioni allineate alle etichette ontologie", ref: "LG AGID Open Data Allegato B • W3C CSVW", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "O5–O6", cosa: "Riferimento geografico e temporale", ref: "Buona pratica per riusabilità — non è obbligo normativo per il CSV", url: null, tipo: "Buona pratica" },
  { check: "O7", cosa: "Caratteri speciali nelle intestazioni", ref: "W3C CSVW — le intestazioni devono essere identificatori validi", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "O8–O9–O10", cosa: "URI nei dati, valori booleani, commenti in coda", ref: "W3C CSVW e best practice Linked Data", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "L1", cosa: "Identificatori UUID", ref: "W3C Best Practices for Publishing Linked Data", url: "https://www.w3.org/TR/ld-bp/", tipo: "Buona pratica" },
  { check: "L2", cosa: "Mapping colonne a ontologie PA italiane", ref: "dati-semantic-assets (ontologie ufficiali PA) • schema.gov.it", url: "https://schema.gov.it", tipo: "Standard formale" },
  { check: "L3", cosa: "Codici ISTAT per territori", ref: "Vocabolari controllati ISTAT — schema.gov.it", url: "https://schema.gov.it", tipo: "Standard formale" },
  { check: "L4", cosa: "CIG e CUP negli appalti pubblici", ref: "D.Lgs. 36/2023 (Codice degli Appalti) • ANAC", url: "https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2023-03-31;36", tipo: "Normativa italiana" },
  { check: "L5", cosa: "URI di ontologie note nei valori", ref: "W3C Best Practices for Publishing Linked Data", url: "https://www.w3.org/TR/ld-bp/", tipo: "Buona pratica" },
  { check: "L6", cosa: "Potenziale 5 stelle Open Data", ref: "Modello 5 stelle — Tim Berners-Lee / W3C", url: "https://5stardata.info/en/", tipo: "Standard formale" },
];

// ── Estrae headers e ontologie dal report testuale ────────────────────────────
function extractFromReport(report, csvText) {
  const ontos = [];
  const ontoRe = /→\s*(CLV|QB|TI|POI|COV|PublicContract|CPSV-AP|IoT|ACCO|GTFS|PARK|SMAPIT|CPV|RO|Cultural-ON|MU|CPEV|ADMS)/g;
  let m;
  while ((m = ontoRe.exec(report)) !== null) {
    if (!ontos.includes(m[1])) ontos.push(m[1]);
  }
  let headers = [];
  let rows = [];
  if (csvText) {
    const lines = csvText.split(/\r?\n/).filter(l => l.trim());
    if (lines.length > 0) {
      const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
      headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ""));
      // Estrai fino a 5 righe di dati reali
      for (let i = 1; i < Math.min(lines.length, 6); i++) {
        const vals = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ""));
        const row = {};
        headers.forEach((h, j) => { row[h] = vals[j] || ""; });
        rows.push(row);
      }
    }
  }
  // Se non abbiamo righe reali ma abbiamo header, aggiungi righe dummy
  // per non fare scattare il blocco S4 "nessuna riga di dati"
  if (headers.length > 0 && rows.length === 0) {
    for (let i = 0; i < 3; i++) {
      const row = {};
      headers.forEach(h => { row[h] = "valore"; });
      rows.push(row);
    }
  }
  return { headers, rows, ontos };
}

export default function ValidateReport({ report, url, csvText, onEnrich, onEnrichText }) {
  const [showAll, setShowAll] = useState(false);
  const [showStandards, setShowStandards] = useState(false);
  const [gateResult, setGateResult] = useState(null);
  const [gateLoading, setGateLoading] = useState(false);

  const lines = (report || "").split("\n").filter(Boolean);
  const verdictLine  = lines.find(l => l.includes("Verdict:")) ?? "";
  const scoreLine    = lines.find(l => l.includes("Score")) ?? "";
  const summaryLine  = lines.find(l => l.includes("Check superati:")) ?? "";
  const scoreMatch   = scoreLine.match(/(\d+)\s*\/\s*100/);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : null;
  const isOk   = verdictLine.includes("buona_qualita")   || verdictLine.includes("Buona qualità") || score >= 95;
  const isWarn = verdictLine.includes("con_riserva")      || verdictLine.includes("con riserva")   || (score >= 50 && score < 95);
  const isFail = verdictLine.includes("non_accettabile")  || verdictLine.includes("Non accettabile") || (score !== null && score < 50);

  const verdictLabel = isOk   ? "✅ Ottima qualità"
                     : isWarn ? "⚠️ Accettabile con riserva"
                     : isFail ? "❌ Non accettabile"
                     : "📋 Risultato";
  const colorClass = isOk ? "verdict-ok" : isWarn ? "verdict-warn" : "verdict-fail";
  const checks = lines.filter(l => /^[✅⚠️❌ℹ️⏭]/.test(l));

  // ── Calcola gate semantico quando il report è disponibile ──────────────────
  useEffect(() => {
    if (!report) return;
    const { headers, ontos } = extractFromReport(report, csvText);
    if (!headers.length && !ontos.length) return;

    setGateLoading(true);
    fetch(`${BACKEND_URL}/api/validate-semantic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers, rows, ontos, title: url || "" }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setGateResult(data); })
      .catch(() => {})
      .finally(() => setGateLoading(false));
  }, [report, csvText]);

  // ── Gate bloccato se BLOCCANTE o MIGLIORABILE ──────────────────────────────
  const gateBlocked = gateResult && (gateResult.stato === "BLOCCANTE" || gateResult.stato === "MIGLIORABILE");
  const canConvert  = (isOk || isWarn) && !gateBlocked;

  // ── Colori semaforo gate ────────────────────────────────────────────────────
  const gateColors = {
    BLOCCANTE:   { bg: "#fff5f5", border: "#b00020", text: "#b00020", icon: "⊗" },
    MIGLIORABILE:{ bg: "#fff8e1", border: "#c45e00", text: "#7a3900", icon: "⚠" },
    OTTIMALE:    { bg: "#f0faf4", border: "#1a6b35", text: "#1a6b35", icon: "✓" },
  };

  return (
    <div className="validate-report">
      {/* Verdict header */}
      <div className={`validate-verdict ${colorClass}`}>
        <strong>{verdictLabel}</strong>
        {score !== null && <span className="validate-score">{score}/100</span>}
      </div>

      {summaryLine && <p className="validate-summary">{summaryLine}</p>}

      {url && (
        <p className="validate-url">
          File: <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
        </p>
      )}

      {checks.length > 0 && (
        <div className="validate-checks">
          {lines.map((line, i) => {
            if (/^\*\*[^*]+\*\*$/.test(line)) {
              return (
                <div key={i} className="validate-section-title">
                  {line.replace(/\*\*/g, "")}
                </div>
              );
            }
            if (/^[✅⚠️❌ℹ️⏭]/.test(line)) {
              const cls = line.startsWith("✅") ? "check-ok"
                        : line.startsWith("⚠️") ? "check-warn"
                        : line.startsWith("❌") ? "check-fail"
                        : "check-info";
              const checkIdx = checks.indexOf(line);
              if (!showAll && checkIdx >= 20) return null;
              return (
                <div key={i} className={`validate-check-line ${cls}`}>
                  {line}
                </div>
              );
            }
            return null;
          })}

          {checks.length > 20 && (
            <button className="show-all-btn" onClick={() => setShowAll(v => !v)}>
              {showAll ? "▲ Mostra meno" : `▼ Mostra tutti i ${checks.length} check`}
            </button>
          )}
        </div>
      )}

      {/* ── Pannello Semantic Gate ─────────────────────────────────────────── */}
      {gateLoading && (
        <div style={{ margin: "12px 0", fontSize: 13, color: "#5c6f82" }}>
          Analisi semantica in corso…
        </div>
      )}

      {gateResult && (() => {
        const gc = gateColors[gateResult.stato] || gateColors.OTTIMALE;
        const sd = gateResult.score_detail || {};
        return (
          <div style={{
            margin: "14px 0 10px", padding: "14px 16px",
            borderLeft: `4px solid ${gc.border}`,
            background: gc.bg, borderRadius: 6,
          }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: gc.text, marginBottom: 6 }}>
              {gc.icon} Idoneità per conversione RDF: {gateResult.stato}
            </div>
            <div style={{ fontSize: 12, color: gc.text, opacity: 0.8, marginBottom: 8 }}>
              Score semantico: <strong>{gateResult.score}/100</strong>
              &nbsp;|&nbsp;Struttura: {sd.struttura || 0}/40
              &nbsp;Ontologie: {sd.ontologie || 0}/40
              &nbsp;Linked&nbsp;Data: {sd.linked_data || 0}/20
            </div>

            {/* Blockers */}
            {gateResult.blockers && gateResult.blockers.length > 0 && (
              <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 13 }}>
                {gateResult.blockers.map((b, i) => (
                  <li key={i} style={{ color: "#b00020", marginBottom: 4 }}>{b.msg}</li>
                ))}
              </ul>
            )}

            {/* Warnings */}
            {gateResult.warnings && gateResult.warnings.length > 0 && (
              <ul style={{ margin: "6px 0", paddingLeft: 18, fontSize: 13 }}>
                {gateResult.warnings.map((w, i) => (
                  <li key={i} style={{ color: "#7a3900", marginBottom: 4 }}>{w.msg}</li>
                ))}
              </ul>
            )}

            {/* Suggerimenti */}
            {gateResult.suggestions && gateResult.suggestions.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <strong style={{ fontSize: 13, color: gc.text }}>Suggerimenti per abilitare la conversione RDF:</strong>
                {gateResult.suggestions.map((s, i) => (
                  <div key={i} style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: gc.text }}>
                      {s.label} — <a href={s.doc_url} target="_blank" rel="noopener noreferrer" style={{ color: gc.text }}>doc ↗</a>
                    </div>
                    {s.renames && s.renames.map((r, j) => (
                      <div key={j} style={{ fontSize: 12, marginTop: 3, marginLeft: 10 }}>
                        Rinomina <code style={{ background: "rgba(0,0,0,0.07)", padding: "1px 5px", borderRadius: 3 }}>{r.da}</code>
                        {" → "}
                        <code style={{ background: "rgba(0,0,0,0.07)", padding: "1px 5px", borderRadius: 3 }}>{r.a}</code>
                      </div>
                    ))}
                    {s.aggiungi && s.aggiungi.filter(a => a.priorita !== "bassa").map((a, j) => (
                      <div key={j} style={{ fontSize: 12, marginTop: 3, marginLeft: 10, color: a.priorita === "alta" ? "#b00020" : "#7a3900" }}>
                        Aggiungi [{a.priorita}]: <code style={{ background: "rgba(0,0,0,0.07)", padding: "1px 5px", borderRadius: 3 }}>{a.colonna}</code>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {gateResult.stato === "MIGLIORABILE" && (
              <p style={{ fontSize: 12, marginTop: 10, color: gc.text, fontStyle: "italic" }}>
                Il CSV è strutturalmente valido ma le intestazioni non sono allineate alle ontologie del Catalogo Nazionale della Semantica dei Dati.
                Applica i suggerimenti e ricarica il file per abilitare la conversione RDF.
              </p>
            )}
          </div>
        );
      })()}

      {/* Bottone standard di riferimento */}
      <button className="standards-btn" onClick={() => setShowStandards(v => !v)}>
        <Icon name="book" size={13} /> {showStandards ? "Nascondi standard" : "Standard di riferimento"}
      </button>

      {showStandards && (
        <div className="standards-popup">
          <div className="standards-header">
            <strong>Standard e normative di riferimento</strong>
            <button onClick={() => setShowStandards(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:18,color:"#5c6f82"}}>×</button>
          </div>
          <p style={{fontSize:12,color:"#5c6f82",marginBottom:10}}>
            I check del validatore sono una sintesi ragionata di standard internazionali, normativa italiana e buone pratiche open data.
          </p>
          <table className="standards-table">
            <thead>
              <tr><th>Check</th><th>Cosa verifica</th><th>Riferimento</th><th>Tipo</th></tr>
            </thead>
            <tbody>
              {STANDARDS_TABLE.map((row, i) => {
                const tipoColor = {
                  "Standard formale":   { bg: "#e8f0fe", color: "#004a99" },
                  "Normativa italiana": { bg: "#e6f4ec", color: "#1a6b35" },
                  "Linee guida":        { bg: "#fff8e6", color: "#7d4e00" },
                  "Buona pratica":      { bg: "#f5f7fa", color: "#5c6f82" },
                  "Scelta pragmatica":  { bg: "#fef0f0", color: "#b00020" },
                }[row.tipo] || { bg: "#f5f7fa", color: "#5c6f82" };
                return (
                  <tr key={i}>
                    <td><code>{row.check}</code></td>
                    <td>{row.cosa}</td>
                    <td>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.ref}</a> : row.ref}</td>
                    <td>
                      <span style={{ background: tipoColor.bg, color: tipoColor.color, padding: "2px 6px", borderRadius: 3, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                        {row.tipo}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Bottoni conversione RDF — bloccati se gate MIGLIORABILE o BLOCCANTE */}
      {(isOk || isWarn) && (
        <div className="validate-convert-btns">
          <span className="convert-label">Converti in:</span>
          <button
            className="btn-small btn-ttl"
            disabled={gateBlocked}
            title={gateBlocked ? `CSV ${gateResult.stato} — applica i suggerimenti e ricarica il file` : ""}
            style={gateBlocked ? { opacity: 0.4, cursor: "not-allowed" } : {}}
            onClick={() => !gateBlocked && onEnrich(url, "ttl")}
          >
            <Icon name="file-earmark-code" size={13} /> RDF/Turtle
          </button>
          <button
            className="btn-small btn-ttl"
            disabled={gateBlocked}
            title={gateBlocked ? `CSV ${gateResult.stato} — applica i suggerimenti e ricarica il file` : ""}
            style={gateBlocked ? { opacity: 0.4, cursor: "not-allowed" } : {}}
            onClick={() => !gateBlocked && onEnrich(url, "rdfxml")}
          >
            <Icon name="file-earmark-text" size={13} /> RDF/XML
          </button>

        </div>
      )}

      {/* Messaggio esplicativo quando gate blocca */}
      {gateBlocked && (isOk || isWarn) && (
        <p style={{ fontSize: 12, color: "#7a3900", marginTop: 6, fontStyle: "italic" }}>
          La struttura CSV è valida, ma la conversione RDF richiede intestazioni allineate alle ontologie PA.
          Segui i suggerimenti sopra, modifica il CSV e ricaricalo.
        </p>
      )}
    </div>
  );
}
