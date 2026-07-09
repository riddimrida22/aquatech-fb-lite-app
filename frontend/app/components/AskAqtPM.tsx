"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiGet, apiPost, apiDelete } from "../../lib/api";

type KeyNumber = { label: string; value: string };
type Series = { name: string; data: number[] };
type Chart = { type: "bar" | "line" | "pie"; title: string; unit?: string; labels: string[]; series: Series[] };
type Answerability = { status?: "answered" | "partial" | "unanswered"; missing_data?: string; suggested_source?: string };
type AskResult = {
  answer?: string;
  key_numbers?: KeyNumber[];
  charts?: Chart[];
  answerability?: Answerability;
  mode?: string;
  model?: string;
  error?: string;
  message?: string;
};

type HistoryItem = {
  id: number;
  question: string;
  mode: string;
  answer_preview?: string | null;
  created_at?: string | null;
};

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const s = /[Z+]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z"; // backend stores naive UTC
  const t = new Date(s).getTime();
  if (isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(s).toLocaleDateString();
}

const SUGGESTIONS = [
  "What's our net income and margin this year?",
  "Who is owed the most in unpaid wages?",
  "Break down revenue by client",
  "How much AR is overdue, and by whom?",
  "Which projects are most and least profitable?",
  "How much billable work is unbilled right now?",
];

const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#84cc16"];

