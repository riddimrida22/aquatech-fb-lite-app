"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";
import { GroupedList } from "./GroupedList";

type MatchedRow = {
  fb_id: number;
  chase_id: number;
  fb_date: string;
  chase_date: string | null;
  amount_abs: number;
  fb_description: string;
  chase_description: string;
  date_delta_days: number;
};

type UnmatchedRow = {
  fb_id: number;
  posted_date: string;
  amount: number;
  amount_abs: number;
  description: string;
  merchant: string | null;
  category: string | null;
};

type DedupPayload = {
  fb_count: number;
  chase_count: number;
  matched_count: number;
  matched_total: number;
  unmatched_count: number;
  unmatched_total: number;
  tolerance_days: number;
  matched_sample: MatchedRow[];
  unmatched: UnmatchedRow[];
};

export function DedupPanel() {
  const [data, setData] = useState<DedupPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showMatched, setShowMatched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const d = await apiGet<DedupPayload>("/bank/dedup/analysis?date_tolerance_days=3");
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Bank vs FreshBooks reconciliation</p>
        <p className="aq-lite-muted">Analyzing duplicates…</p>
      </section>
    );
  }
  if (err || !data) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Bank vs FreshBooks reconciliation</p>
        <p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p>
      </section>
    );
  }

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Bank vs FreshBooks reconciliation</p>
          <h3>{formatCurrency(data.matched_total)} double-counted · {formatCurrency(data.unmatched_total)} unmatched FB entries</h3>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="aq-lite-muted" style={{ fontSize: 12 }}>FB rows / Chase rows</div>
          <strong>{data.fb_count.toLocaleString()} / {data.chase_count.toLocaleString()}</strong>
        </div>
      </div>

      <p className="aq-lite-muted" style={{ marginTop: 4, fontSize: 12 }}>
        Each FB-Expenses row that has a Chase-bank counterpart at the same date (±{data.tolerance_days}d) and same absolute
        amount is the same expense recorded twice — Chase is source of truth. FB rows without a Chase match are likely
        <strong> personal-paid-business expenses</strong> (paid out of personal account) or FB-only adjustments. Both need review.
      </p>

      {/* Big stat cards */}
      <div className="aq-lite-grid aq-lite-grid-3" style={{ marginTop: 14 }}>
        <div className="aq-lite-panel" style={{ padding: 12, background: "#fbe3dc", border: "1px solid #e8a896" }}>
          <p className="aq-lite-eyebrow" style={{ color: "#8b2e1d" }}>Duplicates to remove</p>
          <h3 style={{ color: "#8b2e1d" }}>{data.matched_count.toLocaleString()}</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, color: "#8b2e1d" }}>{formatCurrency(data.matched_total)}</p>
        </div>
        <div className="aq-lite-panel" style={{ padding: 12, background: "#fff3e7", border: "1px solid #f0d2ab" }}>
          <p className="aq-lite-eyebrow" style={{ color: "#8b5a1d" }}>Unmatched FB · personal-paid?</p>
          <h3 style={{ color: "#8b5a1d" }}>{data.unmatched_count.toLocaleString()}</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, color: "#8b5a1d" }}>{formatCurrency(data.unmatched_total)}</p>
        </div>
        <div className="aq-lite-panel" style={{ padding: 12, background: "#e5f5ee", border: "1px solid #b8decf" }}>
          <p className="aq-lite-eyebrow" style={{ color: "#235944" }}>Chase rows (source of truth)</p>
          <h3 style={{ color: "#235944" }}>{data.chase_count.toLocaleString()}</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, color: "#235944" }}>Bank cash flow</p>
        </div>
      </div>

      {/* Unmatched FB rows — grouped + collapsible to avoid long flat list */}
      <div style={{ marginTop: 18 }}>
        <p className="aq-lite-eyebrow">
          Unmatched FB-Expenses entries ({data.unmatched.length}) — review and reimburse / classify
        </p>
        <GroupedList
          rows={data.unmatched}
          persistKey="costs.dedup.unmatched"
          searchPredicate={(r, q) =>
            `${r.merchant || ""} ${r.description || ""} ${r.category || ""}`.toLowerCase().includes(q)
          }
          searchPlaceholder="Search merchant / description / category"
          groupOptions={[
            { key: "category", label: "Category", groupBy: (r) => r.category || "(uncategorized)" },
            { key: "merchant", label: "Merchant", groupBy: (r) => r.merchant || "(no merchant)" },
            {
              key: "year",
              label: "Year",
              groupBy: (r) => (r.posted_date || "").slice(0, 4) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "month",
              label: "Month",
              groupBy: (r) => (r.posted_date || "").slice(0, 7) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
          ]}
          renderGroupSummary={(items) => {
            const total = items.reduce((s, r) => s + (r.amount_abs || 0), 0);
            return formatCurrency(total);
          }}
          renderRow={(r) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 160px 110px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
              }}
            >
              <span style={{ color: "var(--aq-muted)" }}>{r.posted_date}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <strong>{r.merchant || "—"}</strong>
                {r.description ? (
                  <span style={{ color: "var(--aq-muted)" }}> · {r.description}</span>
                ) : null}
              </span>
              <span style={{ fontSize: 10 }}>
                <span className="aq-lite-badge aq-lite-badge-warn">{r.category || "—"}</span>
              </span>
              <span style={{ textAlign: "right", fontWeight: 600 }}>{formatCurrency(r.amount_abs)}</span>
            </div>
          )}
          initiallyOpen="first"
        />
        {data.unmatched_count > data.unmatched.length ? (
          <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 6 }}>
            Showing {data.unmatched.length} of {data.unmatched_count} unmatched FB entries; total unmatched {formatCurrency(data.unmatched_total)}.
          </p>
        ) : null}
      </div>

      {/* Toggle to show matched */}
      <div style={{ marginTop: 16 }}>
        <button type="button" onClick={() => setShowMatched((s) => !s)}>
          {showMatched ? "Hide" : "Show"} matched duplicate examples ({data.matched_count.toLocaleString()})
        </button>
        {showMatched ? (
          <div style={{ marginTop: 10 }}>
            <table className="aq-lite-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th>FB description</th>
                  <th>Chase description</th>
                  <th>Δ days</th>
                </tr>
              </thead>
              <tbody>
                {data.matched_sample.map((r, i) => (
                  <tr key={`${r.fb_id}-${r.chase_id}-${i}`}>
                    <td>{r.fb_date}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(r.amount_abs)}</td>
                    <td style={{ fontSize: 11, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.fb_description}
                    </td>
                    <td style={{ fontSize: 11, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.chase_description}
                    </td>
                    <td style={{ textAlign: "center" }}>{r.date_delta_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Showing 50 sample matches. Total matched: {data.matched_count.toLocaleString()} pairs / {formatCurrency(data.matched_total)}.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
