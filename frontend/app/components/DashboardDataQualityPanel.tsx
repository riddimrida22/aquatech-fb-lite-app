"use client";

type DataQualityIssue = {
  label: string;
  value: number;
  high: number;
};

type DashboardDataQualityPanelProps = {
  healthLabel: string;
  openCount: number;
  issues: DataQualityIssue[];
};

export function DashboardDataQualityPanel({ healthLabel, openCount, issues }: DashboardDataQualityPanelProps) {
  return (
    <div className="aq-dashboard-section">
      <h3 className="aq-dashboard-section-title">Data Quality Guardrails</h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: "#4a6076" }}>
        Health: <strong style={{ color: openCount === 0 ? "#147b74" : "#b0422b" }}>{healthLabel}</strong>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 8, fontSize: 12 }}>
        {issues.map((issue) => (
          <div key={`dq-issue-${issue.label}`} style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
            {issue.label}<br />
            <strong style={{ color: issue.value > issue.high ? "#b0422b" : "#147b74" }}>{issue.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
