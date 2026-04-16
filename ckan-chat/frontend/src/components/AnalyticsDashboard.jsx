import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// In prod: nginx proxia /analytics-api/ → analytics-service:3004
// In dev: vite proxia /analytics-api/ → localhost:3004
const ANALYTICS_BASE = import.meta.env.VITE_ANALYTICS_URL || "/analytics-api";
const TOKEN = import.meta.env.VITE_ANALYTICS_TOKEN || "changeme";

const RANGES = [
  { label: "Oggi",     days: 1  },
  { label: "7 giorni", days: 7  },
  { label: "30 giorni",days: 30 },
  { label: "90 giorni",days: 90 },
];

const C = {
  blue:   "#0066CC", blueDk: "#003E7A", green:  "#006B38",
  violet: "#5C1A8A", amber:  "#B45309", red:    "#B91C1C",
  muted:  "#64748B", text:   "#1E293B", border: "#E2E8F0", surface: "#F8FAFC",
};
const BAR_COLORS = [C.blue, C.green, C.violet, C.amber, "#0891B2", "#BE185D", "#065F46", "#7C3AED"];

async function apiFetch(path, from, to) {
  const p = new URLSearchParams({ from, to });
  const r = await fetch(`${ANALYTICS_BASE}${path}?${p}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

function dateRange(days) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function useStats(days) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const abort = useRef(null);

  const load = useCallback(async () => {
    if (abort.current) abort.current.abort();
    abort.current = new AbortController();
    setLoading(true); setError(null);
    const { from, to } = dateRange(days);
    try {
      const [overview, search, validate, ttl, errors, perf] = await Promise.all([
        apiFetch("/stats/overview", from, to),
        apiFetch("/stats/search",   from, to),
        apiFetch("/stats/validate", from, to),
        apiFetch("/stats/ttl",      from, to),
        apiFetch("/stats/errors",   from, to),
        apiFetch("/stats/performance", from, to),
      ]);
      setData({ overview, search, validate, ttl, errors, perf });
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally { setLoading(false); }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  return { data, loading, error, reload: load };
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function KpiCard({ label, value, unit = "", color = C.blue }) {
  return (
    <div style={{ background:"#fff", border:`1px solid ${C.border}`, borderRadius:12,
      padding:"18px 20px", borderTop:`3px solid ${color}` }}>
      <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase",
        letterSpacing:"0.06em", marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:28, fontWeight:700, color:C.text, lineHeight:1.1 }}>
        {value ?? "—"}
        <span style={{ fontSize:14, fontWeight:400, marginLeft:4, color:C.muted }}>{unit}</span>
      </div>
    </div>
  );
}

function Section({ children, icon, title }) {
  return (
    <div style={{ margin:"28px 0 14px", display:"flex", alignItems:"center", gap:8 }}>
      {icon && <span style={{ fontSize:18 }}>{icon}</span>}
      <h2 style={{ margin:0, fontSize:14, fontWeight:700, color:C.text }}>{title}</h2>
      <div style={{ flex:1, height:1, background:C.border }} />
      {children}
    </div>
  );
}

function Panel({ children, title, style={} }) {
  return (
    <div style={{ background:"#fff", border:`1px solid ${C.border}`,
      borderRadius:12, padding:"18px 18px 14px", ...style }}>
      {title && <div style={{ fontSize:11, fontWeight:700, color:C.muted, marginBottom:12,
        textTransform:"uppercase", letterSpacing:"0.05em" }}>{title}</div>}
      {children}
    </div>
  );
}

function HBar({ data=[], keyX="count", keyY="query" }) {
  const max = Math.max(...data.map(d=>d[keyX]||0), 1);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
      {data.length === 0 && <p style={{ color:C.muted, fontSize:13, margin:"12px 0", textAlign:"center" }}>Nessun dato</p>}
      {data.map((d,i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13 }}>
          <span style={{ width:18, textAlign:"right", fontSize:10, fontWeight:700, color:C.muted, fontFamily:"monospace" }}>{i+1}</span>
          <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", color:C.text, fontWeight:500 }}>{d[keyY]}</span>
          <div style={{ width:110, height:9, background:C.surface, borderRadius:5, overflow:"hidden" }}>
            <div style={{ width:`${Math.round((d[keyX]/max)*100)}%`, height:"100%",
              background:BAR_COLORS[i%BAR_COLORS.length], borderRadius:5 }} />
          </div>
          <span style={{ width:28, textAlign:"right", fontWeight:700, color:C.blue, fontSize:12 }}>{d[keyX]}</span>
        </div>
      ))}
    </div>
  );
}

function Gauge({ value, max=100, color=C.blue, label, fmt=v=>v }) {
  const pct = max>0 ? Math.min(100, Math.round((value/max)*100)) : 0;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
      {label && <span style={{ fontSize:11, color:C.muted, fontWeight:600 }}>{label}</span>}
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ flex:1, height:11, background:C.surface, borderRadius:5, overflow:"hidden", border:`1px solid ${C.border}` }}>
          <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:5,
            transition:"width 0.8s cubic-bezier(0.4,0,0.2,1)" }} />
        </div>
        <span style={{ fontSize:15, fontWeight:700, color:C.text, minWidth:48, textAlign:"right" }}>{fmt(value)}</span>
      </div>
    </div>
  );
}

function Skeleton({ h=180 }) {
  return <div style={{ height:h, borderRadius:8, background:"#f1f5f9",
    animation:"pulse 1.5s ease-in-out infinite" }} />;
}

function ErrorTable({ data=[] }) {
  if (!data.length) return <p style={{ color:C.muted, fontSize:13, margin:"12px 0", textAlign:"center" }}>Nessun errore 🎉</p>;
  return (
    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
      <thead><tr style={{ borderBottom:`2px solid ${C.border}` }}>
        <th style={{ textAlign:"left", padding:"5px 6px", color:C.muted, fontWeight:700, fontSize:10, textTransform:"uppercase" }}>Tipo</th>
        <th style={{ textAlign:"right", padding:"5px 6px", color:C.muted, fontWeight:700, fontSize:10, textTransform:"uppercase" }}>N.</th>
      </tr></thead>
      <tbody>
        {data.map((e,i) => (
          <tr key={i} style={{ borderBottom:`1px solid ${C.border}`, background:i%2===0?"#fff":C.surface }}>
            <td style={{ padding:"7px 6px", fontFamily:"monospace", color:C.text }}>{e.error_type}</td>
            <td style={{ padding:"7px 6px", textAlign:"right", fontWeight:700, color:C.red }}>{e.count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AnalyticsDashboard() {
  const [days, setDays]     = useState(7);
  const { data, loading, error, reload } = useStats(days);
  const [lastRefresh, setLastRefresh]   = useState(new Date());

  const refresh = () => { reload(); setLastRefresh(new Date()); };

  useEffect(() => {
    const t = setInterval(refresh, 120000);
    return () => clearInterval(t);
  }, [reload]);

  const fmtH = s => s?.slice(11,16) ?? "";
  const fmtD = s => s?.slice(5)     ?? "";

  return (
    <div style={{ minHeight:"100vh", background:C.surface, fontFamily:"'DM Sans','Segoe UI',sans-serif", color:C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
        * { box-sizing:border-box; }
      `}</style>

      {/* Header */}
      <div style={{ background:C.blueDk, height:52, padding:"0 28px", display:"flex",
        alignItems:"center", gap:12, position:"sticky", top:0, zIndex:100,
        boxShadow:"0 2px 8px rgba(0,0,0,0.2)" }}>
        <span style={{ fontSize:18 }}>📊</span>
        <span style={{ fontSize:15, fontWeight:700, color:"#fff" }}>CKAN Chatbot — Analytics</span>
        <div style={{ flex:1 }} />
        <span style={{ fontSize:12, color:"rgba(255,255,255,0.5)" }}>
          Aggiornato {lastRefresh.toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}
        </span>
        <button onClick={refresh} style={{ background:"rgba(255,255,255,0.12)", border:"none",
          borderRadius:6, color:"#fff", fontSize:12, fontWeight:600, padding:"5px 12px", cursor:"pointer" }}>
          ↺ Aggiorna
        </button>
      </div>

      <div style={{ maxWidth:1260, margin:"0 auto", padding:"24px 20px 48px" }}>

        {/* Range selector */}
        <div style={{ display:"flex", gap:7, marginBottom:24, alignItems:"center" }}>
          <span style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Periodo:</span>
          {RANGES.map(r => (
            <button key={r.days} onClick={() => setDays(r.days)} style={{
              padding:"5px 14px", borderRadius:20, fontSize:13, fontWeight:600, cursor:"pointer",
              border:`1.5px solid ${days===r.days ? C.blue : C.border}`,
              background: days===r.days ? C.blue : "#fff",
              color:       days===r.days ? "#fff" : C.muted,
              transition:"all 0.15s",
            }}>{r.label}</button>
          ))}
        </div>

        {error && (
          <div style={{ background:"#FEF2F2", border:"1px solid #FECACA", borderRadius:10,
            padding:"10px 16px", marginBottom:20, color:C.red, fontSize:13,
            display:"flex", alignItems:"center", gap:8 }}>
            ⚠️ Errore: {error}
            <button onClick={refresh} style={{ marginLeft:"auto", color:C.red, background:"none",
              border:"none", cursor:"pointer", fontWeight:700 }}>Riprova</button>
          </div>
        )}

        {/* KPI */}
        <Section icon="📈" title="Panoramica" />
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:12 }}>
          {loading ? Array(6).fill(0).map((_,i) => <Skeleton key={i} h={90}/>) : [
            { label:"Sessioni uniche",  value:data?.overview?.sessions,    color:C.blue   },
            { label:"IP univoci",       value:data?.overview?.unique_ips,  color:C.blueDk },
            { label:"Ricerche",         value:data?.overview?.searches,    color:C.green  },
            { label:"Validazioni",      value:data?.overview?.validations, color:C.violet },
            { label:"TTL creati",       value:data?.overview?.ttl_created, color:C.amber  },
            { label:"Errori",           value:data?.overview?.errors,      color:C.red    },
          ].map((k,i) => <KpiCard key={i} {...k}/>)}
        </div>

        {/* Qualità */}
        <Section icon="🎯" title="Qualità e performance" />
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:12 }}>
          <Panel title="Tasso off-topic">
            {loading ? <Skeleton h={55}/> : (() => {
              const tot = data?.overview?.total_events || 1;
              const ot  = data?.overview?.off_topic    || 0;
              const pct = Math.round((ot/tot)*100);
              return <>
                <Gauge value={pct} max={100} color={pct>20?C.red:pct>10?C.amber:C.green} fmt={v=>`${v}%`}/>
                <p style={{ fontSize:12, color:C.muted, margin:"8px 0 0" }}>{ot} messaggi off-topic su {tot}</p>
              </>;
            })()}
          </Panel>
          <Panel title="Latenza media Ollama">
            {loading ? <Skeleton h={55}/> : (() => {
              const ms = data?.overview?.avg_latency_ms || 0;
              return <>
                <Gauge value={ms} max={5000} color={ms>3000?C.red:ms>1500?C.amber:C.green} fmt={v=>`${v} ms`}/>
                <p style={{ fontSize:12, color:C.muted, margin:"8px 0 0" }}>p95: {data?.perf?.p95_latency_ms??'—'} ms</p>
              </>;
            })()}
          </Panel>
          <Panel title="Tasso validazione OK">
            {loading ? <Skeleton h={55}/> : (() => {
              const pct = data?.validate?.success_rate ?? null;
              return pct !== null
                ? <Gauge value={pct} max={100} color={pct>80?C.green:pct>50?C.amber:C.red} fmt={v=>`${v}%`}/>
                : <p style={{ color:C.muted, fontSize:13, margin:0 }}>Nessuna validazione</p>;
            })()}
          </Panel>
        </div>

        {/* Traffico */}
        <Section icon="⏱" title="Traffico nel tempo" />
        <Panel title="Eventi per ora">
          {loading ? <Skeleton h={200}/> : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={data?.overview?.hourly_traffic||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                <defs>
                  <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.blue} stopOpacity={0.18}/>
                    <stop offset="95%" stopColor={C.blue} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                <XAxis dataKey="hour" tickFormatter={fmtH} tick={{fontSize:11,fill:C.muted}} interval="preserveStartEnd"/>
                <YAxis tick={{fontSize:11,fill:C.muted}}/>
                <Tooltip contentStyle={{fontSize:12,borderRadius:8,border:`1px solid ${C.border}`}} labelFormatter={fmtH}/>
                <Area type="monotone" dataKey="count" stroke={C.blue} strokeWidth={2} fill="url(#gBlue)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Panel>

        {/* Ricerche */}
        <Section icon="🔍" title="Ricerche" />
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <Panel title="Top keyword cercate">
            {loading ? <Skeleton h={220}/> : <HBar data={data?.search?.top_queries} keyY="query"/>}
          </Panel>
          <Panel title="Top enti (rightsHolder)">
            {loading ? <Skeleton h={220}/> : <HBar data={data?.search?.top_rightsholders} keyY="rights_holder"/>}
          </Panel>
          <Panel title="Ricerche per giorno" style={{gridColumn:"1/-1"}}>
            {loading ? <Skeleton h={150}/> : (
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={data?.search?.searches_per_day||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                  <XAxis dataKey="day" tickFormatter={fmtD} tick={{fontSize:11,fill:C.muted}}/>
                  <YAxis tick={{fontSize:11,fill:C.muted}}/>
                  <Tooltip contentStyle={{fontSize:12,borderRadius:8}} labelFormatter={fmtD}/>
                  <Bar dataKey="count" fill={C.blue} radius={[4,4,0,0]}>
                    {(data?.search?.searches_per_day||[]).map((_,i)=><Cell key={i} fill={C.blue} fillOpacity={0.8}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        {/* Validazione & TTL */}
        <Section icon="✅" title="Validazione e TTL" />
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <Panel title="Dataset più validati">
            {loading ? <Skeleton h={220}/> : (
              <HBar data={(data?.validate?.top_datasets||[]).map(d=>({...d,label:d.dataset_title||d.dataset_id,count:d.total}))} keyY="label"/>
            )}
          </Panel>
          <Panel title="Dataset con più TTL generati">
            {loading ? <Skeleton h={220}/> : (
              <HBar data={(data?.ttl?.top_datasets||[]).map(d=>({...d,label:d.dataset_title||d.dataset_id}))} keyY="label"/>
            )}
          </Panel>
          <Panel title="Validazioni per giorno">
            {loading ? <Skeleton h={130}/> : (
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={data?.validate?.validations_per_day||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                  <XAxis dataKey="day" tickFormatter={fmtD} tick={{fontSize:11,fill:C.muted}}/>
                  <YAxis tick={{fontSize:11,fill:C.muted}}/>
                  <Tooltip contentStyle={{fontSize:12,borderRadius:8}} labelFormatter={fmtD}/>
                  <Bar dataKey="count" fill={C.green} radius={[4,4,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
          <Panel title="TTL per giorno">
            {loading ? <Skeleton h={130}/> : (
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={data?.ttl?.ttl_per_day||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                  <XAxis dataKey="day" tickFormatter={fmtD} tick={{fontSize:11,fill:C.muted}}/>
                  <YAxis tick={{fontSize:11,fill:C.muted}}/>
                  <Tooltip contentStyle={{fontSize:12,borderRadius:8}} labelFormatter={fmtD}/>
                  <Bar dataKey="count" fill={C.violet} radius={[4,4,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        {/* Performance & Errori */}
        <Section icon="⚙️" title="Performance ed errori" />
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <Panel title="Latenza media per ora (ms)">
            {loading ? <Skeleton h={190}/> : (
              <ResponsiveContainer width="100%" height={190}>
                <LineChart data={data?.perf?.latency_per_hour||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                  <XAxis dataKey="hour" tickFormatter={fmtH} tick={{fontSize:11,fill:C.muted}} interval="preserveStartEnd"/>
                  <YAxis tick={{fontSize:11,fill:C.muted}} unit=" ms"/>
                  <Tooltip contentStyle={{fontSize:12,borderRadius:8}} labelFormatter={fmtH}/>
                  <Line type="monotone" dataKey="avg" stroke={C.amber} strokeWidth={2} dot={false}/>
                </LineChart>
              </ResponsiveContainer>
            )}
          </Panel>
          <Panel title="Errori per tipo">
            {loading ? <Skeleton h={190}/> : <ErrorTable data={data?.errors?.by_type}/>}
          </Panel>
          <Panel title="Richieste/minuto (ultime 60)" style={{gridColumn:"1/-1"}}>
            {loading ? <Skeleton h={130}/> : (
              <ResponsiveContainer width="100%" height={130}>
                <AreaChart data={data?.perf?.requests_per_minute||[]} margin={{top:5,right:10,left:-20,bottom:0}}>
                  <defs>
                    <linearGradient id="gAmber" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.amber} stopOpacity={0.18}/>
                      <stop offset="95%" stopColor={C.amber} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                  <XAxis dataKey="minute" tick={{fontSize:10,fill:C.muted}} tickFormatter={m=>m?.slice(11,16)} interval={9}/>
                  <YAxis tick={{fontSize:11,fill:C.muted}}/>
                  <Tooltip contentStyle={{fontSize:12,borderRadius:8}} labelFormatter={m=>m?.slice(11,16)}/>
                  <Area type="monotone" dataKey="count" stroke={C.amber} strokeWidth={2} fill="url(#gAmber)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        <div style={{ marginTop:40, paddingTop:16, borderTop:`1px solid ${C.border}`,
          display:"flex", justifyContent:"space-between", fontSize:12, color:C.muted }}>
          <span>CKAN Analytics — <strong>Piersoft</strong></span>
          <span>analytics-service :3004 · Auto-refresh 2 min</span>
        </div>
      </div>
    </div>
  );
}
