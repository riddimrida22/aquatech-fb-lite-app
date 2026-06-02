"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type BookkeepingAction = {
  id: number;
  action_key: string;
  action_date: string;
  category: string;
  title: string;
  description: string;
  dollar_impact: number;
  status: string;
  artifact_refs: string;
  created_at: string;
};

type ActionsResponse = {
  actions: BookkeepingAction[];
  summary: {
    total: number;
    completed: number;
    pending: number;
    total_impact: number;
    categories: Record<string, { count: number; impact: number }>;
  };
  overrides_count: number;
};

type Override = {
  id: number;
  bank_transaction_id: number | null;
  override_classification: string;
  override_notes: string | null;
  loan_id: number | null;
  action_key: string | null;
  created_at: string;
  posted_date: string | null;
  amount: number | null;
  name: string | null;
};

export function BookkeepingWorkspace() {
  const [data, setData] = useState<ActionsResponse | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"actions" | "overrides">("actions");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      apiGet<ActionsResponse>("/bookkeeping/actions"),
      apiGet<Override[]>("/bookkeeping/overrides"),
    ])
      .then(([acts, ovs]) => {
        if (!active) return;
        setData(acts);
        setOverrides(ovs);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const categories = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.summary.categories).sort((a, b) => b[1].count - a[1].count);
  }, [data]);

  return (
    <section className="aq-lite-stack">
      <div className="aq-lite-hero">
        <h2 style={{ margin: 0 }}>Bookkeeping — Tax Remediation Log</h2>
        <p style={{ margin: "4px 0 0", color: "#6b7083", fontSize: 13 }}>
          Audit trail of CPA-remediation actions taken for the 2025 1120-S filing. Includes loan
          documentation, transaction reclassifications, M-1 adjustments, and CPA action flags.
        </p>
      </div>

      {loading ? <div className="aq-lite-panel">Loading bookkeeping log…</div> : null}
      {error ? (
        <div className="aq-lite-panel" style={{ color: "#b91c1c" }}>
          Error loading: {error}. Make sure the backend endpoint /bookkeeping/actions is deployed.
        </div>
      ) : null}

      {data ? (
        <>
          {/* Summary tiles */}
          <div className="aq-lite-grid aq-lite-grid-4">
            <div className="aq-lite-panel">
              <div style={{ fontSize: 11, color: "#6b7083", textTransform: "uppercase" }}>
                Total actions
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#21295c" }}>
                {data.summary.total}
              </div>
            </div>
            <div className="aq-lite-panel">
              <div style={{ fontSize: 11, color: "#6b7083", textTransform: "uppercase" }}>
                Completed
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#065a82" }}>
                {data.summary.completed}
              </div>
            </div>
            <div className="aq-lite-panel">
              <div style={{ fontSize: 11, color: "#6b7083", textTransform: "uppercase" }}>
                Pending CPA
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#e29f2a" }}>
                {data.summary.pending}
              </div>
            </div>
            <div className="aq-lite-panel">
              <div style={{ fontSize: 11, color: "#6b7083", textTransform: "uppercase" }}>
                Transaction overrides
              </div>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#1c7293" }}>
                {data.overrides_count}
              </div>
            </div>
          </div>

          {/* Category breakdown */}
          <section className="aq-lite-panel">
            <div className="aq-lite-panel-head">
              <h3 style={{ margin: 0 }}>By category</h3>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                  <th style={{ padding: "8px 4px" }}>Category</th>
                  <th style={{ padding: "8px 4px", textAlign: "right" }}>Actions</th>
                  <th style={{ padding: "8px 4px", textAlign: "right" }}>Dollar impact</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(([cat, info]) => (
                  <tr key={cat} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "8px 4px", fontWeight: 500 }}>{cat}</td>
                    <td style={{ padding: "8px 4px", textAlign: "right" }}>{info.count}</td>
                    <td style={{ padding: "8px 4px", textAlign: "right" }}>
                      {formatCurrency(info.impact)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Tabs */}
          <nav style={{ display: "flex", gap: 8, borderBottom: "2px solid #e2e8f0" }}>
            <button
              type="button"
              onClick={() => setTab("actions")}
              style={{
                padding: "8px 16px",
                background: "transparent",
                border: "none",
                borderBottom: tab === "actions" ? "3px solid #065a82" : "3px solid transparent",
                fontWeight: tab === "actions" ? 700 : 400,
                color: tab === "actions" ? "#065a82" : "#6b7083",
                cursor: "pointer",
              }}
            >
              Action Log ({data.actions.length})
            </button>
            <button
              type="button"
              onClick={() => setTab("overrides")}
              style={{
                padding: "8px 16px",
                background: "transparent",
                border: "none",
                borderBottom: tab === "overrides" ? "3px solid #065a82" : "3px solid transparent",
                fontWeight: tab === "overrides" ? 700 : 400,
                color: tab === "overrides" ? "#065a82" : "#6b7083",
                cursor: "pointer",
              }}
            >
              Transaction Overrides ({overrides.length})
            </button>
          </nav>

          {tab === "actions" ? (
            <section className="aq-lite-panel">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "8px 4px", width: "10%" }}>Date</th>
                    <th style={{ padding: "8px 4px", width: "14%" }}>Category</th>
                    <th style={{ padding: "8px 4px", width: "44%" }}>Action</th>
                    <th style={{ padding: "8px 4px", width: "10%", textAlign: "right" }}>
                      $ impact
                    </th>
                    <th style={{ padding: "8px 4px", width: "10%" }}>Status</th>
                    <th style={{ padding: "8px 4px", width: "12%" }}>References</th>
                  </tr>
                </thead>
                <tbody>
                  {data.actions.map((a) => (
                    <tr key={a.id} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                      <td style={{ padding: "8px 4px" }}>{a.action_date}</td>
                      <td style={{ padding: "8px 4px", color: "#1c7293" }}>{a.category}</td>
                      <td style={{ padding: "8px 4px" }}>
                        <div style={{ fontWeight: 600 }}>{a.title}</div>
                        <div style={{ color: "#6b7083", marginTop: 4 }}>{a.description}</div>
                      </td>
                      <td style={{ padding: "8px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatCurrency(a.dollar_impact)}
                      </td>
                      <td style={{ padding: "8px 4px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 4,
                            background: a.status === "completed" ? "#dcfce7" : "#fef3c7",
                            color: a.status === "completed" ? "#15803d" : "#a16207",
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {a.status}
                        </span>
                      </td>
                      <td style={{ padding: "8px 4px", color: "#6b7083", fontSize: 11 }}>
                        {a.artifact_refs || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {tab === "overrides" ? (
            <section className="aq-lite-panel">
              <p style={{ fontSize: 12, color: "#6b7083", marginTop: 0 }}>
                Tax-classification overrides applied to specific bank transactions during the
                2026-05-11 CPA remediation. These supplement the live P&L categorization to
                reflect the correct tax treatment on Form 1120-S.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "8px 4px", width: "10%" }}>Date</th>
                    <th style={{ padding: "8px 4px", width: "9%", textAlign: "right" }}>$</th>
                    <th style={{ padding: "8px 4px", width: "30%" }}>Transaction</th>
                    <th style={{ padding: "8px 4px", width: "18%" }}>Override classification</th>
                    <th style={{ padding: "8px 4px", width: "8%" }}>Loan #</th>
                    <th style={{ padding: "8px 4px", width: "25%" }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr key={o.id} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                      <td style={{ padding: "8px 4px" }}>{o.posted_date ?? "—"}</td>
                      <td style={{ padding: "8px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {o.amount !== null ? formatCurrency(o.amount) : "—"}
                      </td>
                      <td style={{ padding: "8px 4px", color: "#374151" }}>
                        {o.name?.slice(0, 80) ?? `bt#${o.bank_transaction_id ?? "?"}`}
                      </td>
                      <td style={{ padding: "8px 4px", color: "#065a82", fontWeight: 600 }}>
                        {o.override_classification}
                      </td>
                      <td style={{ padding: "8px 4px" }}>{o.loan_id ?? "—"}</td>
                      <td style={{ padding: "8px 4px", color: "#6b7083", fontSize: 11 }}>
                        {o.override_notes?.slice(0, 120) ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