export default function AskAqtPM() {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<"quick" | "detailed">("quick");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function refreshHistory() {
    apiGet<{ items: HistoryItem[] }>("/assistant/history?limit=25")
      .then((r) => setHistory(r.items || []))
      .catch(() => {});
  }

  useEffect(() => {
    apiGet<{ configured: boolean }>("/assistant/status")
      .then((s) => setConfigured(!!s.configured))
      .catch(() => setConfigured(null));
    refreshHistory();
  }, []);

  async function ask(q?: string) {
    const query = (q ?? question).trim();
    if (!query || loading) return;
    if (q) setQuestion(q);
    setLoading(true);
    setResult(null);
    try {
      const res = await apiPost<AskResult>("/assistant/ask", { question: query, mode });
      setResult(res);
      refreshHistory();
    } catch (e) {
      setResult({ error: "network", message: "Couldn't reach the assistant. Is the backend running?" });
    } finally {
      setLoading(false);
    }
  }

  async function deleteHistoryItem(id: number) {
    setHistory((h) => h.filter((x) => x.id !== id));
    try {
      await apiDelete(`/assistant/history?id=${id}`);
    } catch {
      refreshHistory();
    }
  }

  async function clearHistory() {
    setHistory([]);
    try {
      await apiDelete("/assistant/history");
    } catch {
      refreshHistory();
    }
  }

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6 }}>Ask AqtPM</div>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Ask anything about the company ✦</h3>
        </div>
        <div style={{ display: "inline-flex", background: "var(--aq-input-bg, rgba(0,0,0,0.06))", borderRadius: 999, padding: 3 }}>
          {(["quick", "detailed"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              title={m === "quick" ? "Short, direct answer" : "Full answer with breakdowns and charts"}
              style={{
                border: "none",
                cursor: "pointer",
                borderRadius: 999,
                padding: "6px 14px",
                fontSize: 13,
                fontWeight: 600,
                background: mode === m ? "#3b82f6" : "transparent",
                color: mode === m ? "#fff" : "inherit",
              }}
            >
              {m === "quick" ? "Quick" : "Detailed + charts"}
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <div style={{ flex: 1, position: "relative", display: "flex" }}>
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. What's our net margin, and how does it compare across projects?"
            style={{
              width: "100%",
              padding: "11px 36px 11px 14px",
              borderRadius: 10,
              border: "1px solid var(--aq-border, rgba(0,0,0,0.15))",
              background: "var(--aq-input-bg, #fff)",
              color: "inherit",
              fontSize: 15,
            }}
          />
          {question && (
            <button
              type="button"
              aria-label="Clear"
              title="Clear"
              onClick={() => {
                setQuestion("");
                setResult(null);
                inputRef.current?.focus();
              }}
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                opacity: 0.45,
                color: "inherit",
                padding: "2px 4px",
              }}
            >
              ×
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={loading || !question.trim()}
          style={{
            border: "none",
            borderRadius: 10,
            padding: "0 20px",
            fontSize: 15,
            fontWeight: 600,
            cursor: loading || !question.trim() ? "default" : "pointer",
            background: loading || !question.trim() ? "rgba(59,130,246,0.5)" : "#3b82f6",
            color: "#fff",
            minWidth: 96,
          }}
        >
          {loading ? "Thinking…" : "Ask"}
        </button>
      </form>

      {!result && !loading && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => ask(s)}
              style={{
                border: "1px solid var(--aq-border, rgba(0,0,0,0.14))",
                background: "transparent",
                color: "inherit",
                borderRadius: 999,
                padding: "5px 11px",
                fontSize: 12.5,
                cursor: "pointer",
                opacity: 0.85,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {configured === false && !result && (
        <p className="aq-lite-muted" style={{ marginTop: 10, fontSize: 13 }}>
          ⚠ The assistant isn't configured yet — add <code>ANTHROPIC_API_KEY</code> to the backend <code>.env</code> to enable it.
        </p>
      )}

      {loading && (
        <div style={{ marginTop: 16, opacity: 0.7, fontSize: 14 }}>
          Reading the books{mode === "detailed" ? " and drawing charts" : ""}…
        </div>
      )}

      {result && <AnswerPanel result={result} onClear={() => setResult(null)} />}

      {history.length > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--aq-border, rgba(0,0,0,0.08))", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.55 }}>
              Your recent questions
            </div>
            <button
              type="button"
              onClick={clearHistory}
              style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12, opacity: 0.6 }}
            >
              Clear history
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto" }}>
            {history.map((h) => (
              <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => ask(h.question)}
                  title={h.answer_preview || "Ask this again"}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    borderRadius: 8,
                    padding: "6px 8px",
                    fontSize: 13.5,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 10,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--aq-row-head-bg, rgba(59,130,246,0.07))")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.question}</span>
                  <span style={{ opacity: 0.45, fontSize: 11, whiteSpace: "nowrap" }}>{relTime(h.created_at)}</span>
                </button>
                <button
                  type="button"
                  aria-label="Remove from history"
                  title="Remove"
                  onClick={() => deleteHistoryItem(h.id)}
                  style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 16, opacity: 0.35, padding: "2px 6px", lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function AnswerPanel({ result, onClear }: { result: AskResult; onClear: () => void }) {
  const clearBtn = (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
      <button
        type="button"
        onClick={onClear}
        title="Clear this answer and start fresh"
        style={{
          border: "1px solid var(--aq-border, rgba(0,0,0,0.14))",
          background: "transparent",
          color: "inherit",
          borderRadius: 999,
          padding: "4px 12px",
          fontSize: 12.5,
          cursor: "pointer",
          opacity: 0.75,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        ↻ Clear answer
      </button>
    </div>
  );
  if (result.error) {
    return (
      <div style={{ marginTop: 14 }}>
        {clearBtn}
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 10,
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            fontSize: 14,
          }}
        >
          {result.message || "Something went wrong."}
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      {clearBtn}
      {!!result.key_numbers?.length && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          {result.key_numbers.map((k, i) => (
            <div
              key={i}
              style={{
                minWidth: 120,
                padding: "10px 14px",
                borderRadius: 10,
                background: "var(--aq-row-head-bg, rgba(59,130,246,0.08))",
                border: "1px solid var(--aq-border, rgba(0,0,0,0.08))",
              }}
            >
              <div style={{ fontSize: 11.5, opacity: 0.65, textTransform: "uppercase", letterSpacing: 0.3 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2 }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <Markdown text={result.answer || ""} />

      {result.charts?.map((c, i) => (
        <ChartView key={i} chart={c} />
      ))}

      {result.answerability && result.answerability.status && result.answerability.status !== "answered" && (
        <div
          style={{
            marginTop: 14,
            padding: "11px 14px",
            borderRadius: 10,
            background: "rgba(245,158,11,0.10)",
            border: "1px solid rgba(245,158,11,0.35)",
            fontSize: 13.5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ⚠ {result.answerability.status === "partial" ? "Partial answer — a data gap" : "Data gap — the app can't answer this yet"}
          </div>
          {result.answerability.missing_data && (
            <div style={{ marginBottom: 3 }}>
              <span style={{ opacity: 0.7 }}>Missing data:</span> {result.answerability.missing_data}
            </div>
          )}
          {result.answerability.suggested_source && (
            <div>
              <span style={{ opacity: 0.7 }}>To answer this, add:</span> {result.answerability.suggested_source}
            </div>
          )}
          <div style={{ marginTop: 5, opacity: 0.6, fontSize: 12 }}>
            Logged for the owner’s <strong>Data gaps</strong> review.
          </div>
        </div>
      )}

      {(result.model || result.mode) && (
        <div style={{ marginTop: 10, fontSize: 11, opacity: 0.45 }}>
          {result.mode === "detailed" ? "Detailed" : "Quick"} answer · {result.model} · from live company data
        </div>
      )}
    </div>
  );
}

/* ---- minimal, safe markdown renderer (no dangerouslySetInnerHTML) ---- */
function inline(text: string, keyBase: string) {
  // split on **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((p, i) => {
    const k = `${keyBase}-${i}`;
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={k}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return (
        <code key={k} style={{ background: "rgba(0,0,0,0.06)", padding: "1px 5px", borderRadius: 4, fontSize: "0.92em" }}>
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith("*") && p.endsWith("*")) return <em key={k}>{p.slice(1, -1)}</em>;
    return <span key={k}>{p}</span>;
  });
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let table: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: "6px 0 10px", paddingLeft: 22 }}>
        {items.map((it, i) => (
          <li key={i} style={{ marginBottom: 3 }}>
            {inline(it, `li-${blocks.length}-${i}`)}
          </li>
        ))}
      </ul>
    );
    list = [];
  };
  const flushTable = () => {
    if (table.length < 2) {
      table.forEach((t, i) => blocks.push(<p key={`tp-${blocks.length}-${i}`}>{inline(t, `tp-${i}`)}</p>));
      table = [];
      return;
    }
    const rows = table.filter((r) => !/^\s*\|?[\s:\-|]+\|?\s*$/.test(r)); // drop separator row
    const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const [head, ...body] = cells;
    blocks.push(
      <div key={`tbl-${blocks.length}`} style={{ overflowX: "auto", margin: "6px 0 12px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }}>
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={i} style={{ textAlign: "left", padding: "6px 10px", borderBottom: "2px solid var(--aq-border, rgba(0,0,0,0.2))" }}>
                  {inline(h, `th-${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci} style={{ padding: "5px 10px", borderBottom: "1px solid var(--aq-border, rgba(0,0,0,0.08))" }}>
                    {inline(c, `td-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    table = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("|") && line.includes("|")) {
      flushList();
      table.push(line.trim());
      continue;
    }
    if (table.length) flushTable();
    if (/^#{1,4}\s/.test(line)) {
      flushList();
      const level = line.match(/^#+/)![0].length;
      const content = line.replace(/^#+\s/, "");
      const size = [20, 17, 15, 14][level - 1] || 14;
      blocks.push(
        <div key={`h-${blocks.length}`} style={{ fontSize: size, fontWeight: 700, margin: "12px 0 4px" }}>
          {inline(content, `h-${blocks.length}`)}
        </div>
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={`p-${blocks.length}`} style={{ margin: "4px 0", lineHeight: 1.5 }}>
          {inline(line, `p-${blocks.length}`)}
        </p>
      );
    }
  }
  flushList();
  if (table.length) flushTable();
  return <div style={{ fontSize: 14.5 }}>{blocks}</div>;
}

/* ---- minimal SVG charts (single primary series) ---- */
function ChartView({ chart }: { chart: Chart }) {
  const labels = chart.labels || [];
  const series = chart.series || [];
  const primary = series[0]?.data || [];
  if (!labels.length || !primary.length) return null;
  const W = 640;
  const H = 240;
  const pad = { l: 48, r: 16, t: 12, b: 46 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const unit = chart.unit || "";
  const fmt = (n: number) =>
    unit === "$"
      ? "$" + Math.round(n).toLocaleString()
      : `${Math.round(n * 10) / 10}${unit && unit !== "$" ? unit : ""}`;

  return (
    <div style={{ margin: "14px 0", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--aq-border, rgba(0,0,0,0.08))" }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>{chart.title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", maxHeight: 260 }} role="img" aria-label={chart.title}>
        {chart.type === "pie" ? (
          <Pie data={primary} labels={labels} fmt={fmt} />
        ) : (
          <Axes labels={labels} data={primary} type={chart.type} iw={iw} ih={ih} pad={pad} fmt={fmt} />
        )}
      </svg>
    </div>
  );
}

function Axes({ labels, data, type, iw, ih, pad, fmt }: any) {
  const max = Math.max(...data, 0);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (data.length === 1 ? iw / 2 : (i * iw) / (data.length - 1));
  const bx = (i: number) => pad.l + (i * iw) / data.length + iw / data.length / 2;
  const y = (v: number) => pad.t + ih - ((v - min) / span) * ih;
  const zeroY = y(0);
  return (
    <g>
      {/* zero / baseline */}
      <line x1={pad.l} y1={zeroY} x2={pad.l + iw} y2={zeroY} stroke="rgba(128,128,128,0.4)" strokeWidth={1} />
      {[max, (max + min) / 2, min].map((v, i) => (
        <text key={i} x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="rgba(128,128,128,0.9)">
          {fmt(v)}
        </text>
      ))}
      {type === "line" ? (
        <>
          <polyline
            fill="none"
            stroke="#3b82f6"
            strokeWidth={2.5}
            points={data.map((v: number, i: number) => `${x(i)},${y(v)}`).join(" ")}
          />
          {data.map((v: number, i: number) => (
            <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="#3b82f6" />
          ))}
        </>
      ) : (
        data.map((v: number, i: number) => {
          const bw = Math.min((iw / data.length) * 0.62, 54);
          const top = Math.min(y(v), zeroY);
          const h = Math.abs(zeroY - y(v));
          return <rect key={i} x={bx(i) - bw / 2} y={top} width={bw} height={Math.max(h, 1)} rx={3} fill={CHART_COLORS[i % CHART_COLORS.length]} />;
        })
      )}
      {labels.map((l: string, i: number) => (
        <text
          key={i}
          x={type === "line" ? x(i) : bx(i)}
          y={pad.t + ih + 16}
          textAnchor="middle"
          fontSize={10.5}
          fill="rgba(128,128,128,0.95)"
        >
          {l.length > 12 ? l.slice(0, 11) + "…" : l}
        </text>
      ))}
    </g>
  );
}

function Pie({ data, labels, fmt }: { data: number[]; labels: string[]; fmt: (n: number) => string }) {
  const total = data.reduce((a, b) => a + Math.abs(b), 0) || 1;
  const cx = 130;
  const cy = 120;
  const r = 92;
  let a0 = -Math.PI / 2;
  return (
    <g>
      {data.map((v, i) => {
        const frac = Math.abs(v) / total;
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const x0 = cx + r * Math.cos(a0);
        const y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy + r * Math.sin(a1);
        const path = `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
        a0 = a1;
        return <path key={i} d={path} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="var(--aq-panel-bg,#fff)" strokeWidth={1.5} />;
      })}
      {labels.map((l, i) => (
        <g key={i} transform={`translate(${268}, ${34 + i * 22})`}>
          <rect width={12} height={12} rx={2} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          <text x={18} y={11} fontSize={12} fill="currentColor">
            {l} — {fmt(data[i])}
          </text>
        </g>
      ))}
    </g>
  );
}
