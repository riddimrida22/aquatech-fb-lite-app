"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type SeriesPoint = { date: string; earned_margin: number; daily_profit: number; is_weekend: boolean };

type DailyProfitability = {
  as_of_date: string;
  is_weekend: boolean;
  day: {
    date: string;
    billable_hours: number;
    nonbillable_hours: number;
    revenue: number;
    labor_cost: number;
    earned_margin: number;
    margin_pct: number;
  };
  overhead: {
    per_working_day: number;
    embedded_in_cost_rate: boolean;
    reference_avg_monthly_opex: number;
    reference_total_opex_lookback: number;
    lookback_start: string;
    lookback_end: string;
    lookback_months: number;
    business_days_in_lookback: number;
  };
  daily_profit: number;
  break_even: { billable_hours_needed: number | null; margin_per_billable_hour: number };
  mtd: { earned_margin: number; overhead: number; profit: number; working_days_elapsed: number };
  series: SeriesPoint[];
  notes: string[];
};

const GREEN = "#1f8a5b";
const RED = "#b42318";

function money(n: number | null | undefined): string {
  return formatCurrency(n ?? 0);
}
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function DailyProfitabilityKPI() {
  const [data, setData] = useState<DailyProfitability | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lookback, setLookback] = useState(6);
  const [dateSel, setDateSel] = useState<string>(""); // "" = latest day with data

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ lookback_months: String(lookback) });
    if (dateSel) params.set("date", dateSel);
    apiGet<DailyProfitability>(`/accounting/daily-profitability?${params.toString()}`)
      .then((r) => {
        setData(r);
        setLoading(false);
      })
      .catch((e) => {
        setErr(e?.message || "Could not load");
        setLoading(false);
      });
  }, [lookback, dateSel]);

  useEffect(() => {
    load();
  }, [load]);

  const profitColor = data && data.daily_profit >= 0 ? GREEN : RED;
  const maxAbs = data ? Math.max(1, ...data.series.map((p) => Math.abs(p.daily_profit))) : 1;

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Daily reconciliation</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Company profitability — daily</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 560 }}>
            Billable value produced vs fully-loaded labor cost (overhead is baked into the cost rate) — did today pay for itself?
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={lookback}
            onChange={(e) => setLookback(Number(e.target.value))}
            title="Trailing months used to average the overhead"
            style={{ fontSize: 12.5, padding: "3px 6px", borderRadius: 6 }}
          >
            <option value={3}>3-mo avg</option>
            <option value={6}>6-mo avg</option>
            <option value={12}>12-mo avg</option>
          </select>
          <input
            type="date"
            value={dateSel || data?.as_of_date || ""}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDateSel(e.target.value)}
            title="Pick a day (defaults to the latest day with logged time)"
            style={{ fontSize: 12.5, padding: "3px 6px", borderRadius: 6 }}
          />
        </div>
      </div>

      {err ? (
        <p style={{ color: RED, fontSize: 13, marginTop: 12 }}>Couldn&apos;t load daily profitability: {err}</p>
      ) : !data ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 12 }}>{loading ? "Loading…" : "No data."}</p>
      ) : (
        <>
          {/* Headline + sub-metrics */}
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "stretch", marginTop: 14 }}>
            <div
              style={{
                flex: "1 1 220px",
                minWidth: 200,
                padding: "14px 16px",
                borderRadius: 12,
                background: data.daily_profit >= 0 ? "rgba(31,138,91,0.09)" : "rgba(180,35,24,0.08)",
                border: `1px solid ${data.daily_profit >= 0 ? "rgba(31,138,91,0.30)" : "rgba(180,35,24,0.28)"}`,
              }}
            >
              <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.65 }}>
                Daily profit · {shortDate(data.day.date)}
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, color: profitColor, lineHeight: 1.15, marginTop: 2 }}>
                {data.daily_profit >= 0 ? "" : "−"}{money(Math.abs(data.daily_profit))}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 3 }}>
                {data.day.billable_hours}h billable
                {data.day.nonbillable_hours > 0 ? ` · ${data.day.nonbillable_hours}h non-billable` : ""}
                {data.is_weekend ? " · weekend" : ""}
              </div>
            </div>

            <MetricCell
              label="Revenue (day)"
              value={money(data.day.revenue)}
              sub={`${data.day.billable_hours}h billable × bill rate`}
              color={GREEN}
            />
            <MetricCell
              label="Loaded labor cost (day)"
              value={`−${money(data.day.labor_cost)}`}
              sub="all hours × loaded cost rate (incl. overhead)"
              color={RED}
            />
            <MetricCell
              label="Margin %"
              value={`${(data.day.margin_pct * 100).toFixed(1)}%`}
              sub={
                data.break_even.billable_hours_needed != null
                  ? `break-even ≈ ${data.break_even.billable_hours_needed} billable hrs`
                  : "no billable hours this day"
              }
              color={data.day.margin_pct >= 0 ? GREEN : RED}
            />
          </div>

          {/* MTD strip */}
          <div
            style={{
              display: "flex",
              gap: 20,
              flexWrap: "wrap",
              marginTop: 14,
              padding: "10px 14px",
              borderRadius: 10,
              background: "var(--aq-input-bg, rgba(0,0,0,0.04))",
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 700, opacity: 0.7, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.4, alignSelf: "center" }}>
              Month to date
            </span>
            <MtdItem label="Profit (loaded margin)" value={data.mtd.profit} money />
            <span style={{ alignSelf: "center", opacity: 0.6 }}>{data.mtd.working_days_elapsed} working days elapsed</span>
          </div>

          {/* Trend */}
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, marginBottom: 5 }}>
              Daily profit — last 30 days
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 2, height: 68, borderBottom: "1px solid rgba(128,128,128,0.25)" }}>
              {data.series.map((p) => {
                const h = (Math.abs(p.daily_profit) / maxAbs) * 30;
                const pos = p.daily_profit >= 0;
                return (
                  <div
                    key={p.date}
                    title={`${p.date}${p.is_weekend ? " (weekend)" : ""}: ${p.daily_profit >= 0 ? "+" : "−"}${money(Math.abs(p.daily_profit))}`}
                    style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", height: "100%", alignItems: "center" }}
                  >
                    <div style={{ height: 30, display: "flex", alignItems: "flex-end", width: "100%", justifyContent: "center" }}>
                      {pos && <div style={{ width: "72%", height: Math.max(1, h), background: p.is_weekend ? "rgba(31,138,91,0.30)" : GREEN, borderRadius: "2px 2px 0 0" }} />}
                    </div>
                    <div style={{ height: 30, display: "flex", alignItems: "flex-start", width: "100%", justifyContent: "center" }}>
                      {!pos && <div style={{ width: "72%", height: Math.max(1, h), background: p.is_weekend ? "rgba(180,35,24,0.28)" : RED, borderRadius: "0 0 2px 2px" }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 12.5, opacity: 0.7 }}>How this is calculated</summary>
            <ul style={{ fontSize: 12.5, opacity: 0.8, margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
              {data.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
              <li>
                Reference only (NOT subtracted): booked non-COGS OPEX was {money(data.overhead.reference_total_opex_lookback)} over{" "}
                {shortDate(data.overhead.lookback_start)}–{shortDate(data.overhead.lookback_end)} — overhead lives inside the loaded cost rate; the gap vs what the rate recovers is over/under-applied overhead in the P&L.
              </li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
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

function MtdItem({ label, value, money: isMoney }: { label: string; value: number; money?: boolean }) {
  const color = value >= 0 ? GREEN : RED;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.25 }}>
      <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, opacity: 0.55 }}>{label}</span>
      <span style={{ fontWeight: 700, color }}>
        {value < 0 ? "−" : ""}
        {isMoney ? formatCurrency(Math.abs(value)) : Math.abs(value)}
      </span>
    </span>
  );
}
