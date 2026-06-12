"use client";

import { useMemo } from "react";
import { Invoice, formatCurrency } from "./workspaceShared";

type Bucket = "current" | "30" | "60" | "90" | "over";

const BUCKET_LABELS: Record<Bucket, string> = {
  current: "Current",
  "30": "1-30",
  "60": "31-60",
  "90": "61-90",
  over: "91+",
};

function bucketForDaysOverdue(days: number): Bucket {
  if (days <= 0) return "current";
  if (days <= 30) return "30";
  if (days <= 60) return "60";
  if (days <= 90) return "90";
  return "over";
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00`);
  const b = new Date(`${bIso}T00:00:00`);
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type ClientAging = {
  client_name: string;
  current: number;
  "30": number;
  "60": number;
  "90": number;
  over: number;
  total: number;
};

export function ARAgingPanel({ invoices }: { invoices: Invoice[] }) {
  const today = todayIso();
  const rows = useMemo<ClientAging[]>(() => {
    const map = new Map<string, ClientAging>();
    for (const inv of invoices) {
      if (!inv.balance_due || inv.balance_due <= 0.01) continue;
      const status = (inv.status || "").toLowerCase();
      if (status === "void" || status === "voided" || status === "cancelled" || status === "canceled" || status === "written_off" || status === "draft") continue;
      const client = (inv.client_name || "Unassigned").trim() || "Unassigned";
      const days = inv.due_date ? daysBetween(today, inv.due_date) : 0;
      const bucket = bucketForDaysOverdue(days);
      let row = map.get(client);
      if (!row) {
        row = { client_name: client, current: 0, "30": 0, "60": 0, "90": 0, over: 0, total: 0 };
        map.set(client, row);
      }
      row[bucket] += inv.balance_due;
      row.total += inv.balance_due;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [invoices, today]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.current += row.current;
        acc["30"] += row["30"];
        acc["60"] += row["60"];
        acc["90"] += row["90"];
        acc.over += row.over;
        acc.total += row.total;
        return acc;
      },
      { current: 0, "30": 0, "60": 0, "90": 0, over: 0, total: 0 },
    );
  }, [rows]);

  const overdueTotal = totals["30"] + totals["60"] + totals["90"] + totals.over;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Receivables aging</p>
          <h3>{formatCurrency(totals.total)} outstanding</h3>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="aq-lite-muted" style={{ fontSize: 12 }}>Overdue</div>
          <strong style={{ color: overdueTotal > 0 ? "var(--aq-red)" : undefined, fontSize: 18 }}>
            {formatCurrency(overdueTotal)}
          </strong>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="aq-lite-muted" style={{ marginTop: 12 }}>
          No open invoice balances. Either everything is paid or invoices haven&apos;t been imported yet — head to the
          Imports tab to load FreshBooks history.
        </p>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="aq-aging-row is-header">
            <div>Client</div>
            <div className="aq-aging-cell">{BUCKET_LABELS.current}</div>
            <div className="aq-aging-cell">{BUCKET_LABELS["30"]}</div>
            <div className="aq-aging-cell">{BUCKET_LABELS["60"]}</div>
            <div className="aq-aging-cell">{BUCKET_LABELS["90"]}</div>
            <div className="aq-aging-cell">{BUCKET_LABELS.over}</div>
            <div className="aq-aging-cell">Total</div>
          </div>
          {rows.slice(0, 10).map((row) => (
            <div key={row.client_name} className="aq-aging-row">
              <div>
                <strong>{row.client_name}</strong>
              </div>
              <div className="aq-aging-cell">{row.current ? formatCurrency(row.current) : "—"}</div>
              <div className={"aq-aging-cell" + (row["30"] > 0 ? " is-overdue" : "")}>
                {row["30"] ? formatCurrency(row["30"]) : "—"}
              </div>
              <div className={"aq-aging-cell" + (row["60"] > 0 ? " is-overdue" : "")}>
                {row["60"] ? formatCurrency(row["60"]) : "—"}
              </div>
              <div className={"aq-aging-cell" + (row["90"] > 0 ? " is-overdue" : "")}>
                {row["90"] ? formatCurrency(row["90"]) : "—"}
              </div>
              <div className={"aq-aging-cell" + (row.over > 0 ? " is-overdue" : "")}>
                {row.over ? formatCurrency(row.over) : "—"}
              </div>
              <div className="aq-aging-cell">
                <strong>{formatCurrency(row.total)}</strong>
              </div>
            </div>
          ))}
          <div className="aq-aging-row is-total">
            <div>Total</div>
            <div className="aq-aging-cell">{formatCurrency(totals.current)}</div>
            <div className="aq-aging-cell">{formatCurrency(totals["30"])}</div>
            <div className="aq-aging-cell">{formatCurrency(totals["60"])}</div>
            <div className="aq-aging-cell">{formatCurrency(totals["90"])}</div>
            <div className="aq-aging-cell">{formatCurrency(totals.over)}</div>
            <div className="aq-aging-cell">{formatCurrency(totals.total)}</div>
          </div>
          {rows.length > 10 ? (
            <p className="aq-lite-muted" style={{ marginTop: 8, fontSize: 12 }}>
              Showing top 10 clients by total. {rows.length - 10} more in the Invoices tab.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
