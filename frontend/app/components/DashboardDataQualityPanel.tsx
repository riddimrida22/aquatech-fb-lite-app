"use client";

import type { CSSProperties } from "react";

type DataQualityIssue = {
  label: string;
  value: number;
  high: number;
};

type DashboardDataQualityPanelProps = {
  healthLabel: string;
  openCount: number;
  issues: DataQualityIssue[];
  onIssueClick?: (issueLabel: string) => void;
};

export function DashboardDataQualityPanel({ healthLabel, openCount, issues, onIssueClick }: DashboardDataQualityPanelProps) {
  const cardLabelStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1.35,
  };
  const cardValueStyle: CSSProperties = {
    fontSize: 16,
    fontWeight: 700,
    lineHeight: 1.2,
  };
  const cardActionStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 500,
    color: "#2f5f92",
    textDecoration: "underline",
  };
  return (
    <div className="aq-dashboard-section">
      <h3 className="aq-dashboard-section-title">Data Quality Guardrails</h3>
      <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: "#4a6076" }}>
        Health: <strong style={{ color: openCount === 0 ? "#147b74" : "#b0422b" }}>{healthLabel}</strong>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 8, fontSize: 12 }}>
        {issues.map((issue) => {
          const isOpen = issue.value > issue.high;
          const canNavigate = Boolean(onIssueClick) && isOpen;
          if (canNavigate) {
            return (
              <button
                key={`dq-issue-${issue.label}`}
                type="button"
                onClick={() => onIssueClick?.(issue.label)}
                style={{
                  border: "1px solid #d4e3f2",
                  padding: 8,
                  borderRadius: 8,
                  background: "#f7fbff",
                  color: "#1f3248",
                  textAlign: "left",
                  cursor: "pointer",
                }}
                title={`Open ${issue.label}`}
              >
                <span style={cardLabelStyle}>{issue.label}</span><br />
                <strong style={{ ...cardValueStyle, color: "#b0422b" }}>{issue.value}</strong><br />
                <span style={cardActionStyle}>Open</span>
              </button>
            );
          }
          return (
            <div key={`dq-issue-${issue.label}`} style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
              <span style={cardLabelStyle}>{issue.label}</span><br />
              <strong style={{ ...cardValueStyle, color: "#147b74" }}>{issue.value}</strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}
