"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type UtilRow = {
  user_id: number;
  name: string;
  total_hours: number;
  billable_hours: number;
  nonbillable_hours: number;
  utilization_pct: number;
  billable_value: number;
  labor_cost: number;
  margin: number;
  margin_pct: number;
  billed_value: number;
  unbilled_value: number;
};

type UtilResponse = {
  period: { start: string; end: string };
  rows: UtilRow[];
  totals: UtilRow & { name?: string };
};

const GOLD = "#b8860b";
const GREEN = "#1f8a5b";
const RED = "#b42318";
const money = (n: number | null | undefined) => formatCurrency(n ?? 0);
const pct = (n: number | null | undefined) => `${(n ?? 0).toFixed(1)}%`;

// Utilization target band for an engineering consultancy
const UTIL_TARGET = 75;

function utilColor(u: number): string {
  if (u >= UTIL_TARGET) return GREEN;
  if (u >= 50) return GOLD;
  return RED;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function yearStartISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export default function UtilizationWorkspace() {
  const [data, setData] = useState<UtilResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [start, setStart] = useState<string>(yearStartISO());
  const [end, setEnd] = useState<string>(todayISO());

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ start, end });
    apiGet<UtilResponse>(`/accounting/utilization?${params.toString()}`)
      .then((r) => { setData(r); setLoading(false); })
      .catch((e) => { setErr(e?.message || "Could not load utilization"); setLoading(false); });
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals;

  return (
    <section className="aq-lite-panel" style={{ borderLeft: `3px solid ${GOLD}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0, color: GOLD }}>Profitability · Team</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Utilization &amp; Realization</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 620 }}>
            Utilization = billable hours ÷ total logged hours (the #1 profit lever). Margin is billable value less
            fully‑loaded cost. Unbilled = billable work not yet invoiced (WIP).
          </p>
        </div>
        <div style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="aq-lite-muted" style={{ fontSize: 12 }}>
            From <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} style={{ marginLeft: 4 }} />
          </label>
          <label className="aq-lite-muted" style={{ fontSize: 12 }}>
            To <input type="date" value={end} min={start} max={todayISO()} onChange={(e) => setEnd(e.target.value)} style={{ marginLeft: 4 }} />
          </label>
        </div>
      </div>

      {err ? <p style={{ color: RED, marginTop: 12 }}>{err}</p> : null}
      {loading ? <p className="aq-lite-muted" style={{ marginTop: 12 }}>Loading…</p> : null}

      {t && !loading ? (
        <>
          {/* Firm KPI tiles */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, margin: "14px 0" }}>
            <Tile label="Firm utilization" value={pct(t.utilization_pct)} color={utilColor(t.utilization_pct)}
              sub={`${t.billable_hours.toLocaleString()} of ${t.total_hours.toLocaleString()} hrs`} />
            <Tile label="Billable value" value={money(t.billable_value)} sub={`${money(t.billed_value)} billed`} />
            <Tile label="Contribution margin" value={pct(t.margin_pct)} color={t.margin >= 0 ? GREEN : RED}
              sub={money(t.margin)} />
            <Tile label="Unbilled (WIP)" value={money(t.unbilled_value)} color={GOLD} sub="not yet invoiced" />
          </div>

          {/* Per-person table */}
          <div style={{ overflowX: "auto" }}>
            <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Employee</th>
                  <th style={{ textAlign: "left", minWidth: 160 }}>Utilization</th>
                  <th style={{ textAlign: "right" }}>Billable / Total h</th>
                  <th style={{ textAlign: "right" }}>Billable value</th>
                  <th style={{ textAlign: "right" }}>Loaded cost</th>
                  <th style={{ textAlign: "right" }}>Margin</th>
                  <th style={{ textAlign: "right" }}>Unbilled</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r) => (
                  <tr key={r.user_id}>
                    <td>{r.name}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, height: 8, background: "rgba(128,128,128,0.2)", borderRadius: 4, overflow: "hidden", minWidth: 70 }}>
                          <div style={{ width: `${Math.min(100, r.utilization_pct)}%`, height: "100%", background: utilColor(r.utilization_pct) }} />
                        </div>
                        <span style={{ fontVariantNumeric: "tabular-nums", color: utilColor(r.utilization_pct), fontWeight: 600, minWidth: 46, textAlign: "right" }}>{pct(r.utilization_pct)}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.billable_hours.toLocaleString()} / {r.total_hours.toLocaleString()}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(r.billable_value)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(r.labor_cost)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.margin >= 0 ? GREEN : RED }}>{money(r.margin)} <span className="aq-lite-muted">({pct(r.margin_pct)})</span></td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(r.unbilled_value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: "2px solid rgba(128,128,128,0.4)" }}>
                  <td>Firm total</td>
                  <td style={{ color: utilColor(t.utilization_pct) }}>{pct(t.utilization_pct)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{t.billable_hours.toLocaleString()} / {t.total_hours.toLocaleString()}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(t.billable_value)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(t.labor_cost)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: t.margin >= 0 ? GREEN : RED }}>{money(t.margin)}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(t.unbilled_value)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            Overhead roles (COO, admin) will show low utilization and negative billable margin by design — their cost sits in the overhead pool. Target billable utilization ≈ {UTIL_TARGET}%. Period: {data!.period.start} → {data!.period.end}.
          </p>
        </>
      ) : null}
    </section>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="aq-lite-card" style={{ padding: "10px 12px", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 8 }}>
      <p className="aq-lite-muted" style={{ margin: 0, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</p>
      <p style={{ margin: "3px 0 0", fontSize: 22, fontWeight: 700, color: color || "inherit", fontVariantNumeric: "tabular-nums" }}>{value}</p>
      {sub ? <p className="aq-lite-muted" style={{ margin: "1px 0 0", fontSize: 11.5 }}>{sub}</p> : null}
    </div>
  );
}
