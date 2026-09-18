"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type Proj = {
  project_id: number;
  project: string;
  lifecycle_status: string;
  budget_fee: number;
  invoiced: number;
  unbilled_wip: number;
  stale_wip: number;
  oldest_unbilled: string | null;
  oldest_unbilled_age_days: number | null;
  last_invoice: string | null;
  days_since_last_invoice: number | null;
  burn_pct: number | null;
  flags: string[];
};

type AlertsResp = {
  as_of: string;
  stale_days: number;
  burn_warn_pct: number;
  totals: { unbilled_wip: number; stale_wip: number; flagged: number };
  projects: Proj[];
};

const RED = "#b42318";
const GOLD = "#b8860b";
const GREEN = "#1f8a5b";
const money = (n: number | null | undefined) => formatCurrency(n ?? 0);

const FLAG_META: Record<string, { label: string; color: string }> = {
  over_budget: { label: "Over budget", color: RED },
  high_burn: { label: "High burn", color: GOLD },
  stale_wip: { label: "Stale WIP", color: GOLD },
  strategic: { label: "Strategic / loss leader", color: GREEN },
};

function burnColor(pct: number | null): string {
  if (pct == null) return "inherit";
  if (pct >= 100) return RED;
  if (pct >= 80) return GOLD;
  return GREEN;
}

export default function ProjectAlertsPanel() {
  const [data, setData] = useState<AlertsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet<AlertsResp>(`/accounting/project-alerts?stale_days=45`)
      .then((r) => { setData(r); setLoading(false); })
      .catch((e) => { setErr(e?.message || "Could not load alerts"); setLoading(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  const flagged = data?.projects.filter((p) => p.flags.length) ?? [];

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16, borderLeft: `3px solid ${flagged.length ? RED : GREEN}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0, color: flagged.length ? RED : GREEN }}>Profitability · Leak watch</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Stale WIP &amp; Budget Burn</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 640 }}>
            WIP is normal between invoices — <strong>stale WIP</strong> is billable work sitting unbilled past {data?.stale_days ?? 45} days (at risk of never billing). <strong>Burn</strong> = (invoiced + WIP) ÷ budget.
          </p>
        </div>
      </div>

      {err ? <p style={{ color: RED, marginTop: 12 }}>{err}</p> : null}
      {loading ? <p className="aq-lite-muted" style={{ marginTop: 12 }}>Loading…</p> : null}

      {t && !loading ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, margin: "14px 0" }}>
            <Tile label="Unbilled WIP" value={money(t.unbilled_wip)} sub="across active projects" />
            <Tile label="Stale WIP" value={money(t.stale_wip)} color={t.stale_wip > 0 ? RED : GREEN} sub={`past ${data!.stale_days} days`} />
            <Tile label="Flagged projects" value={String(t.flagged)} color={t.flagged ? RED : GREEN} sub={t.flagged ? "need attention" : "all clear"} />
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Project</th>
                  <th style={{ textAlign: "right" }}>Budget</th>
                  <th style={{ textAlign: "left", minWidth: 130 }}>Burn</th>
                  <th style={{ textAlign: "right" }}>Unbilled WIP</th>
                  <th style={{ textAlign: "right" }}>Stale WIP</th>
                  <th style={{ textAlign: "right" }}>Last invoice</th>
                  <th style={{ textAlign: "left" }}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {data!.projects.map((p) => (
                  <tr key={p.project_id}>
                    <td>{p.project}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(p.budget_fee)}</td>
                    <td>
                      {p.burn_pct == null ? <span className="aq-lite-muted">—</span> : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 8, background: "rgba(128,128,128,0.2)", borderRadius: 4, overflow: "hidden", minWidth: 60 }}>
                            <div style={{ width: `${Math.min(100, p.burn_pct)}%`, height: "100%", background: burnColor(p.burn_pct) }} />
                          </div>
                          <span style={{ color: burnColor(p.burn_pct), fontWeight: 600, minWidth: 44, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{p.burn_pct.toFixed(0)}%</span>
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(p.unbilled_wip)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: p.stale_wip > 0 ? RED : "inherit" }}>{p.stale_wip > 0 ? money(p.stale_wip) : "—"}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }} className="aq-lite-muted">
                      {p.days_since_last_invoice == null ? "never" : `${p.days_since_last_invoice}d ago`}
                    </td>
                    <td>
                      {p.flags.length === 0 ? <span className="aq-lite-muted">—</span> : p.flags.map((f) => {
                        const m = FLAG_META[f] ?? { label: f, color: GOLD };
                        return (
                          <span key={f} style={{ display: "inline-block", marginRight: 6, padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, color: "#fff", background: m.color }}>{m.label}</span>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            &quot;Last invoice&quot; days-since flags a project that hasn&apos;t billed recently even without stale WIP. Loss-leader / fixed-fee projects can exceed 100% burn by design.
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
