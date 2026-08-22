"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency, formatNumber } from "./workspaceShared";

type AccrualRow = {
  user_id: number;
  name: string;
  hourly_rate: number;
  hours: number;
  earned: number;
  paid_gross: number;
  adjustments: number;
  paid_total: number;
  accrued_balance: number;
  rate_known: boolean;
  payroll_matched: boolean;
};
type AccrualReport = {
  year: number;
  rows: AccrualRow[];
  totals: { earned: number; paid_gross: number; adjustments: number; paid_total: number; accrued_balance: number };
  method: string;
};

/** Accrued unpaid salary per employee = earned (hours x gross pay rate) − paid (payroll
 *  gross). Positive = wages earned but not yet paid out. Payroll-based; updates itself as
 *  hours are logged and each pay run is imported. */
export function SalaryAccrualPanel() {
  const [data, setData] = useState<AccrualReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<AccrualReport>("/reports/salary-accrual")
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Failed to load"); });
    return () => { live = false; };
  }, []);

  if (error) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Accrued unpaid salary</p>
        <p className="aq-lite-muted" style={{ marginTop: 8, color: "#b42318" }}>{error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Accrued unpaid salary</p>
        <p className="aq-lite-muted" style={{ marginTop: 8 }}>Loading…</p>
      </section>
    );
  }

  const total = data.totals.accrued_balance;
  const num = (n: number) => formatCurrency(n);

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">You owe · Accrued unpaid salary ({data.year})</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 32, color: total > 0.01 ? "#8a5b1f" : "#1f8a5b", lineHeight: 1.05 }}>
            {num(total)}
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, margin: "3px 0 0" }}>
            {num(data.totals.earned)} earned − {num(data.totals.paid_total)} paid
            {data.totals.adjustments > 0.01
              ? ` (${num(data.totals.paid_gross)} payroll + ${num(data.totals.adjustments)} non-payroll)`
              : " (payroll)"}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 14, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "right", color: "var(--aq-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
              <th style={{ textAlign: "left", padding: "6px 4px" }}>Employee</th>
              <th style={{ padding: "6px 4px" }}>Rate</th>
              <th style={{ padding: "6px 4px" }}>Hours</th>
              <th style={{ padding: "6px 4px" }}>Earned</th>
              <th style={{ padding: "6px 4px" }}>Paid</th>
              <th style={{ padding: "6px 4px" }}>Accrued</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const owed = r.accrued_balance > 0.01;
              const flag = !r.rate_known || !r.payroll_matched;
              return (
                <tr key={r.user_id} style={{ borderTop: "1px solid rgba(128,128,128,0.14)" }}>
                  <td style={{ textAlign: "left", padding: "7px 4px", fontWeight: 600 }}>
                    {r.name}
                    {flag ? (
                      <span
                        title={[!r.rate_known ? "no pay rate on file" : "", !r.payroll_matched ? "no payroll match found" : ""].filter(Boolean).join("; ")}
                        style={{ marginLeft: 6, fontSize: 10, color: "#b42318", cursor: "help" }}
                      >⚠</span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right", padding: "7px 4px", color: "var(--aq-muted)" }}>
                    {r.rate_known ? `$${formatNumber(r.hourly_rate, 2)}` : "—"}
                  </td>
                  <td style={{ textAlign: "right", padding: "7px 4px" }}>{formatNumber(r.hours, 1)}</td>
                  <td style={{ textAlign: "right", padding: "7px 4px" }}>{num(r.earned)}</td>
                  <td
                    style={{ textAlign: "right", padding: "7px 4px", color: "var(--aq-muted)" }}
                    title={r.adjustments > 0.01 ? `${num(r.paid_gross)} payroll + ${num(r.adjustments)} non-payroll comp` : undefined}
                  >
                    {num(r.paid_total)}{r.adjustments > 0.01 ? " *" : ""}
                  </td>
                  <td style={{ textAlign: "right", padding: "7px 4px", fontWeight: 700, color: owed ? "#8a5b1f" : "#1f8a5b" }}>
                    {r.accrued_balance < 0 ? `(${num(Math.abs(r.accrued_balance))})` : num(r.accrued_balance)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="aq-lite-muted" style={{ fontSize: 10.5, marginTop: 12, opacity: 0.8, lineHeight: 1.5 }}>
        {data.method} A negative (parenthesized) balance means paid more than earned-by-hours this year.
        ⚠ = missing pay rate or no payroll match. * = paid includes owner-flagged non-payroll comp (e.g. Zelle).
      </p>
    </section>
  );
}
