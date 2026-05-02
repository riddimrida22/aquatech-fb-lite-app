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

const fmt$ = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function ReconciliationPanel() {
  const [data, setData] = useState<ReconcilePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dedupeResult, setDedupeResult] = useState<DedupeResult | null>(null);

  async function load() {
    setErr(null);
    try {
      const d = await apiGet<ReconcilePreview>("/admin/reconcile/preview");
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
        <button type="button" onClick={() => void load()} disabled={busy}>
          Refresh
        </button>
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 12 }}>
        Every operational row is now tagged with its source. CSV-imported rows from before the API era are
        labeled <code>csv_*</code>; rows pulled live from FreshBooks/Plaid get <code>*_api</code>. Use this
        panel to spot and clean up overlap.
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
          background: "#fff",
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

function SourceCard({ title, rows }: { title: string; rows: SourceCount[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div
      style={{
        border: "1px solid var(--aq-border)",
        borderRadius: 10,
        padding: 12,
        background: "#fff",
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
