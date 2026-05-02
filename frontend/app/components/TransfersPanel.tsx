"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency, formatNumber } from "./workspaceShared";
import { GroupedList } from "./GroupedList";

type RollforwardRow = {
  year: number;
  account: string;
  transaction_count: number;
  outflow: number;
  inflow: number;
  net: number;
};

type CategoryRow = {
  category: string;
  transaction_count: number;
  abs_amount: number;
  net_amount: number;
};

type TransferItem = {
  id: number;
  posted_date: string | null;
  account: string;
  amount: number;
  description: string;
  merchant: string | null;
  category: string | null;
  needs_review: boolean;
};

type TransfersPayload = {
  total_count: number;
  rollforward_by_year_account: RollforwardRow[];
  by_category: CategoryRow[];
  items: TransferItem[];
};

export function TransfersPanel() {
  const [data, setData] = useState<TransfersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const d = await apiGet<TransfersPayload>("/bank/transfers/pending");
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load transfers");
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
        <p className="aq-lite-eyebrow">Transfers</p>
        <p className="aq-lite-muted">Loading transfer rollforward…</p>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Transfers</p>
        <p style={{ color: "var(--aq-red)" }}>{error || "No data"}</p>
        <p className="aq-lite-muted" style={{ marginTop: 8 }}>
          Tip: import an Expense_CAT categorized.csv via the Imports tab to populate transfers.
        </p>
      </section>
    );
  }

  // Aggregate per year (across accounts)
  const yearAgg: Record<number, { count: number; out: number; in: number; net: number }> = {};
  for (const r of data.rollforward_by_year_account) {
    const y = yearAgg[r.year] ?? { count: 0, out: 0, in: 0, net: 0 };
    y.count += r.transaction_count;
    y.out += r.outflow;
    y.in += r.inflow;
    y.net += r.net;
    yearAgg[r.year] = y;
  }
  const years = Object.keys(yearAgg).map(Number).sort();
  let cumulative = 0;
  const yearRows = years.map((y) => {
    const r = yearAgg[y];
    cumulative += r.net;
    return { year: y, ...r, cumulative };
  });

  const filteredItems = filterCategory
    ? data.items.filter((it) => (it.category || "") === filterCategory)
    : data.items;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Transfers — pending CPA adjudication</p>
          <h3>{data.total_count.toLocaleString()} transactions awaiting classification</h3>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="aq-lite-muted" style={{ fontSize: 12 }}>Cumulative net</div>
          <strong style={{ fontSize: 18, color: cumulative !== 0 ? "var(--aq-red)" : undefined }}>
            {formatCurrency(cumulative)}
          </strong>
        </div>
      </div>

      <p className="aq-lite-muted" style={{ marginTop: 4, fontSize: 12 }}>
        These are inter-account / equity / loan / owner-draw / investment transactions. They need CPA decisions
        (loan vs distribution vs reimbursement vs contribution vs payroll vs personal) before tax filing. The numbers
        below are <strong>identification</strong>, not classification.
      </p>

      {/* Year rollforward */}
      <div style={{ marginTop: 16 }}>
        <p className="aq-lite-eyebrow">Rollforward by year</p>
        <table className="aq-lite-table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Year</th>
              <th style={{ textAlign: "right" }}>Txns</th>
              <th style={{ textAlign: "right" }}>Outflow (abs)</th>
              <th style={{ textAlign: "right" }}>Inflow</th>
              <th style={{ textAlign: "right" }}>Net</th>
              <th style={{ textAlign: "right" }}>Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {yearRows.map((r) => (
              <tr key={r.year}>
                <td><strong>{r.year}</strong></td>
                <td style={{ textAlign: "right" }}>{r.count.toLocaleString()}</td>
                <td style={{ textAlign: "right", color: "var(--aq-red)" }}>{formatCurrency(r.out)}</td>
                <td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(r.in)}</td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{formatCurrency(r.net)}</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(r.cumulative)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* By category */}
      <div style={{ marginTop: 18 }}>
        <p className="aq-lite-eyebrow">By category — click to filter list below</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          {data.by_category.map((c) => (
            <button
              key={c.category}
              type="button"
              className={filterCategory === c.category ? "active" : ""}
              onClick={() => setFilterCategory(filterCategory === c.category ? "" : c.category)}
              style={{ fontSize: 12, padding: "4px 10px" }}
            >
              {c.category} ({c.transaction_count}) · {formatCurrency(c.abs_amount)}
            </button>
          ))}
        </div>
      </div>

      {/* Items list — collapsible by group */}
      <div style={{ marginTop: 18 }}>
        <p className="aq-lite-eyebrow">
          {filterCategory
            ? `Showing ${filteredItems.length} ${filterCategory} transactions`
            : `Transfer transactions (${data.items.length} loaded of ${data.total_count})`}
        </p>
        <GroupedList
          rows={filteredItems}
          persistKey="costs.transfers.items"
          searchPredicate={(it, q) =>
            `${it.description || ""} ${it.merchant || ""} ${it.account}`.toLowerCase().includes(q)
          }
          searchPlaceholder="Search description / account"
          emptyHint="No matching transfers."
          groupOptions={[
            {
              key: "category",
              label: "Category",
              groupBy: (it) => it.category || "(no category)",
            },
            {
              key: "account",
              label: "Account",
              groupBy: (it) => it.account,
            },
            {
              key: "year",
              label: "Year",
              groupBy: (it) => (it.posted_date || "").slice(0, 4) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "month",
              label: "Month",
              groupBy: (it) => (it.posted_date || "").slice(0, 7) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "direction",
              label: "Direction",
              groupBy: (it) => (it.amount < 0 ? "OUT (outflow)" : "IN (inflow)"),
            },
          ]}
          renderGroupSummary={(items) => {
            const total = items.reduce((s, x) => s + Math.abs(x.amount || 0), 0);
            const net = items.reduce((s, x) => s + (x.amount || 0), 0);
            return `${formatCurrency(total)} abs · net ${formatCurrency(net)}`;
          }}
          renderRow={(it) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 130px 110px 70px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
                alignItems: "center",
              }}
            >
              <span style={{ color: "var(--aq-muted)" }}>{it.posted_date || "—"}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {it.description}
                <span style={{ color: "var(--aq-muted)", fontSize: 10 }}> · {it.account}</span>
              </span>
              <span style={{ fontSize: 10 }}>
                <span className="aq-lite-badge aq-lite-badge-warn">{it.category || "—"}</span>
              </span>
              <span style={{ textAlign: "right", fontWeight: 600 }}>{formatCurrency(it.amount)}</span>
              <span style={{ fontSize: 11, fontWeight: 600, textAlign: "right" }}>
                {it.amount < 0 ? (
                  <span style={{ color: "var(--aq-red)" }}>OUT</span>
                ) : (
                  <span style={{ color: "var(--aq-green)" }}>IN</span>
                )}
              </span>
            </div>
          )}
          initiallyOpen="first"
        />
      </div>
    </section>
  );
}
