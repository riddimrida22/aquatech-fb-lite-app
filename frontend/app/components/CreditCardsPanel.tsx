"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";
import { SourceLink } from "./SourceDrawer";

type Card = {
  name: string;
  institution: string;
  mask: string;
  account_ids: string[];
  balance: number;
  credit_limit: number | null;
  available: number | null;
  utilization_pct: number | null;
  feed: string;
  balance_as_of: string | null;
  charges: number;
  payments: number;
  refunds: number;
  interest: number;
  fees: number;
  transactions: number;
  monthly_charges: { month: string; amount: number }[];
};

type CardsResponse = {
  period: { start: string; end: string };
  cards: Card[];
  totals: { balance: number; charges: number; payments: number; refunds: number; interest: number; fees: number };
};

const GOLD = "#b8860b";
const GREEN = "#1f8a5b";
const RED = "#b42318";
const money = (n: number | null | undefined) => formatCurrency(n ?? 0);

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function yearStartISO(): string {
  return `${new Date().getFullYear()}-01-01`;
}
function utilColor(u: number | null): string {
  if (u == null) return "inherit";
  if (u < 30) return GREEN;
  if (u < 70) return GOLD;
  return RED;
}

/** Financial → Credit Cards: what each business card owes now and where the money went. */
export function CreditCardsPanel() {
  const [data, setData] = useState<CardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [start, setStart] = useState<string>(yearStartISO());
  const [end, setEnd] = useState<string>(todayISO());

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet<CardsResponse>(`/accounting/credit-cards?${new URLSearchParams({ start, end }).toString()}`)
      .then((r) => { setData(r); setLoading(false); })
      .catch((e) => { setErr(e?.message || "Could not load credit cards"); setLoading(false); });
  }, [start, end]);
  useEffect(() => { load(); }, [load]);

  const ps = data?.period.start ?? start;
  const pe = data?.period.end ?? end;
  const span = `${ps} -> ${pe}`;
  const tx = (c: Card, bucket?: string) => ({
    // scope "all": every row on the card, incl. personal charges put on a business card
    kind: "bank_transactions" as const, start: ps, end: pe, account_id: c.account_ids.join(","), scope: "all", ...(bucket ? { bucket } : {}),
  });
  const cell = (c: Card, v: number, bucket: string, label: string, color?: string) => (
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color }}>
      {v ? <SourceLink title={`${c.name} ...${c.mask} · ${label} · ${span}`} query={tx(c, bucket)}>{money(v)}</SourceLink> : <span className="aq-lite-muted">—</span>}
    </td>
  );
  const t = data?.totals;

  return (
    <section className="aq-lite-panel" style={{ borderLeft: `3px solid ${GOLD}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0, color: GOLD }}>Financial · Liabilities</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Credit cards</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 640 }}>
            Balance owed today (same figure as the balance sheet) and, for the period, what was charged, paid off,
            refunded, and lost to interest and fees. Click any figure to see the transactions behind it.
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

      {t && data && !loading ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, margin: "14px 0" }}>
            <Tile label="Owed now" value={money(t.balance)} color={t.balance > 0 ? RED : GREEN} sub={`${data.cards.length} business card${data.cards.length === 1 ? "" : "s"}`} />
            <Tile label="Charged" value={money(t.charges)} sub={`net of ${money(t.refunds)} refunds: ${money(t.charges - t.refunds)}`} />
            <Tile label="Paid off" value={money(t.payments)} color={GREEN} sub="payments to the cards" />
            <Tile label="Interest + fees" value={money(t.interest + t.fees)} color={t.interest + t.fees > 0 ? GOLD : GREEN}
              sub={`${money(t.interest)} interest · ${money(t.fees)} fees`} />
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Card</th>
                  <th style={{ textAlign: "right" }}>Owed now</th>
                  <th style={{ textAlign: "right" }}>Limit used</th>
                  <th style={{ textAlign: "right" }}>Charged</th>
                  <th style={{ textAlign: "right" }}>Paid off</th>
                  <th style={{ textAlign: "right" }}>Refunds</th>
                  <th style={{ textAlign: "right" }}>Interest</th>
                  <th style={{ textAlign: "right" }}>Fees</th>
                </tr>
              </thead>
              <tbody>
                {data.cards.map((c) => (
                  <tr key={c.mask}>
                    <td>
                      <SourceLink title={`${c.name} ...${c.mask} · all transactions · ${span}`} query={tx(c)}>
                        {c.name} <span className="aq-lite-muted">…{c.mask}</span>
                      </SourceLink>
                      <div className="aq-lite-muted" style={{ fontSize: 11.5 }}>
                        {c.feed}{c.balance_as_of ? ` · balance as of ${c.balance_as_of}` : ""}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: c.balance > 0 ? RED : undefined }}>{money(c.balance)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: utilColor(c.utilization_pct) }}>
                      {c.utilization_pct == null ? <span className="aq-lite-muted">—</span> : (
                        <span title={`${money(c.balance)} of ${money(c.credit_limit)} limit`}>{c.utilization_pct.toFixed(0)}%</span>
                      )}
                    </td>
                    {cell(c, c.charges, "charges", "charges")}
                    {cell(c, c.payments, "payments", "payments", GREEN)}
                    {cell(c, c.refunds, "refunds", "refunds / credits")}
                    {cell(c, c.interest, "interest", "interest", GOLD)}
                    {cell(c, c.fees, "fees", "fees", GOLD)}
                  </tr>
                ))}
                {data.cards.length === 0 ? (
                  <tr><td colSpan={8} className="aq-lite-muted">No business credit cards connected.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 10 }}>
            Card charges are business expenses in the P&amp;L when they post; payments to a card are money movement, not
            an expense. Statement-import cards (Amex) are only as current as the last statement imported.
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
