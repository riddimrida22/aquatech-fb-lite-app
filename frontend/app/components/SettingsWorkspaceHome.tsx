"use client";

type AuditEvent = {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_user_email: string | null;
  payload_json: string;
  created_at: string;
};

type SettingsWorkspaceHomeProps = {
  canViewFinancials: boolean;
  canManageUsers: boolean;
  bankConnectionsCount: number;
  businessAccountsCount: number;
  bankQueueVisibleCount: number;
  bankQueueTotal: number;
  openTeamSettings: () => void;
  openProjectEditor: () => void;
  openAccountingWorkspace: () => void;
  openSettingsBankConnections: () => void;
  openSettingsBankTransactions: () => void;
  openSettingsExpenseMix: () => void;
  auditEntityFilter: string;
  setAuditEntityFilter: (value: string) => void;
  auditActionFilter: string;
  setAuditActionFilter: (value: string) => void;
  refreshAuditEvents: () => void;
  auditEvents: AuditEvent[];
};

export function SettingsWorkspaceHome({
  canViewFinancials,
  canManageUsers,
  bankConnectionsCount,
  businessAccountsCount,
  bankQueueVisibleCount,
  bankQueueTotal,
  openTeamSettings,
  openProjectEditor,
  openAccountingWorkspace,
  openSettingsBankConnections,
  openSettingsBankTransactions,
  openSettingsExpenseMix,
  auditEntityFilter,
  setAuditEntityFilter,
  auditActionFilter,
  setAuditActionFilter,
  refreshAuditEvents,
  auditEvents,
}: SettingsWorkspaceHomeProps) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(190px, 1fr))", gap: 10 }}>
        <div style={{ border: "1px solid #eee", padding: 10 }}>
          <strong>User Management</strong>
          <p style={{ fontSize: 12, color: "#4a4a4a" }}>Permissions, activation, and employee records.</p>
          <button onClick={openTeamSettings}>Open Team Settings</button>
        </div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>
          <strong>Project Configuration</strong>
          <p style={{ fontSize: 12, color: "#4a4a4a" }}>WBS, budgets, target margin defaults.</p>
          <button onClick={openProjectEditor}>Open Project Settings</button>
        </div>
        <div style={{ border: "1px solid #eee", padding: 10 }}>
          <strong>Accounting Controls</strong>
          <p style={{ fontSize: 12, color: "#4a4a4a" }}>Invoice templates, recurring schedules, import mapping.</p>
          <button onClick={openAccountingWorkspace}>Open Accounting Settings</button>
        </div>
        {canViewFinancials && (
          <div style={{ border: "1px solid #dbe4ee", padding: 10, background: "#f7fafd" }}>
            <strong>Bank Workspace</strong>
            <p style={{ fontSize: 12, color: "#4a4a4a" }}>
              Keep bank setup and transaction reconciliation separate for a cleaner workflow.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={openSettingsBankConnections}>Open Bank Connections</button>
              <button onClick={openSettingsBankTransactions}>Open Bank Transactions</button>
              <button onClick={openSettingsExpenseMix}>Open Expense Mix</button>
            </div>
            <div style={{ marginTop: 8, borderTop: "1px solid #e3ebf3", paddingTop: 8 }}>
              <div style={{ fontSize: 12, color: "#4a6076" }}>
                Connections: <strong>{bankConnectionsCount}</strong> | Business Accounts: <strong>{businessAccountsCount}</strong> | Queue Rows: <strong>{bankQueueVisibleCount}</strong> / <strong>{bankQueueTotal}</strong>
              </div>
            </div>
          </div>
        )}
      </div>
      {canManageUsers && (
        <div style={{ marginTop: 10, border: "1px solid #dbe4ee", borderRadius: 10, background: "#f7fafd", padding: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <strong>Audit Trail</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input value={auditEntityFilter} onChange={(e) => setAuditEntityFilter(e.target.value)} placeholder="Filter entity (e.g. timesheet)" />
              <input value={auditActionFilter} onChange={(e) => setAuditActionFilter(e.target.value)} placeholder="Filter action (e.g. approve_timesheet)" />
              <button onClick={refreshAuditEvents}>Refresh Audit</button>
            </div>
          </div>
          <div style={{ maxHeight: 300, overflow: "auto", border: "1px solid #e3ebf3", borderRadius: 8, background: "#fff" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>When</th>
                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Actor</th>
                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Entity</th>
                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Action</th>
                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Payload</th>
                </tr>
              </thead>
              <tbody>
                {auditEvents.map((ev) => (
                  <tr key={`audit-row-${ev.id}`}>
                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{new Date(ev.created_at).toLocaleString()}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{ev.actor_user_email || "-"}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{ev.entity_type} #{ev.entity_id}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{ev.action}</td>
                    <td style={{ borderBottom: "1px solid #eee", padding: 6, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}>
                      {ev.payload_json.length > 120 ? `${ev.payload_json.slice(0, 120)}...` : ev.payload_json}
                    </td>
                  </tr>
                ))}
                {auditEvents.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 8, color: "#666" }}>No audit events in current filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
