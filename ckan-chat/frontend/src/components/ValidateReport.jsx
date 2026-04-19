import Icon from "./Icon";
import { useState } from "react";

const STANDARDS_TABLE = [
  // ── Struttura ──────────────────────────────────────────────────────────────
  { check: "S1–S6", cosa: "Struttura CSV: separatore, intestazioni, colonne", ref: "RFC 4180", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S7", cosa: "Dimensione file (soglia 5 MB)", ref: "Nessuno standard normativo — soglia pratica", url: null, tipo: "Scelta pragmatica" },
  { check: "S8", cosa: "Caratteri illeggibili (encoding errato)", ref: "RFC 4180 § 2 • Unicode Standard", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S9", cosa: "Lettere accentate corrotte (Windows-1252 vs UTF-8)", ref: "RFC 4180 • W3C CSVW", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Standard formale" },
  { check: "S10", cosa: "Marcatore BOM", ref: "W3C CSVW raccomanda UTF-8 senza BOM", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "S11", cosa: "Caratteri di controllo non visibili", ref: "RFC 4180 — i campi devono contenere testo leggibile", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  { check: "S12", cosa: "Righe completamente vuote", ref: "RFC 4180 — ogni riga deve avere lo stesso numero di campi", url: "https://www.rfc-editor.org/rfc/rfc4180", tipo: "Standard formale" },
  // ── Contenuto ──────────────────────────────────────────────────────────────
  { check: "C1", cosa: "Righe duplicate", ref: "ISO/IEC 25012 — dimensione Unicità", url: "https://www.iso.org/standard/35736.html", tipo: "Standard formale" },
  { check: "C2", cosa: "Valori mancanti", ref: "ISO/IEC 25012 — dimensione Completezza", url: "https://www.iso.org/standard/35736.html", tipo: "Standard formale" },
  { check: "C3", cosa: "Colonna identificatore univoco", ref: "Buona pratica per interoperabilità e Linked Data", url: null, tipo: "Buona pratica" },
  { check: "C4", cosa: "Coerenza tipi per colonna", ref: "ISO/IEC 25012 — dimensione Consistenza (applicazione pratica)", url: "https://www.iso.org/standard/35736.html", tipo: "Buona pratica" },
  { check: "C5", cosa: "Date in formato ISO 8601", ref: "ISO 8601:2019", url: "https://www.iso.org/iso-8601-date-and-time-format.html", tipo: "Standard formale" },
  { check: "C6", cosa: "Separatore decimale: punto, non virgola", ref: "W3C CSVW — datatype xsd:decimal usa il punto", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Standard formale" },
  { check: "C7", cosa: "Valori statisticamente anomali (outlier)", ref: "ISO/IEC 25012 — dimensione Accuratezza (applicazione pratica)", url: "https://www.iso.org/standard/35736.html", tipo: "Buona pratica" },
  { check: "C8", cosa: "Celle molto lunghe (>500 caratteri)", ref: "Scelta pragmatica — segnale di dati non normalizzati", url: null, tipo: "Scelta pragmatica" },
  // ── Qualità Open Data ──────────────────────────────────────────────────────
  { check: "O1–O2", cosa: "Numero minimo di righe e colonne", ref: "Buona pratica consolidata — non esiste una soglia normativa", url: null, tipo: "Buona pratica" },
  { check: "O3", cosa: "Intestazioni descrittive (non 'col1', 'campo2')", ref: "Linee guida AGID Open Data v1.0 (2024)", url: "https://www.agid.gov.it/sites/agid/files/2024-05/lg-open-data_v.1.0_1.pdf", tipo: "Linee guida" },
  { check: "O4", cosa: "Intestazioni in minuscolo con underscore", ref: "W3C CSVW — naming convention raccomandato", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "O5–O6", cosa: "Riferimento geografico e temporale", ref: "Buona pratica per riusabilità — non è obbligo normativo per il CSV", url: null, tipo: "Buona pratica" },
  { check: "O7", cosa: "Caratteri speciali nelle intestazioni", ref: "W3C CSVW — le intestazioni devono essere identificatori validi", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  { check: "O8–O9–O10", cosa: "URI nei dati, valori booleani, commenti in coda", ref: "W3C CSVW e best practice Linked Data", url: "https://www.w3.org/TR/tabular-data-primer/", tipo: "Buona pratica" },
  // ── Linked Data ────────────────────────────────────────────────────────────
  { check: "L1", cosa: "Identificatori UUID", ref: "W3C Best Practices for Publishing Linked Data", url: "https://www.w3.org/TR/ld-bp/", tipo: "Buona pratica" },
  { check: "L2", cosa: "Mapping colonne a ontologie PA italiane", ref: "dati-semantic-assets (ontologie ufficiali PA) • schema.gov.it", url: "https://schema.gov.it", tipo: "Standard formale" },
  { check: "L3", cosa: "Codici ISTAT per territori", ref: "Vocabolari controllati ISTAT — schema.gov.it", url: "https://schema.gov.it", tipo: "Standard formale" },
  { check: "L4", cosa: "CIG e CUP negli appalti pubblici", ref: "D.Lgs. 36/2023 (Codice degli Appalti) • ANAC", url: "https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2023-03-31;36", tipo: "Normativa italiana" },
  { check: "L5", cosa: "URI di ontologie note nei valori", ref: "W3C Best Practices for Publishing Linked Data", url: "https://www.w3.org/TR/ld-bp/", tipo: "Buona pratica" },
  { check: "L6", cosa: "Potenziale 5 stelle Open Data", ref: "Modello 5 stelle — Tim Berners-Lee / W3C", url: "https://5stardata.info/en/", tipo: "Standard formale" },
];

export default function ValidateReport({ report, url, csvText, onEnrich, onEnrichText }) {
  const [showAll, setShowAll] = useState(false);
  const [showStandards, setShowStandards] = useState(false);
  const lines = (report || "").split("\n").filter(Boolean);

  const verdictLine  = lines.find(l => l.includes("Verdict:")) ?? "";
  const scoreLine    = lines.find(l => l.includes("Score")) ?? "";
  const summaryLine  = lines.find(l => l.includes("Check superati:")) ?? "";

  const scoreMatch = scoreLine.match(/(\d+)\s*\/\s*100/);
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

      {/* Bottone standard di riferimento */}
      <button className="standards-btn" onClick={() => setShowStandards(v => !v)}>
        <Icon name="book" size={13} /> {showStandards ? "Nascondi standard" : "Standard di riferimento"}
      </button>

      {/* Popup tabella standard */}
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
              <tr>
                <th>Check</th>
                <th>Cosa verifica</th>
                <th>Riferimento</th>
                <th>Tipo</th>
              </tr>
            </thead>
            <tbody>
              {STANDARDS_TABLE.map((row, i) => {
                const tipoColor = {
                  "Standard formale": { bg: "#e8f0fe", color: "#004a99" },
                  "Normativa italiana": { bg: "#e6f4ec", color: "#1a6b35" },
                  "Linee guida": { bg: "#fff8e6", color: "#7d4e00" },
                  "Buona pratica": { bg: "#f5f7fa", color: "#5c6f82" },
                  "Scelta pragmatica": { bg: "#fef0f0", color: "#b00020" },
                }[row.tipo] || { bg: "#f5f7fa", color: "#5c6f82" };
                return (
                  <tr key={i}>
                    <td><code>{row.check}</code></td>
                    <td>{row.cosa}</td>
                    <td>
                      {row.url
                        ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.ref}</a>
                        : row.ref}
                    </td>
                    <td>
                      <span style={{
                        background: tipoColor.bg, color: tipoColor.color,
                        padding: "2px 6px", borderRadius: 3, fontSize: 10,
                        fontWeight: 700, whiteSpace: "nowrap"
                      }}>{row.tipo}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={{fontSize:11,color:"#5c6f82",marginTop:8}}>
            I check O1–O2 (numero minimo righe/colonne) e C3 (colonna ID) sono buone pratiche consolidate senza standard formale unico.
          </p>
        </div>
      )}

      {/* Bottoni conversione RDF */}
      {(isOk || isWarn) && (
        <div className="validate-convert-btns">
          <span className="convert-label">Converti in:</span>
          <button className="btn-small btn-ttl" onClick={() => onEnrich(url, "ttl")}>
            <Icon name="file-earmark-code" size={13} /> RDF/Turtle
          </button>
          <button className="btn-small btn-ttl" onClick={() => onEnrich(url, "rdfxml")}>
            <Icon name="file-earmark-text" size={13} /> RDF/XML
          </button>
        </div>
      )}
    </div>
  );
}
