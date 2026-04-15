import { useState } from "react";

export default function ValidateReport({ report, url, onEnrich }) {
  const [showAll, setShowAll] = useState(false);
  const lines = (report || "").split("\n").filter(Boolean);

  // Parsing flessibile — cerca le righe chiave nel report testuale
  const verdictLine  = lines.find(l => l.includes("Verdict:")) ?? "";
  const scoreLine    = lines.find(l => l.includes("Score")) ?? "";
  const summaryLine  = lines.find(l => l.includes("Check superati:")) ?? "";

  // Score numerico
  const scoreMatch = scoreLine.match(/(\d+)\s*\/\s*100/);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : null;

  // Verdict
  const isOk   = verdictLine.includes("buona_qualita")   || verdictLine.includes("Buona qualità") || score >= 95;
  const isWarn = verdictLine.includes("con_riserva")      || verdictLine.includes("con riserva")   || (score >= 50 && score < 95);
  const isFail = verdictLine.includes("non_accettabile")  || verdictLine.includes("Non accettabile") || (score !== null && score < 50);

  const verdictLabel = isOk   ? "✅ Ottima qualità"
                     : isWarn ? "⚠️ Accettabile con riserva"
                     : isFail ? "❌ Non accettabile"
                     : "📋 Risultato";

  const colorClass = isOk ? "verdict-ok" : isWarn ? "verdict-warn" : "verdict-fail";

  // Tutti i check — righe che iniziano con emoji di stato
  const checks = lines.filter(l => /^[✅⚠️❌ℹ️⏭]/.test(l));
  const visibleChecks = showAll ? checks : checks.slice(0, 20);

  return (
    <div className="validate-report">
      {/* Verdict header */}
      <div className={`validate-verdict ${colorClass}`}>
        <strong>{verdictLabel}</strong>
        {score !== null && <span className="validate-score">{score}/100</span>}
      </div>

      {/* Summary */}
      {summaryLine && <p className="validate-summary">{summaryLine}</p>}

      {/* URL file */}
      {url && (
        <p className="validate-url">
          File: <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
        </p>
      )}

      {/* Sezioni dal report (Struttura, Contenuto, ecc.) */}
      {checks.length > 0 && (
        <div className="validate-checks">
          {lines.map((line, i) => {
            // Titoli di sezione (es. **Struttura**)
            if (/^\*\*[^*]+\*\*$/.test(line)) {
              return (
                <div key={i} className="validate-section-title">
                  {line.replace(/\*\*/g, "")}
                </div>
              );
            }
            // Righe check
            if (/^[✅⚠️❌ℹ️⏭]/.test(line)) {
              // Determina classe in base all'emoji
              const cls = line.startsWith("✅") ? "check-ok"
                        : line.startsWith("⚠️") ? "check-warn"
                        : line.startsWith("❌") ? "check-fail"
                        : "check-info";
              // Visibilità
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
      {/* Bottoni conversione RDF — mostrati solo se CSV è accettabile */}
      {(isOk || isWarn) && url && onEnrich && (
        <div className="validate-convert-btns">
          <span className="convert-label">Converti in:</span>
          <button className="btn-small btn-ttl" onClick={() => onEnrich(url, "CSV", "ente", "ttl")}>
            🔄 RDF/Turtle
          </button>
          <button className="btn-small btn-ttl" onClick={() => onEnrich(url, "CSV", "ente", "rdfxml")}>
            🔄 RDF/XML
          </button>
        </div>
      )}
    </div>
  );
}
