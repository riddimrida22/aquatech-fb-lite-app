"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type MonthRow = {
  month: string;
  label: string;
  start: string;
  end: string;
  revenue_cash: number;
  revenue_accrual: number;
  cogs: number;
  opex: number;
  interest_expense: number;
  fees_expense: number;
  net_income_cash: number;
  net_income_accrual: number;
  net_margin_cash: number;
  net_margin_accrual: number;
};

type MonthlyPL = {
  period: { start: string; end: string };
  months: MonthRow[];
  totals: MonthRow & { net_margin_cash: number; net_margin_accrual: number };
  notes: string[];
};

const GREEN = "#1f8a5b";
const RED = "#b42318";

function money(n: number | null | undefined): string {
  return formatCurrency(n ?? 0);
}
function net(n: number): { text: string; color: string } {
  return { text: `${n < 0 ? "−" : ""}${money(Math.abs(n))}`, color: n >= 0 ? GREEN : RED };
}
function pct(m: number): string {
  return `${(m * 100).toFixed(1)}%`;
}

export default function MonthlyPLPanel() {
  const [data, setData] = useState<MonthlyPL | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<string>("t12"); // t12 | 2026 | 2025

  const { start, end } = useMemo(() => {
    if (range === "t12") return { start: "", end: "" };
    const y = Number(range);
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }, [range]);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    apiGet<MonthlyPL>(`/accounting/pl-monthly${p.toString() ? `?${p.toString()}` : ""}`)
      .then((r) => {
        setData(r);
        setLoading(false);
      })
      .catch((e) => {
        setErr(e?.message || "Could not load");
        setLoading(false);
      });
  }, [start, end]);

  useEffect(() => {
    load();
  }, [load]);

  const thBase: React.CSSProperties = {
    textAlign: "right",
    padding: "6px 10px",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    opacity: 0.65,
    whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = { textAlign: "right", padding: "6px 10px", fontSize: 13, whiteSpace: "nowrap" };

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Monthly P&amp;L</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Month-by-month — cash &amp; accrual</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 620 }}>
            Every month, both bases side by side. Cash = collected; accrual = invoiced. Same figures as the single-period P&amp;L.
          </p>
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          style={{ fontSize: 12.5, padding: "4px 8px", borderRadius: 6 }}
        >
          <option value="t12">Last 12 months</option>
          <option value="2026">2026</option>
          <option value="2025">2025</option>
        </select>
      </div>

      {err ? (
        <p style={{ color: RED, fontSize: 13, marginTop: 12 }}>Couldn&apos;t load monthly P&amp;L: {err}</p>
      ) : !data ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 12 }}>{loading ? "Loading…" : "No data."}</p>
      ) : data.months.length === 0 ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 12 }}>No months in range.</p>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                <th style={{ ...thBase, textAlign: "left" }}>Month</th>
                <th style={thBase}>Rev · Cash</th>
                <th style={thBase}>Rev · Accrual</th>
                <th style={thBase}>COGS</th>
                <th style={thBase}>OPEX</th>
                <th style={{ ...thBase, borderLeft: "1px solid rgba(128,128,128,0.2)" }}>Net · Cash</th>
                <th style={thBase}>Net · Accrual</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => {
                const nc = net(m.net_income_cash);
                const na = net(m.net_income_accrual);
                return (
                  <tr key={m.month} style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{m.label}</td>
                    <td style={td}>{money(m.revenue_cash)}</td>
                    <td style={{ ...td, opacity: 0.85 }}>{money(m.revenue_accrual)}</td>
                    <td style={{ ...td, opacity: 0.75 }}>({money(m.cogs)})</td>
                    <td style={{ ...td, opacity: 0.75 }}>({money(m.opex)})</td>
                    <td style={{ ...td, borderLeft: "1px solid rgba(128,128,128,0.2)", fontWeight: 700, color: nc.color }}>
                      {nc.text}
                      <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11.5 }}> · {pct(m.net_margin_cash)}</span>
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: na.color }}>
                      {na.text}
                      <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11.5 }}> · {pct(m.net_margin_accrual)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid rgba(128,128,128,0.4)" }}>
                <td style={{ ...td, textAlign: "left", fontWeight: 800, textTransform: "uppercase", fontSize: 11.5, letterSpacing: 0.3 }}>Total</td>
                <td style={{ ...td, fontWeight: 700 }}>{money(data.totals.revenue_cash)}</td>
                <td style={{ ...td, fontWeight: 700, opacity: 0.85 }}>{money(data.totals.revenue_accrual)}</td>
                <td style={{ ...td, fontWeight: 700, opacity: 0.75 }}>({money(data.totals.cogs)})</td>
                <td style={{ ...td, fontWeight: 700, opacity: 0.75 }}>({money(data.totals.opex)})</td>
                <td style={{ ...td, borderLeft: "1px solid rgba(128,128,128,0.2)", fontWeight: 800, color: net(data.totals.net_income_cash).color }}>
                  {net(data.totals.net_income_cash).text}
                  <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11.5 }}> · {pct(data.totals.net_margin_cash)}</span>
                </td>
                <td style={{ ...td, fontWeight: 800, color: net(data.totals.net_income_accrual).color }}>
                  {net(data.totals.net_income_accrual).text}
                  <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 11.5 }}> · {pct(data.totals.net_margin_accrual)}</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
