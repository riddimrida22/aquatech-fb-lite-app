"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";
import { LoansPanel } from "./LoansPanel";

type PL = {
  period: { start: string; end: string };
  revenue_cash: number;
  revenue_accrual: number;
  cogs: number;
  payroll_breakdown: { gross: number; employer_taxes: number; employer_401k: number };
  opex: number;
  interest_expense: number;
  fees_expense: number;
  net_income_cash: number;
  net_income_accrual: number;
  notes: string[];
};

type Cashflow = {
  period: { start: string; end: string };
  operating: { cash_in_invoices: number; cash_out_opex_and_payroll: number; net: number };
  investing: { capex: number; net: number; note: string };
  financing: { loan_payments_total: number; net: number; note: string };
  net_change_in_cash: number;
};

type Balance = {
  as_of: string;
  assets: { cash: number; accounts_receivable: number; total: number };
  liabilities: { loans_outstanding: number; total: number };
  equity: number;
  notes: string[];
};

type Tab = "pl" | "cashflow" | "balance" | "loans";

export function AccountingWorkspace({ canManage }: { canManage: boolean }) {
  const [tab, setTab] = useState<Tab>("pl");
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [start, setStart] = useState(yearStart);
  const [end, setEnd] = useState(today);

  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div className="aq-lite-segmented">
            {[
              { key: "pl", label: "P&L" },
              { key: "cashflow", label: "Cash Flow" },
              { key: "balance", label: "Balance Sheet" },
              { key: "loans", label: "Loans / LOC" },
            ].map((t) => (
              <button key={t.key} type="button" className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key as Tab)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === "pl" || tab === "cashflow" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
              <button type="button" onClick={() => { setStart(yearStart); setEnd(today); }} style={{ padding: "4px 10px", fontSize: 12, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}>YTD</button>
              <button type="button" onClick={() => { setStart(`${new Date().getFullYear() - 1}-01-01`); setEnd(`${new Date().getFullYear() - 1}-12-31`); }} style={{ padding: "4px 10px", fontSize: 12, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}>Last year</button>
            </div>
          ) : null}
        </div>
      </section>

      {tab === "pl" ? <PLView start={start} end={end} /> : null}
      {tab === "cashflow" ? <CashflowView start={start} end={end} /> : null}
      {tab === "balance" ? <BalanceView /> : null}
      {tab === "loans" ? <LoansPanel canManage={canManage} /> : null}
    </div>
  );
}


function PLView({ start, end }: { start: string; end: string }) {
  const [pl, setPl] = useState<PL | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<PL>(`/accounting/pl?start=${start}&end=${end}`)
      .then((d) => { if (!cancelled) { setPl(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [start, end]);

  if (loading) return <section className="aq-lite-panel"><p className="aq-lite-muted">Computing P&amp;L…</p></section>;
  if (err || !pl) return <section className="aq-lite-panel"><p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p></section>;

  const grossProfit = pl.revenue_cash - pl.cogs;
  const grossMargin = pl.revenue_cash > 0 ? grossProfit / pl.revenue_cash : 0;
  const opexAndOther = pl.opex + pl.interest_expense + pl.fees_expense;
  const netMargin = pl.revenue_cash > 0 ? pl.net_income_cash / pl.revenue_cash : 0;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Profit &amp; Loss</p>
          <h3>{pl.period.start} → {pl.period.end} &nbsp;<span style={{ color: "var(--aq-muted)", fontSize: 14, fontWeight: 400 }}>(cash basis primary; accrual shown alongside)</span></h3>
        </div>
      </div>

      <table className="aq-lite-table">
        <tbody>
          <tr>
            <td><strong>Revenue (cash · paid invoices)</strong></td>
            <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(pl.revenue_cash)}</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>Accrual basis: {formatCurrency(pl.revenue_accrual)} (issued)</td>
          </tr>
          <tr>
            <td>− COGS (Gusto employer cost)</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.cogs)})</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>
              Gross {formatCurrency(pl.payroll_breakdown.gross)} · ER taxes {formatCurrency(pl.payroll_breakdown.employer_taxes)} · 401k {formatCurrency(pl.payroll_breakdown.employer_401k)}
            </td>
          </tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}>
            <td>= Gross Profit</td>
            <td style={{ textAlign: "right" }}>{formatCurrency(grossProfit)}</td>
            <td style={{ color: "var(--aq-muted)", fontWeight: 400, fontSize: 11 }}>Gross margin {(grossMargin * 100).toFixed(1)}%</td>
          </tr>
          <tr>
            <td>− Operating expenses (OPEX from bank/CC, excl. loan payments &amp; transfers)</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.opex)})</td>
            <td></td>
          </tr>
          <tr>
            <td>− Interest expense (from Loans tab)</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.interest_expense)})</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>Loan principal portions are excluded from expenses.</td>
          </tr>
          <tr>
            <td>− Bank/loan fees</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.fees_expense)})</td>
            <td></td>
          </tr>
          <tr style={{ background: "#e5f5ee", fontWeight: 800, color: "#235944" }}>
            <td>= Net Income (cash)</td>
            <td style={{ textAlign: "right" }}>{formatCurrency(pl.net_income_cash)}</td>
            <td style={{ color: "#235944", fontWeight: 600, fontSize: 11 }}>Net margin {(netMargin * 100).toFixed(1)}% · accrual {formatCurrency(pl.net_income_accrual)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 10, padding: 10, background: "#fafcfd", border: "1px solid var(--aq-border)", borderRadius: 8 }}>
        <p className="aq-lite-eyebrow" style={{ marginBottom: 6 }}>How this is computed</p>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--aq-muted)", lineHeight: 1.6 }}>
          {pl.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
    </section>
  );
}


