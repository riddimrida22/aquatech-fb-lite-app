"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type SeriesPoint = { date: string; label?: string; earned_margin: number; daily_profit: number; is_weekend: boolean };
type PeriodKind = "day" | "week" | "month";

type DailyProfitability = {
  as_of_date: string;
  period_kind: PeriodKind;
  period: {
    kind: PeriodKind;
    label: string;
    start: string;
    end: string;
    billable_hours: number;
    nonbillable_hours: number;
    revenue: number;
    labor_cost: number;
    earned_margin: number;
    margin_pct: number;
    working_days: number;
  };
  nav: { prev: string | null; next: string | null };
  daily_profit: number;
  break_even: { billable_hours_needed: number | null; margin_per_billable_hour: number };
  mtd: { profit: number; working_days_elapsed: number };
  series: SeriesPoint[];
  notes: string[];
};

const GREEN = "#1f8a5b";
const RED = "#b42318";
const money = (n: number | null | undefined) => formatCurrency(n ?? 0);

const KINDS: { key: PeriodKind; label: string; noun: string }[] = [
  { key: "day", label: "Daily", noun: "day" },
  { key: "week", label: "Weekly", noun: "week" },
  { key: "month", label: "Monthly", noun: "month" },
];

export default function DailyProfitabilityKPI() {
  const [data, setData] = useState<DailyProfitability | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKind>("day");
  const [anchor, setAnchor] = useState<string>(""); // "" = latest period with data

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ period });
    if (anchor) params.set("date", anchor);
    apiGet<DailyProfitability>(`/accounting/daily-profitability?${params.toString()}`)
      .then((r) => { setData(r); setLoading(false); })
      .catch((e) => { setErr(e?.message || "Could not load"); setLoading(false); });
  }, [period, anchor]);
  useEffect(() => { load(); }, [load]);

  const noun = KINDS.find((k) => k.key === period)?.noun ?? "day";
  const profit = data?.period.earned_margin ?? 0;
  const profitColor = profit >= 0 ? GREEN : RED;
  const maxAbs = data ? Math.max(1, ...data.series.map((p) => Math.abs(p.earned_margin))) : 1;

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      {/* Header: title + period toggle */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Profitability</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Company profitability</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 560 }}>
            Billable value produced vs fully-loaded labor cost (overhead is inside the cost rate) — did this {noun} pay for itself?
          </p>
        </div>
        <div style={{ display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(128,128,128,0.35)" }}>
          {KINDS.map((k) => {
            const active = period === k.key;
            return (
              <button
                key={k.key}
                onClick={() => setPeriod(k.key)}
                style={{
                  border: "none", cursor: "pointer", padding: "6px 14px", fontSize: 12.5, fontWeight: active ? 700 : 500,
                  background: active ? "#1E2761" : "transparent", color: active ? "#fff" : "inherit",
                }}
              >
                {k.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Period navigator */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button onClick={() => data?.nav.prev && setAnchor(data.nav.prev)} disabled={!data?.nav.prev} title="Previous" style={navBtn(!!data?.nav.prev)}>‹</button>
        <div style={{ minWidth: 170, textAlign: "center", fontWeight: 700, fontSize: 15 }}>{data?.period.label ?? "…"}</div>
        <button onClick={() => data?.nav.next && setAnchor(data.nav.next)} disabled={!data?.nav.next} title="Next" style={navBtn(!!data?.nav.next)}>›</button>
        {anchor ? (
          <button onClick={() => setAnchor("")} style={{ ...navBtn(true), width: "auto", padding: "0 10px", fontSize: 12 }} title="Jump to the latest period">Latest</button>
        ) : null}
        <input
          type="date"
          value={data?.period.end || ""}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => e.target.value && setAnchor(e.target.value)}
          title="Jump to a date"
          style={{ fontSize: 12.5, padding: "4px 6px", borderRadius: 6, marginLeft: "auto" }}
        />
      </div>

      {err ? (
        <p style={{ color: RED, fontSize: 13, marginTop: 12 }}>Couldn&apos;t load: {err}</p>
      ) : !data ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 12 }}>{loading ? "Loading…" : "No data."}</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "stretch", marginTop: 14, opacity: loading ? 0.55 : 1, transition: "opacity .15s" }}>
            <div style={{ flex: "1 1 220px", minWidth: 200, padding: "14px 16px", borderRadius: 12,
              background: profit >= 0 ? "rgba(31,138,91,0.09)" : "rgba(180,35,24,0.08)",
              border: `1px solid ${profit >= 0 ? "rgba(31,138,91,0.30)" : "rgba(180,35,24,0.28)"}` }}>
              <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.65 }}>
                {period === "day" ? "Daily" : period === "week" ? "Weekly" : "Monthly"} profit
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, color: profitColor, lineHeight: 1.15, marginTop: 2 }}>
                {profit >= 0 ? "" : "−"}{money(Math.abs(profit))}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3 }}>
                {data.period.billable_hours}h billable
                {data.period.nonbillable_hours > 0 ? ` · ${data.period.nonbillable_hours}h non-billable` : ""}
                {data.period.working_days > 1 ? ` · ${data.period.working_days} working days` : ""}
              </div>
            </div>
            <MetricCell label={`Revenue (${noun})`} value={money(data.period.revenue)} sub={`${data.period.billable_hours}h billable × bill rate`} color={GREEN} />
            <MetricCell label={`Loaded labor cost (${noun})`} value={`−${money(data.period.labor_cost)}`} sub="client hours × loaded cost rate (incl. overhead)" color={RED} />
            <MetricCell
              label="Margin %"
              value={`${(data.period.margin_pct * 100).toFixed(1)}%`}
              sub={data.break_even.billable_hours_needed != null ? `break-even ≈ ${data.break_even.billable_hours_needed} billable hrs` : "no billable hours"}
              color={data.period.margin_pct >= 0 ? GREEN : RED}
            />
          </div>

          {/* Trend */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, marginBottom: 5 }}>
              Profit — {period === "day" ? "last 30 days" : period === "week" ? "last 12 weeks" : "last 12 months"} · click to jump
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: period === "day" ? 2 : 5, height: 76, borderBottom: "1px solid rgba(128,128,128,0.25)" }}>
              {data.series.map((p) => {
                const h = (Math.abs(p.earned_margin) / maxAbs) * 32;
                const pos = p.earned_margin >= 0;
                const isCur = p.date >= data.period.start && p.date <= data.period.end;
                return (
                  <div key={p.date} onClick={() => setAnchor(p.date)}
                    title={`${p.label || p.date}: ${pos ? "+" : "−"}${money(Math.abs(p.earned_margin))}`}
                    style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", height: "100%", alignItems: "center", cursor: "pointer" }}>
                    <div style={{ height: 34, display: "flex", alignItems: "flex-end", width: "100%", justifyContent: "center" }}>
                      {pos && <div style={{ width: period === "day" ? "72%" : "60%", height: Math.max(1, h), background: p.is_weekend ? "rgba(31,138,91,0.30)" : GREEN, outline: isCur ? "2px solid #1E2761" : "none", borderRadius: "2px 2px 0 0" }} />}
                    </div>
                    <div style={{ height: 34, display: "flex", alignItems: "flex-start", width: "100%", justifyContent: "center" }}>
                      {!pos && <div style={{ width: period === "day" ? "72%" : "60%", height: Math.max(1, h), background: p.is_weekend ? "rgba(180,35,24,0.28)" : RED, outline: isCur ? "2px solid #1E2761" : "none", borderRadius: "0 0 2px 2px" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            {period !== "day" ? (
              <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
                {data.series.map((p, i) => (
                  <div key={p.date} style={{ flex: 1, textAlign: "center", fontSize: 9, opacity: (i % 2 === 0 || period === "month") ? 0.6 : 0, whiteSpace: "nowrap", overflow: "hidden" }}>{p.label}</div>
                ))}
              </div>
            ) : null}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 12.5, opacity: 0.7 }}>How this is calculated</summary>
            <ul style={{ fontSize: 12.5, opacity: 0.8, margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
              {data.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}

function navBtn(enabled: boolean): React.CSSProperties {
  return {
    width: 34, height: 30, borderRadius: 7, border: "1px solid rgba(128,128,128,0.35)",
    background: enabled ? "var(--aq-input-bg, rgba(0,0,0,0.03))" : "transparent",
    color: enabled ? "inherit" : "rgba(128,128,128,0.4)", cursor: enabled ? "pointer" : "default",
    fontSize: 18, lineHeight: 1, fontWeight: 700,
  };
}

function MetricCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ flex: "1 1 170px", minWidth: 150, padding: "14px 4px" }}>
      <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 750, color: color || "inherit", marginTop: 2 }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, opacity: 0.62, marginTop: 3 }}>{sub}</div> : null}
    </div>
  );
}
