"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

type SourceCount = { source: string; count: number };
type DupCandidate = {
  date: string;
  amount: number;
  plaid_id: number;
  plaid_name: string;
  csv_id: number;
  csv_name: string;
};
type ReconcilePreview = {
  invoices: { by_source: SourceCount[] };
  project_expenses: { by_source: SourceCount[] };
  bank_transactions: {
    by_source: SourceCount[];
    csv_chase_range: [string | null, string | null];
    plaid_api_range: [string | null, string | null];
    overlap_window: [string | null, string | null];
    duplicate_candidates_count: number;
    duplicate_candidates_sample: DupCandidate[];
    csv_in_overlap?: number;
    plaid_in_overlap?: number;
  };
};

type DedupeResult = {
  status: string;
  overlap_window?: [string, string];
  retagged: number;
};

type Bucket = {
  label: string;
  count: number;
  total: number;
  samples: { id: number; date: string; name: string; amount: number; source: string }[];
};

type FullReport = {
  period: { start: string; end: string };
  outflow_buckets: Record<string, Bucket>;
  revenue_cash_invoices: number;
  inflow_categorization: Record<string, number>;
  user_notes: string[];
};

type ActiveOpexItem = {
  id: number;
  date: string;
  amount: number;
  name: string;
  source: string;
  promoted_from_personal: boolean;
};

type ActiveOpex = {
  period: { start: string; end: string };
  count: number;
  total: number;
  items: ActiveOpexItem[];
};

