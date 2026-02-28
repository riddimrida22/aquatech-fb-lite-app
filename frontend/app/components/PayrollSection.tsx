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

type PayrollSectionProps = {
  activeUsers: PayrollUser[];
  usersWithRatesCount: number;
  usersMissingRatesCount: number;
  laborCostText: string;
  latestRates: Record<number, LatestRate>;
  formatCurrency: (value: number) => string;
  onManageRates: () => void;
};

export function PayrollSection({
  activeUsers,
  usersWithRatesCount,
  usersMissingRatesCount,
  laborCostText,
  latestRates,
  formatCurrency,
  onManageRates,
}: PayrollSectionProps) {
  return (
    <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
      <h2>Payroll</h2>
      <p style={{ marginTop: 4, color: "#4a4a4a" }}>Labor-rate coverage and applied-cost overview for current period.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Active Staff<br /><strong>{activeUsers.length}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Users With Rates<br /><strong>{usersWithRatesCount}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Users Missing Rates<br /><strong>{usersMissingRatesCount}</strong></div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>Labor Cost (PTD)<br /><strong>{laborCostText}</strong></div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Role</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Latest Cost Rate</th>
              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Latest Bill Rate</th>
            </tr>
          </thead>
          <tbody>
            {activeUsers.map((u) => {
              const rate = latestRates[u.id];
              return (
                <tr key={`payroll-${u.id}`}>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{u.full_name || u.email}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{u.role}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{rate ? "Rate configured" : "Missing rate"}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{rate ? formatCurrency(rate.cost_rate) : "-"}</td>
                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{rate ? formatCurrency(rate.bill_rate) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10 }}>
        <button onClick={onManageRates}>Manage Rates</button>
      </div>
    </section>
  );
}
