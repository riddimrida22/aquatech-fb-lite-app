"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency, formatNumber } from "./workspaceShared";
import { GroupedList } from "./GroupedList";

type Totals = {
  gross: number;
  employer_taxes: number;
  employer_401k: number;
  employer_cost: number;
  net_pay: number;
  hours: number;
  period_count?: number;
};

type EmployeeSummary = Totals & {
  by_year: Record<string, Totals>;
};

type PeriodRow = {
  employee: string;
  hours: number;
  gross: number;
  employer_taxes: number;
  employer_401k: number;
  net_pay: number;
  check_amount: number;
  employer_cost: number;
};

type Period = {
  period: string;
  pay_day: string;
  rows: PeriodRow[];
  totals: Totals;
  year: string;
  file: string;
};

type PayrollSummary = {
  by_year: Record<string, { file: string; period_count: number; employee_count: number; totals: Totals }>;
  yearly_ytd: Record<string, Totals>;
  all_employees: Record<string, EmployeeSummary>;
  all_periods: Period[];
  grand_total: Totals;
  treatment_note: string;
};

export function PayrollPortal() {
  const [data, setData] = useState<PayrollSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<string>("all");
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const d = await apiGet<PayrollSummary>("/payroll/journal/summary");
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

  const visiblePeriods = useMemo(() => {
    if (!data) return [];
    const filtered = yearFilter === "all" ? data.all_periods : data.all_periods.filter((p) => p.year === yearFilter);
    // Sort by pay_day descending
    return filtered.slice().sort((a, b) => (b.pay_day || "").localeCompare(a.pay_day || ""));
  }, [data, yearFilter]);

  if (loading) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Payroll portal</p>
        <p className="aq-lite-muted">Parsing Gusto journals…</p>
      </section>
    );
  }
  if (err || !data) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Payroll portal</p>
        <p style={{ color: "var(--aq-red)" }}>{err || "No data"}</p>
        <p className="aq-lite-muted" style={{ marginTop: 8, fontSize: 12 }}>
          Drop a Gusto Payroll Journal CSV into the imports inbox and refresh.
        </p>
      </section>
    );
  }

  const years = Object.keys(data.by_year).sort();
  const employees = Object.entries(data.all_employees).sort((a, b) => b[1].employer_cost - a[1].employer_cost);

  return (
    <div className="aq-lite-stack">
      {/* Hero stat row */}
      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <div>
            <p className="aq-lite-eyebrow">Payroll portal · COGS view</p>
            <h3>{formatCurrency(data.grand_total.employer_cost)} total Employer Cost (= total payroll COGS)</h3>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="aq-lite-muted" style={{ fontSize: 12 }}>Across {Object.keys(data.by_year).length} year{Object.keys(data.by_year).length === 1 ? "" : "s"}</div>
            <strong>{Object.keys(data.all_employees).length} employees · {formatNumber(data.grand_total.hours, 0)} hours</strong>
          </div>
        </div>

        <p className="aq-lite-muted" style={{ marginTop: 4, fontSize: 12 }}>
          {data.treatment_note}
        </p>

        {/* KPIs */}
        <div className="aq-lite-grid aq-lite-grid-4" style={{ marginTop: 14 }}>
          <article className="aq-lite-kpi">
            <span>Gross wages</span>
            <strong>{formatCurrency(data.grand_total.gross)}</strong>
          </article>
          <article className="aq-lite-kpi">
            <span>Employer taxes</span>
            <strong>{formatCurrency(data.grand_total.employer_taxes)}</strong>
          </article>
          <article className="aq-lite-kpi">
            <span>Employer 401(k) match</span>
            <strong>{formatCurrency(data.grand_total.employer_401k)}</strong>
          </article>
          <article className="aq-lite-kpi" style={{ background: "#e5f5ee", border: "1px solid #b8decf" }}>
            <span style={{ color: "#235944" }}>Total Employer Cost (COGS)</span>
            <strong style={{ color: "#235944" }}>{formatCurrency(data.grand_total.employer_cost)}</strong>
          </article>
        </div>
      </section>

      {/* By year */}
      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <div>
            <p className="aq-lite-eyebrow">By year</p>
            <h3>Year-over-year payroll cost</h3>
          </div>
          <div className="aq-lite-segmented">
            <button type="button" className={yearFilter === "all" ? "active" : ""} onClick={() => setYearFilter("all")}>
              All ({data.all_periods.length} pp)
            </button>
            {years.map((y) => (
              <button key={y} type="button" className={yearFilter === y ? "active" : ""} onClick={() => setYearFilter(y)}>
                {y} ({data.by_year[y].period_count} pp)
              </button>
            ))}
          </div>
        </div>
        <table className="aq-lite-table">
          <thead>
            <tr>
              <th>Year</th>
              <th style={{ textAlign: "right" }}>Employees</th>
              <th style={{ textAlign: "right" }}>Pay periods</th>
              <th style={{ textAlign: "right" }}>Hours</th>
              <th style={{ textAlign: "right" }}>Gross</th>
              <th style={{ textAlign: "right" }}>Employer taxes</th>
              <th style={{ textAlign: "right" }}>401(k) match</th>
              <th style={{ textAlign: "right" }}>Employer Cost (COGS)</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const v = data.by_year[y];
              return (
                <tr key={y}>
                  <td><strong>{y}</strong></td>
                  <td style={{ textAlign: "right" }}>{v.employee_count}</td>
                  <td style={{ textAlign: "right" }}>{v.period_count}</td>
                  <td style={{ textAlign: "right" }}>{formatNumber(v.totals.hours, 0)}</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(v.totals.gross)}</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(v.totals.employer_taxes)}</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(v.totals.employer_401k)}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: "var(--aq-green)" }}>{formatCurrency(v.totals.employer_cost)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ fontWeight: 700 }}>Lifetime total</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formatNumber(data.grand_total.hours, 0)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(data.grand_total.gross)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(data.grand_total.employer_taxes)}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{formatCurrency(data.grand_total.employer_401k)}</td>
              <td style={{ textAlign: "right", fontWeight: 800, color: "var(--aq-green)" }}>{formatCurrency(data.grand_total.employer_cost)}</td>
            </tr>
          </tfoot>
        </table>
      </section>

      {/* By employee */}
      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <div>
            <p className="aq-lite-eyebrow">By employee · click to drill into per-period detail</p>
            <h3>{employees.length} employees · sorted by lifetime Employer Cost</h3>
          </div>
        </div>
        <table className="aq-lite-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th style={{ textAlign: "right" }}>Hours</th>
              <th style={{ textAlign: "right" }}>Gross</th>
              <th style={{ textAlign: "right" }}>Employer taxes</th>
              <th style={{ textAlign: "right" }}>401(k) match</th>
              <th style={{ textAlign: "right" }}>Net pay</th>
              <th style={{ textAlign: "right" }}>Employer Cost</th>
              <th style={{ textAlign: "right" }}>% of total</th>
            </tr>
          </thead>
          <tbody>
            {employees.map(([emp, vals]) => {
              const pct = data.grand_total.employer_cost > 0
                ? (100 * vals.employer_cost) / data.grand_total.employer_cost
                : 0;
              const expanded = selectedEmployee === emp;
              return (
                <>
                  <tr
                    key={emp}
                    onClick={() => setSelectedEmployee((cur) => (cur === emp ? null : emp))}
                    style={{ cursor: "pointer", background: expanded ? "var(--aq-primary-soft)" : undefined }}
                  >
                    <td>
                      <strong>{emp}</strong>
                      <div style={{ fontSize: 11, color: "var(--aq-muted)" }}>
                        {expanded ? "▼ year breakdown" : "▶ click for year-by-year"}
                      </div>
                    </td>
                    <td style={{ textAlign: "right" }}>{formatNumber(vals.hours, 0)}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(vals.gross)}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(vals.employer_taxes)}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(vals.employer_401k)}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(vals.net_pay)}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "var(--aq-green)" }}>{formatCurrency(vals.employer_cost)}</td>
                    <td style={{ textAlign: "right" }}>{pct.toFixed(1)}%</td>
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={8} style={{ background: "var(--aq-primary-soft)", padding: 14 }}>
                        <p className="aq-lite-eyebrow">Year-over-year for {emp}</p>
                        <table className="aq-lite-table" style={{ marginTop: 6 }}>
                          <thead>
                            <tr>
                              <th>Year</th>
                              <th style={{ textAlign: "right" }}>Hours</th>
                              <th style={{ textAlign: "right" }}>Gross</th>
                              <th style={{ textAlign: "right" }}>Employer taxes</th>
                              <th style={{ textAlign: "right" }}>401(k)</th>
                              <th style={{ textAlign: "right" }}>Employer Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(vals.by_year).sort(([a],[b])=>a.localeCompare(b)).map(([y, t]) => (
                              <tr key={y}>
                                <td>{y}</td>
                                <td style={{ textAlign: "right" }}>{formatNumber(t.hours, 0)}</td>
                                <td style={{ textAlign: "right" }}>{formatCurrency(t.gross)}</td>
                                <td style={{ textAlign: "right" }}>{formatCurrency(t.employer_taxes)}</td>
                                <td style={{ textAlign: "right" }}>{formatCurrency(t.employer_401k)}</td>
                                <td style={{ textAlign: "right", fontWeight: 600 }}>{formatCurrency(t.employer_cost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Per-period list */}
      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <div>
            <p className="aq-lite-eyebrow">Pay periods</p>
            <h3>{visiblePeriods.length} periods{yearFilter !== "all" ? ` in ${yearFilter}` : ""}</h3>
          </div>
        </div>
        <GroupedList
          rows={visiblePeriods}
          persistKey="payroll.periods"
          searchPredicate={(p, q) => `${p.pay_day} ${p.period}`.toLowerCase().includes(q)}
          searchPlaceholder="Search pay day / period"
          emptyHint="No pay periods."
          groupOptions={[
            {
              key: "year",
              label: "Year",
              groupBy: (p) => (p.pay_day || p.period || "").slice(-4) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "month",
              label: "Pay month",
              groupBy: (p) => {
                // Convert MM/DD/YYYY -> YYYY-MM
                const pd = p.pay_day || "";
                const m = pd.match(/(\d{2})\/\d{2}\/(\d{4})/);
                return m ? `${m[2]}-${m[1]}` : (pd || "—");
              },
              sortBuckets: (a, b) => b.localeCompare(a),
            },
          ]}
          renderGroupSummary={(items) => {
            const cost = items.reduce((s, p) => s + (p.totals?.employer_cost || 0), 0);
            const hrs = items.reduce((s, p) => s + (p.totals?.hours || 0), 0);
            return `${formatNumber(hrs, 0)}h · ${formatCurrency(cost)}`;
          }}
          renderRow={(p) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1.4fr 80px 80px 110px 110px 110px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
                alignItems: "center",
              }}
            >
              <strong>{p.pay_day || "—"}</strong>
              <span style={{ color: "var(--aq-muted)", fontSize: 11 }}>{p.period}</span>
              <span style={{ textAlign: "right" }}>{p.rows.length} emp</span>
              <span style={{ textAlign: "right" }}>{formatNumber(p.totals.hours, 0)}h</span>
              <span style={{ textAlign: "right" }}>{formatCurrency(p.totals.gross)}</span>
              <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>{formatCurrency(p.totals.net_pay)}</span>
              <span style={{ textAlign: "right", fontWeight: 600, color: "var(--aq-green)" }}>
                {formatCurrency(p.totals.employer_cost)}
              </span>
            </div>
          )}
          initiallyOpen="first"
        />
      </section>
    </div>
  );
}