const fmt$ = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function ReconciliationPanel() {
  const [year, setYear] = useState<string>("2026");
  const [data, setData] = useState<ReconcilePreview | null>(null);
  const [report, setReport] = useState<FullReport | null>(null);
  const [activeOpex, setActiveOpex] = useState<ActiveOpex | null>(null);
  const [showOpexList, setShowOpexList] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dedupeResult, setDedupeResult] = useState<DedupeResult | null>(null);

  function periodForYear(y: string): { start: string; end: string } {
    if (y === "2026") return { start: "2026-01-01", end: "2026-05-02" };
    if (y === "2025") return { start: "2025-01-01", end: "2025-12-31" };
    if (y === "2024") return { start: "2024-01-01", end: "2024-12-31" };
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }

  async function load() {
    setErr(null);
    setActiveOpex(null);
    setShowOpexList(false);
    try {
      const period = periodForYear(year);
      const [d, r] = await Promise.all([
        apiGet<ReconcilePreview>("/admin/reconcile/preview"),
        apiGet<FullReport>(`/admin/reconcile/full-report?start=${period.start}&end=${period.end}`),
      ]);
      setData(d);
      setReport(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  async function loadActiveOpex() {
    setErr(null);
    try {
      const period = periodForYear(year);
      const r = await apiGet<ActiveOpex>(`/admin/reconcile/active-opex?start=${period.start}&end=${period.end}`);
      setActiveOpex(r);
      setShowOpexList(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  async function dedupe(apply: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<DedupeResult>(`/admin/reconcile/dedupe-bank?apply=${apply}`);
      setDedupeResult(r);
      if (apply) await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Dedupe failed");
    } finally {
      setBusy(false);
    }
  }

  if (err) {
    return (
      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <p className="aq-lite-eyebrow">Reconciliation</p>
          <h3>API ↔ CSV reconciliation</h3>
        </div>
        <p style={{ color: "var(--aq-red)" }}>{err}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="aq-lite-panel">
        <p>Loading reconciliation preview…</p>
      </section>
    );
  }

  const bt = data.bank_transactions;
  const dupCount = bt.duplicate_candidates_count;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Reconciliation</p>
          <h3>API ↔ CSV reconciliation</h3>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>Period:</label>
          <select value={year} onChange={(e) => setYear(e.target.value)} style={{ fontSize: 12 }}>
            <option value="2026">2026 YTD</option>
            <option value="2025">2025 (full year)</option>
            <option value="2024">2024 (full year)</option>
          </select>
          <button type="button" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 12 }}>
        Every operational row is now tagged with its source. <strong>API sources</strong> (<code>freshbooks_api</code>,
        <code>plaid_api</code>) are canonical. <strong>CSV imports</strong> (<code>csv_chase</code>, <code>csv_fb_expenses</code>)
        are kept as historical archive — when an API row supersedes a CSV row by date+amount match, the CSV row
        gets retagged <code>*_superseded</code> and stops contributing to P&amp;L (it stays in the DB for audit).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 14 }}>
        <SourceCard title="Invoices" rows={data.invoices.by_source} />
        <SourceCard title="Project expenses" rows={data.project_expenses.by_source} />
        <SourceCard title="Bank transactions" rows={data.bank_transactions.by_source} />
      </div>

      <div
        style={{
          marginTop: 16,
          border: "1px solid var(--aq-border)",
          borderRadius: 10,
          padding: 14,
          background: "var(--aq-card)",
        }}
      >
        <h4 style={{ margin: 0 }}>Bank transactions overlap window</h4>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12, marginTop: 10 }}>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>csv_chase range</span>
            <div>{bt.csv_chase_range[0] || "—"} → {bt.csv_chase_range[1] || "—"}</div>
          </div>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>plaid_api range</span>
            <div>{bt.plaid_api_range[0] || "—"} → {bt.plaid_api_range[1] || "—"}</div>
          </div>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>Overlap</span>
            <div>
              <strong>{bt.overlap_window[0] || "—"} → {bt.overlap_window[1] || "—"}</strong>
            </div>
          </div>
        </div>
        <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 12 }}>
          {bt.csv_in_overlap ?? 0} csv_chase rows and {bt.plaid_in_overlap ?? 0} plaid_api rows fall inside the overlap.
          {dupCount > 0 ? (
            <>
              {" "}
              <strong style={{ color: "var(--aq-red)" }}>{dupCount} candidate duplicates</strong> identified
              (same posted date + amount).
            </>
          ) : (
            <> No duplicates detected.</>
          )}
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" onClick={() => dedupe(false)} disabled={busy || dupCount === 0}>
            Preview dedupe
          </button>
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Retag ${dupCount} csv_chase rows as 'csv_chase_superseded' so they stop counting in P&L? Plaid rows remain as the canonical source.`))
                return;
              void dedupe(true);
            }}
            disabled={busy || dupCount === 0}
            style={{ background: "var(--aq-red)", color: "#fff" }}
          >
            Apply dedupe
          </button>
        </div>

        {dedupeResult ? (
          <p style={{ fontSize: 12, marginTop: 8, color: dedupeResult.status === "applied" ? "var(--aq-green)" : "var(--aq-muted)" }}>
            {dedupeResult.status === "applied"
              ? `Applied: ${dedupeResult.retagged} csv_chase rows now tagged csv_chase_superseded.`
              : `Preview: ${dedupeResult.retagged} csv_chase rows would be retagged.`}
          </p>
        ) : null}

        {report ? (
          <FullReportSection
            report={report}
            activeOpex={activeOpex}
            showOpexList={showOpexList}
            onToggleOpex={() => {
              if (showOpexList) {
                setShowOpexList(false);
              } else if (activeOpex) {
                setShowOpexList(true);
              } else {
                void loadActiveOpex();
              }
            }}
          />
        ) : null}

        {bt.duplicate_candidates_sample.length > 0 ? (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>
              Sample duplicates ({bt.duplicate_candidates_sample.length} of {dupCount})
            </summary>
            <table style={{ width: "100%", fontSize: 11, marginTop: 8, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--aq-border)" }}>
                  <th style={{ textAlign: "left", padding: 4 }}>Date</th>
                  <th style={{ textAlign: "right", padding: 4 }}>Amount</th>
                  <th style={{ textAlign: "left", padding: 4 }}>CSV name</th>
                  <th style={{ textAlign: "left", padding: 4 }}>Plaid name</th>
                </tr>
              </thead>
              <tbody>
                {bt.duplicate_candidates_sample.map((d) => (
                  <tr key={d.csv_id} style={{ borderBottom: "1px solid var(--aq-border)" }}>
                    <td style={{ padding: 4 }}>{d.date}</td>
                    <td style={{ padding: 4, textAlign: "right" }}>{fmt$(d.amount)}</td>
                    <td style={{ padding: 4 }}>{d.csv_name}</td>
                    <td style={{ padding: 4 }}>{d.plaid_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function FullReportSection({
  report,
  activeOpex,
  showOpexList,
  onToggleOpex,
}: {
  report: FullReport;
  activeOpex: ActiveOpex | null;
  showOpexList: boolean;
  onToggleOpex: () => void;
}) {
  const buckets = report.outflow_buckets;
  const opexActive = buckets.opex_active?.total || 0;
  const totalOutflows = Object.values(buckets).reduce((s, b) => s + b.total, 0);
  const inflows = report.inflow_categorization;
  const totalInflows = Object.values(inflows).reduce((s, v) => s + v, 0);

  const inflowLabels: Record<string, string> = {
    boc_factoring: "BOC Capital factoring (financing)",
    owner_contrib_transfer: "Owner contributions (Online Transfer from 0273)",
    owner_contrib_zelle: "Owner contributions (Zelle from BertrandAlbert)",
    cc_payment_thank_you: "CC Payment Thank You (internal)",
    client_rtp: "Client RTP",
    client_wire: "Client wire (FedWire)",
    fundbox_draw: "FundBox draw",
    stripe: "Stripe / merchant",
    other: "Other inflow",
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--aq-border)" }}>
      <h4 style={{ margin: 0 }}>Comprehensive YTD reconciliation</h4>
      <p className="aq-lite-muted" style={{ fontSize: 11, marginTop: 4 }}>
        Period {report.period.start} → {report.period.end}. Every business outflow is classified into one of the
        buckets below; only "Active OPEX" feeds the P&L OPEX line.
      </p>

      <div style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>Outflow classification</strong>
        <table style={{ width: "100%", fontSize: 11, marginTop: 6, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--aq-border)" }}>
              <th style={{ textAlign: "left", padding: 4 }}>Bucket</th>
              <th style={{ textAlign: "right", padding: 4 }}>Count</th>
              <th style={{ textAlign: "right", padding: 4 }}>Total</th>
              <th style={{ textAlign: "left", padding: 4, paddingLeft: 12 }}>Sample</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(buckets).map(([key, b]) => {
              const isActive = key === "opex_active";
              const isPromoted = key === "personal_hw_to_opex";
              return (
                <tr
                  key={key}
                  style={{
                    borderBottom: "1px solid var(--aq-border)",
                    background: isActive ? "rgba(212, 73, 50, 0.06)" : isPromoted ? "rgba(34, 159, 122, 0.06)" : undefined,
                  }}
                >
                  <td style={{ padding: 4 }}>
                    {isActive ? "🔴 " : isPromoted ? "🟢 " : ""}
                    {b.label}
                  </td>
                  <td style={{ padding: 4, textAlign: "right" }}>{b.count.toLocaleString()}</td>
                  <td style={{ padding: 4, textAlign: "right", fontWeight: isActive ? 600 : 400 }}>{fmt$(b.total)}</td>
                  <td style={{ padding: 4, paddingLeft: 12, color: "var(--aq-muted)" }}>
                    {b.samples[0] ? `${b.samples[0].name.slice(0, 50)}…` : "—"}
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "2px solid var(--aq-border)" }}>
              <td style={{ padding: 4, fontWeight: 600 }}>All outflows YTD</td>
              <td></td>
              <td style={{ padding: 4, textAlign: "right", fontWeight: 600 }}>{fmt$(totalOutflows)}</td>
              <td style={{ padding: 4, paddingLeft: 12, color: "var(--aq-muted)" }}>
                Active OPEX = {((opexActive / totalOutflows) * 100).toFixed(1)}% of total
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={onToggleOpex} style={{ fontSize: 12 }}>
            {showOpexList ? "Hide Active OPEX detail" : `View all ${buckets.opex_active?.count || 0} Active OPEX items`}
          </button>
        </div>

        {showOpexList && activeOpex ? (
          <div style={{ marginTop: 10, maxHeight: 360, overflow: "auto", border: "1px solid var(--aq-border)", borderRadius: 6 }}>
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--aq-card)" }}>
                <tr style={{ borderBottom: "1px solid var(--aq-border)" }}>
                  <th style={{ textAlign: "left", padding: 4 }}>Date</th>
                  <th style={{ textAlign: "right", padding: 4 }}>Amount</th>
                  <th style={{ textAlign: "left", padding: 4 }}>Source</th>
                  <th style={{ textAlign: "left", padding: 4 }}>Name</th>
                </tr>
              </thead>
              <tbody>
                {activeOpex.items.map((item) => (
                  <tr key={item.id} style={{ borderBottom: "1px solid var(--aq-border)" }}>
                    <td style={{ padding: 4 }}>{item.date}</td>
                    <td style={{ padding: 4, textAlign: "right", fontWeight: 600 }}>{fmt$(item.amount)}</td>
                    <td style={{ padding: 4, fontSize: 10 }}>
                      <code>{item.source}</code>
                      {item.promoted_from_personal ? (
                        <span style={{ color: "var(--aq-green)", marginLeft: 4 }}>📦</span>
                      ) : null}
                    </td>
                    <td style={{ padding: 4 }}>{item.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 16 }}>
        <strong style={{ fontSize: 13 }}>Revenue ↔ inflow reconciliation</strong>
        <p className="aq-lite-muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 6 }}>
          Revenue (paid invoices, cash basis): <strong>{fmt$(report.revenue_cash_invoices)}</strong>. Bank inflows total{" "}
          <strong>{fmt$(totalInflows)}</strong>; the difference is mostly financing and owner contributions:
        </p>
        <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
          <tbody>
            {Object.entries(inflows)
              .filter(([, v]) => v !== 0)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <tr key={k} style={{ borderBottom: "1px solid var(--aq-border)" }}>
                  <td style={{ padding: 4 }}>{inflowLabels[k] || k}</td>
                  <td style={{ padding: 4, textAlign: "right" }}>{fmt$(v)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {report.user_notes.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <strong style={{ fontSize: 13 }}>Reconciliation notes (from your input)</strong>
          <ul style={{ fontSize: 11, marginTop: 4, paddingLeft: 18, color: "var(--aq-muted)" }}>
            {report.user_notes.map((n, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {n}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SourceCard({ title, rows }: { title: string; rows: SourceCount[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div
      style={{
        border: "1px solid var(--aq-border)",
        borderRadius: 10,
        padding: 12,
        background: "var(--aq-card)",
      }}
    >
      <h4 style={{ margin: 0, fontSize: 13 }}>{title}</h4>
      <p className="aq-lite-muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
        Total: {total.toLocaleString()}
      </p>
      <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source}>
              <td style={{ padding: "2px 0" }}>
                <code style={{ fontSize: 10 }}>{r.source}</code>
              </td>
              <td style={{ padding: "2px 0", textAlign: "right" }}>{r.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
