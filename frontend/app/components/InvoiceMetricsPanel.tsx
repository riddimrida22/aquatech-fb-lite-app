"use client";

import { useMemo } from "react";
import { Invoice, formatCurrency } from "./workspaceShared";

/** Receivables at a glance — how much is owed TO the business, by client.
 * balance_due is already the true net owed (a financed invoice's advance is booked
 * as a payment, so its balance is the un-advanced reserve). financed_pct is only
 * metadata: it drives the "advanced" note, never the outstanding math. */

const OPEN_EXCLUDE = new Set(["void", "voided", "cancelled", "canceled", "written_off", "draft", "paid"]);

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysOverdue(dueIso: string, today: string): number {
  return Math.round((new Date(`${today}T00:00:00`).getTime() - new Date(`${dueIso}T00:00:00`).getTime()) / 86_400_000);
}

type ClientRow = { client: string; owed: number; overdue: number; advanced: number; count: number };
type Agg = {
  owed: number; overdue: number; advanced: number; draft: number;
  openCount: number; financedCount: number;
  aging: { current: number; d30: number; d60: number; d90: number; over: number };
  clients: ClientRow[];
};

export function InvoiceMetricsPanel({ invoices }: { invoices: Invoice[] }) {
  const today = todayIso();
  const a = useMemo<Agg>(() => {
    const agg: Agg = {
      owed: 0, overdue: 0, advanced: 0, draft: 0, openCount: 0, financedCount: 0,
      aging: { current: 0, d30: 0, d60: 0, d90: 0, over: 0 }, clients: [],
    };
    const byClient = new Map<string, ClientRow>();
    for (const inv of invoices) {
      const status = (inv.status || "").toLowerCase();
      const bal = inv.balance_due || 0;
      if (status === "draft") { agg.draft += bal; continue; }
      if (OPEN_EXCLUDE.has(status) || bal <= 0.01) continue;
      const pct = Math.min(Math.max(inv.financed_pct || 0, 0), 1);
      const advanced = (inv.subtotal_amount || 0) * pct; // financier already advanced this
      agg.owed += bal;
      agg.advanced += advanced;
      agg.openCount += 1;
      if (pct > 0) agg.financedCount += 1;
      const dover = inv.due_date ? daysOverdue(inv.due_date, today) : 0;
      if (dover > 0) agg.overdue += bal;
      if (dover <= 0) agg.aging.current += bal;
      else if (dover <= 30) agg.aging.d30 += bal;
      else if (dover <= 60) agg.aging.d60 += bal;
      else if (dover <= 90) agg.aging.d90 += bal;
      else agg.aging.over += bal;
      const client = (inv.client_name || "Unassigned").trim() || "Unassigned";
      let row = byClient.get(client);
      if (!row) { row = { client, owed: 0, overdue: 0, advanced: 0, count: 0 }; byClient.set(client, row); }
      row.owed += bal; row.advanced += advanced; row.count += 1;
      if (dover > 0) row.overdue += bal;
    }
    agg.clients = Array.from(byClient.values()).sort((x, y) => y.owed - x.owed);
    return agg;
  }, [invoices, today]);

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Owed to you · A/R</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 32, color: "#1f8a5b", lineHeight: 1.05 }}>
            {formatCurrency(a.owed)}
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, margin: "3px 0 0" }}>
            {a.openCount} open invoice{a.openCount === 1 ? "" : "s"}
            {a.financedCount > 0 ? ` · ${formatCurrency(a.advanced)} already advanced by financier` : ""}
          </p>
          <p className="aq-lite-muted" style={{ fontSize: 10.5, margin: "2px 0 0", opacity: 0.7 }}>
            Open balances as of {new Date(`${today}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="aq-lite-muted" style={{ fontSize: 12 }}>Overdue</div>
          <strong style={{ fontSize: 20, color: a.overdue > 0 ? "#b42318" : "#1f8a5b" }}>{formatCurrency(a.overdue)}</strong>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="aq-lite-muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
          Owed by client
        </div>
        {a.clients.length === 0 ? (
          <p className="aq-lite-muted" style={{ fontSize: 13 }}>Nothing outstanding — all invoices are paid.</p>
        ) : a.clients.map((row) => (
          <div key={row.client} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: "1px solid rgba(128,128,128,0.14)" }}>
            <div>
              <strong style={{ fontSize: 14 }}>{row.client}</strong>
              <span className="aq-lite-muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
                {row.count} invoice{row.count === 1 ? "" : "s"}{row.advanced > 0 ? ` · ${formatCurrency(row.advanced)} financed` : ""}
              </span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#1f8a5b" }}>{formatCurrency(row.owed)}</div>
              {row.overdue > 0.01 ? <div style={{ fontSize: 11, color: "#b42318", fontWeight: 600 }}>{formatCurrency(row.overdue)} overdue</div> : null}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="aq-lite-muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Aging</div>
        <AgingBar aging={a.aging} total={a.owed} />
      </div>
    </section>
  );
}

function AgingBar({ aging, total }: { aging: Agg["aging"]; total: number }) {
  const segs = [
    { k: "Current", v: aging.current, c: "#1f8a5b" },
    { k: "1–30", v: aging.d30, c: "#c9a227" },
    { k: "31–60", v: aging.d60, c: "#e08a1e" },
    { k: "61–90", v: aging.d90, c: "#d1561b" },
    { k: "91+", v: aging.over, c: "#b42318" },
  ];
  const t = total > 0 ? total : 1;
  return (
    <div>
      <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "rgba(128,128,128,0.12)" }}>
        {segs.map((s) => s.v > 0 ? <div key={s.k} title={`${s.k}: ${formatCurrency(s.v)}`} style={{ width: `${(s.v / t) * 100}%`, background: s.c }} /> : null)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>
        {segs.map((s) => (
          <span key={s.k} style={{ fontSize: 11, opacity: s.v > 0 ? 0.85 : 0.4 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: s.c, marginRight: 4 }} />
            {s.k} {formatCurrency(s.v)}
          </span>
        ))}
      </div>
    </div>
  );
}