function CashflowView({ start, end }: { start: string; end: string }) {
  const [cf, setCf] = useState<Cashflow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<Cashflow>(`/accounting/cashflow?start=${start}&end=${end}`)
      .then((d) => { if (!cancelled) { setCf(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [start, end]);

  if (loading) return <section className="aq-lite-panel"><p className="aq-lite-muted">Computing cash flow…</p></section>;
  if (err || !cf) return <section className="aq-lite-panel"><p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p></section>;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Cash Flow</p>
          <h3>{cf.period.start} → {cf.period.end}</h3>
        </div>
      </div>
      <table className="aq-lite-table">
        <tbody>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}>
            <td>Operating activities</td>
            <td></td><td></td>
          </tr>
          <tr><td>&nbsp;&nbsp;Cash in — invoices paid</td><td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(cf.operating.cash_in_invoices)}</td><td></td></tr>
          <tr><td>&nbsp;&nbsp;Cash out — OPEX + payroll cash</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.operating.cash_out_opex_and_payroll)})</td><td></td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Net operating cash flow</td><td style={{ textAlign: "right", color: cf.operating.net >= 0 ? "var(--aq-green)" : "var(--aq-red)" }}>{formatCurrency(cf.operating.net)}</td><td></td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><td>Investing activities</td><td></td><td></td></tr>
          <tr><td>&nbsp;&nbsp;Capex</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.investing.capex)})</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>{cf.investing.note}</td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><td>Financing activities</td><td></td><td></td></tr>
          <tr><td>&nbsp;&nbsp;Loan payments out</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.financing.loan_payments_total)})</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>{cf.financing.note}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Net financing cash flow</td><td style={{ textAlign: "right", color: cf.financing.net >= 0 ? "var(--aq-green)" : "var(--aq-red)" }}>{formatCurrency(cf.financing.net)}</td><td></td></tr>
          <tr style={{ background: "#e5f5ee", fontWeight: 800, color: "#235944" }}>
            <td>Net change in cash</td>
            <td style={{ textAlign: "right" }}>{formatCurrency(cf.net_change_in_cash)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}


function BalanceView() {
  const [b, setB] = useState<Balance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<Balance>("/accounting/balance-sheet")
      .then((d) => { if (!cancelled) { setB(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <section className="aq-lite-panel"><p className="aq-lite-muted">Computing balance sheet…</p></section>;
  if (err || !b) return <section className="aq-lite-panel"><p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p></section>;

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Balance sheet</p>
          <h3>As of {b.as_of}</h3>
        </div>
      </div>
      <div className="aq-lite-grid aq-lite-grid-3">
        <article className="aq-lite-kpi"><span>Total assets</span><strong>{formatCurrency(b.assets.total)}</strong></article>
        <article className="aq-lite-kpi"><span>Total liabilities</span><strong>{formatCurrency(b.liabilities.total)}</strong></article>
        <article className="aq-lite-kpi"><span>Equity (plug)</span><strong>{formatCurrency(b.equity)}</strong></article>
      </div>
      <table className="aq-lite-table" style={{ marginTop: 12 }}>
        <tbody>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><td colSpan={2}>Assets</td></tr>
          <tr><td>&nbsp;&nbsp;Cash</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.cash)}</td></tr>
          <tr><td>&nbsp;&nbsp;Accounts receivable</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.accounts_receivable)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Total assets</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.total)}</td></tr>
          <tr style={{ background: "#f1f5f9", fontWeight: 700 }}><td colSpan={2}>Liabilities</td></tr>
          <tr><td>&nbsp;&nbsp;Loans outstanding</td><td style={{ textAlign: "right" }}>{formatCurrency(b.liabilities.loans_outstanding)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Total liabilities</td><td style={{ textAlign: "right" }}>{formatCurrency(b.liabilities.total)}</td></tr>
          <tr style={{ background: "#e5f5ee", fontWeight: 800, color: "#235944" }}><td>Equity = Assets − Liabilities</td><td style={{ textAlign: "right" }}>{formatCurrency(b.equity)}</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, padding: 10, background: "#fafcfd", border: "1px solid var(--aq-border)", borderRadius: 8 }}>
        <p className="aq-lite-eyebrow" style={{ marginBottom: 6 }}>Caveats</p>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--aq-muted)", lineHeight: 1.6 }}>
          {b.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
    </section>
  );
}
