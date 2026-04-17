import Icon from "./Icon";
import { useState } from "react";

const STANDARDS_TABLE = [
  { check: "S1–S6", cosa: "Struttura CSV: separatore, intestazioni, colonne", ref: "RFC 4180", url: "https://www.rfc-editor.org/rfc/rfc4180" },
  { check: "S7", cosa: "Dimensione file", ref: "Buona pratica (soglia 5 MB)", url: null },
  { check: "S8–S11", cosa: "Encoding UTF-8, BOM, caratteri corrotti, nascosti", ref: "RFC 4180 • W3C CSVW • Unicode", url: "https://www.w3.org/TR/tabular-data-primer/" },
  { check: "C1", cosa: "Righe duplicate", ref: "ISO/IEC 25012 (Unicità)", url: "https://www.iso.org/standard/35736.html" },
  { check: "C2", cosa: "Valori mancanti", ref: "ISO/IEC 25012 (Completezza)", url: "https://www.iso.org/standard/35736.html" },
  { check: "C4", cosa: "Coerenza tipi per colonna", ref: "ISO/IEC 25012 (Consistenza)", url: "https://www.iso.org/standard/35736.html" },
  { check: "C5", cosa: "Date in formato standard", ref: "ISO 8601:2019", url: "https://www.iso.org/iso-8601-date-and-time-format.html" },
  { check: "C6", cosa: "Separatore decimale (punto, non virgola)", ref: "RFC 4180 • W3C CSVW", url: "https://www.w3.org/TR/tabular-data-primer/" },
  { check: "C7", cosa: "Valori molto distanti dalla media", ref: "ISO/IEC 25012 (Accuratezza)", url: "https://www.iso.org/standard/35736.html" },
  { check: "O1–O3", cosa: "Numero righe/colonne, intestazioni descrittive", ref: "Linee guida AGID Open Data v1.0 (2024)", url: "https://www.agid.gov.it/sites/agid/files/2024-05/lg-open-data_v.1.0_1.pdf" },
  { check: "O4", cosa: "Intestazioni minuscolo con underscore", ref: "W3C CSVW • Linee guida dati.gov.it", url: "https://www.w3.org/TR/tabular-data-primer/" },
  { check: "L1–L2", cosa: "Identificatori UUID, mapping ontologie italiane", ref: "dati-semantic-assets • schema.gov.it", url: "https://schema.gov.it" },
  { check: "L3", cosa: "Codici ISTAT", ref: "Vocabolario controllato ISTAT — schema.gov.it", url: "https://schema.gov.it" },
  { check: "L4", cosa: "CIG e CUP", ref: "D.Lgs. 36/2023 (Codice degli Appalti) • ANAC", url: "https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2023-03-31;36" },
  { check: "L6", cosa: "Potenziale 5 stelle Open Data", ref: "Modello 5 stelle — Tim Berners-Lee / W3C", url: "https://5stardata.info/en/" },
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
                <th>Standard / riferimento</th>
              </tr>
            </thead>
            <tbody>
              {STANDARDS_TABLE.map((row, i) => (
                <tr key={i}>
                  <td><code>{row.check}</code></td>
                  <td>{row.cosa}</td>
                  <td>
                    {row.url
                      ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.ref}</a>
                      : row.ref}
                  </td>
                </tr>
              ))}
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
