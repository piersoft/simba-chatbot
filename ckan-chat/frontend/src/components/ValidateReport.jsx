export default function ValidateReport({ report, url }) {
  const lines = (report || "").split("\n").filter(Boolean);

  const verdict = lines.find(l => l.includes("Verdict:")) ?? "";
  const score   = lines.find(l => l.includes("Score")) ?? "";
  const summary = lines.find(l => l.includes("Check superati:")) ?? "";

  const isOk   = verdict.includes("buona_qualita");
  const isWarn = verdict.includes("con_riserva");
  const isFail = verdict.includes("non_accettabile");

  const verdictLabel = isOk   ? "✅ Buona qualità"
                     : isWarn ? "⚠️ Accettabile con riserva"
                     : isFail ? "❌ Non accettabile"
                     : "📋 Risultato";

  const colorClass = isOk ? "verdict-ok" : isWarn ? "verdict-warn" : "verdict-fail";

  const checks = lines.filter(l => /^[✅⚠️❌ℹ️]/.test(l));

  return (
    <div className="validate-report">
      <div className={`validate-verdict ${colorClass}`}>
        <strong>{verdictLabel}</strong>
        {score && <span className="validate-score">{score.replace("Score qualità:", "").trim()}</span>}
      </div>
      {summary && <p className="validate-summary">{summary}</p>}
      {url && (
        <p className="validate-url">
          File: <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
        </p>
      )}
      {checks.length > 0 && (
        <div className="validate-checks">
          {checks.slice(0, 12).map((c, i) => (
            <div key={i} className="validate-check-line">{c}</div>
          ))}
          {checks.length > 12 && (
            <div className="validate-check-line muted">…e altri {checks.length - 12} check</div>
          )}
        </div>
      )}
    </div>
  );
}
