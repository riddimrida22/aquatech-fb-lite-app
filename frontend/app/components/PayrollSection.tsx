"use client";

type PayrollUser = {
  id: number;
  email: string;
  full_name: string;
  role: string;
};

type LatestRate = {
  cost_rate: number;
  bill_rate: number;
};

type PayrollHoursPeriod = {
  period_start: string;
  period_end: string;
  label: string;
  total_hours: number;
  employee_count: number;
};

type PayrollHoursRow = {
  user_id: number;
  employee: string;
  email: string;
  hours: number;
  cost_rate: number | null;
  bill_rate: number | null;
};

type PayrollHoursReport = {
  as_of: string;
  current_period_start: string;
  current_period_end: string;
  selected_period_start: string;
  selected_period_end: string;
  periods: PayrollHoursPeriod[];
  rows: PayrollHoursRow[];
};

type PayrollSectionProps = {
  activeUsers: PayrollUser[];
  usersWithRatesCount: number;
  usersMissingRatesCount: number;
  laborCostText: string;
  latestRates: Record<number, LatestRate>;
  formatCurrency: (value: number) => string;
  onManageRates: () => void;
  payrollHoursReport: PayrollHoursReport | null;
  payrollPeriodEnd: string;
  onSelectPayrollPeriodEnd: (periodEnd: string) => void;
};

export function PayrollSection({
  activeUsers,
  usersWithRatesCount,
  usersMissingRatesCount,
  laborCostText,
  latestRates,
  formatCurrency,
  onManageRates,
  payrollHoursReport,
  payrollPeriodEnd,
  onSelectPayrollPeriodEnd,
}: PayrollSectionProps) {
  const periodRows = payrollHoursReport?.rows || [];
  const periodHoursTotal = periodRows.reduce((sum, row) => sum + Number(row.hours || 0), 0);

  return (
    <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
      <h2>Payroll</h2>
      <p style={{ marginTop: 4, color: "#4a4a4a" }}>
        Biweekly payroll periods ending Sunday, with employee hours and period-effective rates.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Active Staff<br /><strong>{activeUsers.length}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Users With Rates<br /><strong>{usersWithRatesCount}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Users Missing Rates<br /><strong>{usersMissingRatesCount}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Labor Cost (PTD)<br /><strong>{laborCostText}</strong></div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          Pay Period End
          <select value={payrollPeriodEnd} onChange={(e) => onSelectPayrollPeriodEnd(e.target.value)}>
            {(payrollHoursReport?.periods || []).map((p) => (
              <option key={`pay-period-${p.period_end}`} value={p.period_end}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ fontSize: 12, color: "#4a6076" }}>
          Current Period: {payrollHoursReport?.current_period_start || "-"} to {payrollHoursReport?.current_period_end || "-"}
        </div>
      </div>

      <div style={{ border: "1px solid #e6edf5", borderRadius: 8, padding: 10, marginBottom: 10, background: "#f8fbff" }}>
        <strong>Selected Period</strong>: {payrollHoursReport?.selected_period_start || "-"} to {payrollHoursReport?.selected_period_end || "-"} |{" "}
        <strong>Total Hours</strong>: {periodHoursTotal.toFixed(2)}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Hours (Period)</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Rate Status</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Cost Rate (Period)</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Bill Rate (Period)</th>
            </tr>
          </thead>
          <tbody>
            {periodRows.map((u) => {
              const fallback = latestRates[u.user_id];
              const costRate = u.cost_rate ?? fallback?.cost_rate ?? null;
              const billRate = u.bill_rate ?? fallback?.bill_rate ?? null;
              return (
                <tr key={`payroll-period-${u.user_id}`}>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{u.employee || u.email}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{Number(u.hours || 0).toFixed(2)}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{costRate !== null || billRate !== null ? "Rate configured" : "Missing rate"}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{costRate !== null ? formatCurrency(costRate) : "-"}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{billRate !== null ? formatCurrency(billRate) : "-"}</td>
                </tr>
              );
            })}
            {periodRows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ borderBottom: "1px solid #eee", padding: 8, color: "#666" }}>No payroll rows for selected period.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <button onClick={onManageRates}>Manage Rates</button>
      </div>
    </section>
  );
}
