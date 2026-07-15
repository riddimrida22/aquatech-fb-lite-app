"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";
import { LoansPanel } from "./LoansPanel";
import { DetailDrawer } from "./DetailDrawer";

type PL = {
  period: { start: string; end: string };
  revenue_cash: number;
  revenue_accrual: number;
  cogs: number;
  cogs_breakdown?: {
    gross_wages: number;
    employer_payroll_taxes: number;
    employer_401k_match: number;
    benefits_workers_comp: number;
    direct_project_costs: number;
    total_employer_cost: number;
  };
  cogs_direct_project_by_group?: { group: string; amount: number }[];
  payroll_breakdown: { gross: number; employer_taxes: number; employer_401k: number };
  gross_profit_cash?: number;
  gross_profit_accrual?: number;
  gross_margin_cash?: number;
  gross_margin_accrual?: number;
  opex: number;
  opex_breakdown?: { category: string; amount: number }[];
  opex_by_group?: { group: string; amount: number }[];
  opex_tx_detail?: { id: number; date: string; name: string; amount: number; category: string; group: string }[];
  revenue_detail?: { id: number; label: string; client: string; date: string; amount: number }[];
  interest_detail?: { id: number; label: string; date: string; amount: number }[];
  labor_split_by_employee?: { name: string; employer_cost: number; client_hours: number; overhead_hours: number; cogs_labor: number; nonbillable_labor: number }[];
  interest_expense: number;
  fees_expense: number;
  net_income_cash: number;
  net_income_accrual: number;
  net_margin_cash?: number;
  net_margin_accrual?: number;
  notes: string[];
};

