"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency, formatNumber } from "./workspaceShared";

type Totals = {
  gross: number;
  employer_taxes: number;
  employer_401k: number;
  employer_cost: number;
  net_pay: number;
  hours: number;
};

type Summary = {
  by_year: Record<string, { totals: Totals; period_count: number; employee_count: number }>;
  yearly_ytd: Record<string, Totals>;
  grand_total: Totals;
  treatment_note: string;
};

export function PayrollExpenseSummary() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const d = await apiGet<Summary>("/payroll/journal/summary");
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load payroll");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentYear = new Date().getFullYear().toString();
  const ytdYear = data?.yearly_ytd?.[currentYear];

  // Employee-only items NOT a company expense (we don't have direct totals so leave a placeholder)
  // The note explains why these aren't included.

  if (loading) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Payroll expense (from payroll journal)</p>
        <p className="aq-lite-muted">Parsing payroll journals…</p>
      </section>
    );
  }
  if (err || !data) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Payroll expense (from payroll journal)</p>
        <p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p>
      </section>
    );
  }

  const t = data.grand_total;
  const totalCompanyExpense = t.gross + t.employer_taxes + t.employer_401k; // == employer_cost
  // Gross includes the employee 401(k) deduction (it's withheld from gross). The
  // company already pays the gross to the employee+plan combined. We don't separate it here.

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Payroll expense (payroll journal · canonical COGS source)</p>
          <h3>{formatCurrency(t.employer_cost)} total payroll cost = COGS</h3>
        </div>
        {ytdYear ? (
          <div style={{ textAlign: "right" }}>
            <div className="aq-lite-muted" style={{ fontSize: 12 }}>{currentYear} YTD</div>
            <strong style={{ fontSize: 18, color: "var(--aq-green)" }}>
              {formatCurrency(ytdYear.employer_cost)}
            </strong>
          </div>
        ) : null}
      </div>

      <p className="aq-lite-muted" style={{ marginTop: 4, fontSize: 12 }}>
        Engineering consulting business — payroll is your direct cost of producing client work, so it's <strong>all
        COGS</strong>. The numbers below come from the Gusto Payroll Journal you imported, which is the authoritative
        source (bank-side payroll rows can be misclassified or double-counted; Gusto is clean).
      </p>

      {/* What IS company expense */}
      <div style={{ marginTop: 14 }}>
        <p className="aq-lite-eyebrow" style={{ color: "var(--aq-green)" }}>What IS company payroll expense (COGS)</p>
        <table className="aq-lite-table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Component</th>
              <th style={{ textAlign: "right" }}>Lifetime</th>
              {Object.keys(data.yearly_ytd).sort().map((y) => (
                <th key={y} style={{ textAlign: "right" }}>{y}</th>
              ))}
              <th>What it is</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Gross wages</strong></td>
              <td style={{ textAlign: "right" }}>{formatCurrency(t.gross)}</td>
              {Object.keys(data.yearly_ytd).sort().map((y) => (
                <td key={y} style={{ textAlign: "right" }}>{formatCurrency(data.yearly_ytd[y].gross)}</td>
              ))}
              <td style={{ fontSize: 11, color: "var(--aq-muted)" }}>What you owe the employee. Includes their tax + 401(k) withholdings (those flow to govt / plan, not extra company $).</td>
            </tr>
            <tr>
              <td><strong>Employer payroll taxes</strong></td>
              <td style={{ textAlign: "right" }}>{formatCurrency(t.employer_taxes)}</td>
              {Object.keys(data.yearly_ytd).sort().map((y) => (
                <td key={y} style={{ textAlign: "right" }}>{formatCurrency(data.yearly_ytd[y].employer_taxes)}</td>
              ))}
              <td style={{ fontSize: 11, color: "var(--aq-muted)" }}>Employer SS, Medicare, FUTA, SUI, NY MCTMT/Reemployment, NJ SUI/SDI/FLI etc.</td>
            </tr>
            <tr>
              <td><strong>Employer 401(k) match</strong></td>
              <td style={{ textAlign: "right" }}>{formatCurrency(t.employer_401k)}</td>
              {Object.keys(data.yearly_ytd).sort().map((y) => (
                <td key={y} style={{ textAlign: "right" }}>{formatCurrency(data.yearly_ytd[y].employer_401k)}</td>
              ))}
              <td style={{ fontSize: 11, color: "var(--aq-muted)" }}>Company contribution into Human Interest plan. Tax-deductible benefit.</td>
            </tr>
            <tr style={{ background: "#e5f5ee" }}>
              <td style={{ fontWeight: 700, color: "#235944" }}>TOTAL Employer Cost (COGS)</td>
              <td style={{ textAlign: "right", fontWeight: 800, color: "#235944" }}>{formatCurrency(totalCompanyExpense)}</td>
              {Object.keys(data.yearly_ytd).sort().map((y) => (
                <td key={y} style={{ textAlign: "right", fontWeight: 700, color: "#235944" }}>
                  {formatCurrency(data.yearly_ytd[y].employer_cost)}
                </td>
              ))}
              <td style={{ fontSize: 11, color: "#235944", fontWeight: 600 }}>
                The number that goes on your tax return as direct labor / COGS.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* What is NOT company expense */}
      <div style={{ marginTop: 18 }}>
        <p className="aq-lite-eyebrow">What is NOT a separate company expense</p>
        <ul style={{ marginTop: 6, fontSize: 12, color: "var(--aq-muted)", lineHeight: 1.7 }}>
          <li>
            <strong>Employee 401(k) deduction</strong> — it's withheld from Gross wages and sent to the plan. Already
            counted in Gross, not an additional company cost.
          </li>
          <li>
            <strong>Employee tax withholdings (federal/state/SS/Medicare/etc)</strong> — same treatment: withheld from
            Gross wages and remitted to the government. Not a separate company cost.
          </li>
          <li>
            <strong>Net pay vs gross pay</strong> — the company pays Gross. How that gross splits between net-to-employee /
            withheld-for-tax / withheld-for-401k is a routing detail, not a separate expense.
          </li>
        </ul>
      </div>

      {/* Quick stat: net pay disbursed (informational) */}
      <div className="aq-lite-grid aq-lite-grid-3" style={{ marginTop: 14 }}>
        <article className="aq-lite-kpi">
          <span>Net cash to employees</span>
          <strong>{formatCurrency(t.net_pay)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Hours paid</span>
          <strong>{formatNumber(t.hours, 0)}</strong>
        </article>
        <article className="aq-lite-kpi" style={{ background: "#e5f5ee", border: "1px solid #b8decf" }}>
          <span style={{ color: "#235944" }}>Total Company COGS</span>
          <strong style={{ color: "#235944" }}>{formatCurrency(t.employer_cost)}</strong>
        </article>
      </div>
    </section>
  );
}