type Cashflow = {
  period: { start: string; end: string };
  operating: { cash_in_invoices: number; cash_out_opex_and_payroll: number; net: number };
  investing: { capex: number; net: number; note: string };
  financing: {
    loan_proceeds_boc?: number;
    loan_proceeds_fundbox?: number;
    owner_contributions?: number;
    loan_payments_total: number;
    net: number;
    note: string;
  };
  inflow_breakdown?: Record<string, number>;
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


// Standalone Profit & Loss report with its own period controls — used by the
// Reports tab so the P&L is reachable there the way FreshBooks surfaces it.
export function PLReport() {
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [start, setStart] = useState(yearStart);
  const [end, setEnd] = useState(today);
  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Profit &amp; Loss statement</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            <button type="button" onClick={() => { setStart(yearStart); setEnd(today); }} style={{ padding: "4px 10px", fontSize: 12, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}>YTD</button>
            <button type="button" onClick={() => { setStart(`${new Date().getFullYear() - 1}-01-01`); setEnd(`${new Date().getFullYear() - 1}-12-31`); }} style={{ padding: "4px 10px", fontSize: 12, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}>Last year</button>
          </div>
        </div>
      </section>
      <PLView start={start} end={end} />
    </div>
  );
}


function PLView({ start, end }: { start: string; end: string }) {
  const [pl, setPl] = useState<PL | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<{ kind: "category" | "group" | "revenue" | "cogs" | "interest"; value: string } | null>(null);

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

  const grossProfit = pl.gross_profit_cash ?? (pl.revenue_cash - pl.cogs);
  const grossMargin = pl.gross_margin_cash ?? (pl.revenue_cash > 0 ? grossProfit / pl.revenue_cash : 0);
  const netMargin = pl.net_margin_cash ?? (pl.revenue_cash > 0 ? pl.net_income_cash / pl.revenue_cash : 0);
  const cb = pl.cogs_breakdown;

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
          <tr style={{ cursor: "pointer" }} onClick={() => setDrill({ kind: "revenue", value: "Revenue — paid invoices" })}
              title="Click to see the invoices behind this">
            <td><strong>Revenue (cash · paid invoices)</strong> <span style={{ color: "var(--aq-primary)", fontSize: 10, fontWeight: 500 }}>▸ drill</span></td>
            <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(pl.revenue_cash)}</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>Accrual basis: {formatCurrency(pl.revenue_accrual)} (issued)</td>
          </tr>
          <tr style={{ cursor: "pointer" }} onClick={() => setDrill({ kind: "cogs", value: "COGS — loaded labor by employee" })}
              title="Click to see the labor behind this">
            <td>− COGS (loaded labor + benefits + direct project) <span style={{ color: "var(--aq-primary)", fontSize: 10, fontWeight: 500 }}>▸ drill</span></td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.cogs)})</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>
              Labor: gross {formatCurrency(pl.payroll_breakdown.gross)} · ER taxes {formatCurrency(pl.payroll_breakdown.employer_taxes)} · 401k {formatCurrency(pl.payroll_breakdown.employer_401k)}
              {cb && cb.benefits_workers_comp > 0 ? <> · Benefits/WC {formatCurrency(cb.benefits_workers_comp)}</> : null}
              {cb && cb.direct_project_costs > 0 ? <> · Direct project {formatCurrency(cb.direct_project_costs)}</> : null}
            </td>
          </tr>
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}>
            <td>= Gross Profit</td>
            <td style={{ textAlign: "right" }}>{formatCurrency(grossProfit)}</td>
            <td style={{ color: "var(--aq-muted)", fontWeight: 400, fontSize: 11 }}>Gross margin {(grossMargin * 100).toFixed(1)}%</td>
          </tr>
          <tr style={{ fontWeight: 600 }}>
            <td>− Operating expenses (indirect)</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.opex)})</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>Grouped: Admin / Marketing / Business Development</td>
          </tr>
          {(pl.opex_by_group ?? []).map((row) => (
            <tr key={row.group} style={{ fontWeight: 600, cursor: "pointer" }}
                onClick={() => setDrill({ kind: "group", value: row.group })}
                title="Click to see the transactions behind this group">
              <td style={{ paddingLeft: 24 }}>{row.group} <span style={{ color: "var(--aq-primary)", fontSize: 10, fontWeight: 500 }}>▸ drill</span></td>
              <td style={{ textAlign: "right" }}>({formatCurrency(row.amount)})</td>
              <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>{pl.opex > 0 ? `${((row.amount / pl.opex) * 100).toFixed(1)}%` : ""}</td>
            </tr>
          ))}
          {(pl.opex_breakdown ?? []).map((row) => (
            <tr key={row.category} style={{ cursor: "pointer" }}
                onClick={() => setDrill({ kind: "category", value: row.category })}
                title="Click to see the transactions behind this category">
              <td style={{ paddingLeft: 44, color: "var(--aq-muted)", fontSize: 12 }}>{row.category}</td>
              <td style={{ textAlign: "right", color: "var(--aq-muted)", fontSize: 12 }}>({formatCurrency(row.amount)})</td>
              <td></td>
            </tr>
          ))}
          <tr style={{ cursor: "pointer" }} onClick={() => setDrill({ kind: "interest", value: "Interest expense — loan payments" })}
              title="Click to see the loan payments behind this">
            <td>− Interest expense (from Loans tab) <span style={{ color: "var(--aq-primary)", fontSize: 10, fontWeight: 500 }}>▸ drill</span></td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.interest_expense)})</td>
            <td style={{ color: "var(--aq-muted)", fontSize: 11 }}>Loan principal portions are excluded from expenses.</td>
          </tr>
          <tr>
            <td>− Bank/loan fees</td>
            <td style={{ textAlign: "right" }}>({formatCurrency(pl.fees_expense)})</td>
            <td></td>
          </tr>
          <tr style={{ background: "var(--aq-row-total-bg)", fontWeight: 800, color: "var(--aq-row-total-fg)" }}>
            <td>= Net Income (cash)</td>
            <td style={{ textAlign: "right" }}>{formatCurrency(pl.net_income_cash)}</td>
            <td style={{ color: "var(--aq-row-total-fg)", fontWeight: 600, fontSize: 11 }}>Net margin {(netMargin * 100).toFixed(1)}% · accrual {formatCurrency(pl.net_income_accrual)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ marginTop: 10, padding: 10, background: "var(--aq-subtle)", border: "1px solid var(--aq-border)", borderRadius: 8 }}>
        <p className="aq-lite-eyebrow" style={{ marginBottom: 6 }}>How this is computed</p>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--aq-muted)", lineHeight: 1.6 }}>
          {pl.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>

      {drill ? (() => {
        type Row = { key: string; date: string; label: string; sublabel?: string; amount: number };
        let rows: Row[] = [];
        let noun = "item";
        if (drill.kind === "category" || drill.kind === "group") {
          noun = "transaction";
          rows = (pl.opex_tx_detail ?? [])
            .filter((t) => (drill.kind === "category" ? t.category === drill.value : t.group === drill.value))
            .map((t) => ({ key: `o${t.id}`, date: t.date, label: t.name, sublabel: drill.kind === "group" ? t.category : undefined, amount: t.amount }));
        } else if (drill.kind === "revenue") {
          noun = "invoice";
          rows = (pl.revenue_detail ?? []).map((r) => ({ key: `r${r.id}`, date: r.date, label: r.label, sublabel: r.client, amount: r.amount }));
        } else if (drill.kind === "cogs") {
          noun = "line";
          // Billable labor per employee (cogs_labor) + benefits/WC + direct project = COGS.
          rows = (pl.labor_split_by_employee ?? [])
            .filter((r) => r.cogs_labor !== 0)
            .map((r) => ({ key: `c${r.name}`, date: "", label: r.name, sublabel: `${r.client_hours}h billable`, amount: r.cogs_labor }));
          const cb = pl.cogs_breakdown;
          if (cb && cb.benefits_workers_comp) rows.push({ key: "c-ben", date: "", label: "Benefits & workers' comp", amount: cb.benefits_workers_comp });
          if (cb && cb.direct_project_costs) rows.push({ key: "c-dpc", date: "", label: "Direct project costs (subs/materials)", amount: cb.direct_project_costs });
        } else if (drill.kind === "interest") {
          noun = "payment";
          rows = (pl.interest_detail ?? []).map((r) => ({ key: `i${r.id}`, date: r.date, label: r.label, amount: r.amount }));
        }
        const total = rows.reduce((s, r) => s + r.amount, 0);
        return (
          <DetailDrawer
            open
            onClose={() => setDrill(null)}
            title={drill.value}
            subtitle={`${rows.length} ${noun}${rows.length === 1 ? "" : "s"} · ${formatCurrency(total)} · ${pl.period.start} → ${pl.period.end}`}
          >
            <table className="aq-lite-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{drill.kind === "cogs" ? "" : "Date"}</th>
                  <th style={{ textAlign: "left" }}>{drill.kind === "revenue" ? "Invoice" : drill.kind === "cogs" ? "Employee" : "Description"}</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td style={{ whiteSpace: "nowrap", color: "var(--aq-muted)", fontSize: 12 }}>{r.date}</td>
                    <td style={{ fontSize: 12 }}>
                      {r.label}
                      {r.sublabel ? <span style={{ color: "var(--aq-muted)" }}> · {r.sublabel}</span> : null}
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(r.amount)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={3} className="aq-lite-muted">No detail for this line.</td></tr>
                ) : null}
              </tbody>
            </table>
          </DetailDrawer>
        );
      })() : null}
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
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}>
            <td>Operating activities</td>
            <td></td><td></td>
          </tr>
          <tr><td>&nbsp;&nbsp;Cash in — invoices paid</td><td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(cf.operating.cash_in_invoices)}</td><td></td></tr>
          <tr><td>&nbsp;&nbsp;Cash out — OPEX + payroll cash</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.operating.cash_out_opex_and_payroll)})</td><td></td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Net operating cash flow</td><td style={{ textAlign: "right", color: cf.operating.net >= 0 ? "var(--aq-green)" : "var(--aq-red)" }}>{formatCurrency(cf.operating.net)}</td><td></td></tr>
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}><td>Investing activities</td><td></td><td></td></tr>
          <tr><td>&nbsp;&nbsp;Capex</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.investing.capex)})</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>{cf.investing.note}</td></tr>
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}><td>Financing activities</td><td></td><td></td></tr>
          {cf.financing.loan_proceeds_boc !== undefined && cf.financing.loan_proceeds_boc > 0 ? (
            <tr><td>&nbsp;&nbsp;Cash in — BOC factoring proceeds</td><td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(cf.financing.loan_proceeds_boc)}</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>Working capital advances on factored invoices</td></tr>
          ) : null}
          {cf.financing.loan_proceeds_fundbox !== undefined && cf.financing.loan_proceeds_fundbox > 0 ? (
            <tr><td>&nbsp;&nbsp;Cash in — FundBox draws</td><td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(cf.financing.loan_proceeds_fundbox)}</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>LOC draws</td></tr>
          ) : null}
          {cf.financing.owner_contributions !== undefined && cf.financing.owner_contributions > 0 ? (
            <tr><td>&nbsp;&nbsp;Cash in — Owner contributions</td><td style={{ textAlign: "right", color: "var(--aq-green)" }}>{formatCurrency(cf.financing.owner_contributions)}</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>Online transfers from 0273 + Zelle from BertrandAlbert</td></tr>
          ) : null}
          <tr><td>&nbsp;&nbsp;Cash out — Loan payments</td><td style={{ textAlign: "right" }}>({formatCurrency(cf.financing.loan_payments_total)})</td><td style={{ fontSize: 11, color: "var(--aq-muted)" }}>Principal + interest + fees</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Net financing cash flow</td><td style={{ textAlign: "right", color: cf.financing.net >= 0 ? "var(--aq-green)" : "var(--aq-red)" }}>{formatCurrency(cf.financing.net)}</td><td></td></tr>
          <tr style={{ background: "var(--aq-row-total-bg)", fontWeight: 800, color: "var(--aq-row-total-fg)" }}>
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
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}><td colSpan={2}>Assets</td></tr>
          <tr><td>&nbsp;&nbsp;Cash</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.cash)}</td></tr>
          <tr><td>&nbsp;&nbsp;Accounts receivable</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.accounts_receivable)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Total assets</td><td style={{ textAlign: "right" }}>{formatCurrency(b.assets.total)}</td></tr>
          <tr style={{ background: "var(--aq-row-head)", fontWeight: 700 }}><td colSpan={2}>Liabilities</td></tr>
          <tr><td>&nbsp;&nbsp;Loans outstanding</td><td style={{ textAlign: "right" }}>{formatCurrency(b.liabilities.loans_outstanding)}</td></tr>
          <tr style={{ fontWeight: 700 }}><td>&nbsp;&nbsp;Total liabilities</td><td style={{ textAlign: "right" }}>{formatCurrency(b.liabilities.total)}</td></tr>
          <tr style={{ background: "var(--aq-row-total-bg)", fontWeight: 800, color: "var(--aq-row-total-fg)" }}><td>Equity = Assets − Liabilities</td><td style={{ textAlign: "right" }}>{formatCurrency(b.equity)}</td></tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, padding: 10, background: "var(--aq-subtle)", border: "1px solid var(--aq-border)", borderRadius: 8 }}>
        <p className="aq-lite-eyebrow" style={{ marginBottom: 6 }}>Caveats</p>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--aq-muted)", lineHeight: 1.6 }}>
          {b.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
    </section>
  );
}
