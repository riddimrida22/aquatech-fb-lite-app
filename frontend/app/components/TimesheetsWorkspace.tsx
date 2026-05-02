"use client";

import { useMemo, useState } from "react";

import { AdminTimesheet, Timesheet, formatDate, formatNumber } from "./workspaceShared";
import { StatusBadge } from "./StatusBadge";
import { GroupedList } from "./GroupedList";

type TimesheetsWorkspaceProps = {
  timesheets: Timesheet[];
  adminTimesheets: AdminTimesheet[];
  canApproveTimesheets: boolean;
  onGenerateTimesheet: () => Promise<void>;
  onSubmitTimesheet: (timesheetId: number) => Promise<void>;
  onAdminSubmitTimesheet: (sheet: AdminTimesheet) => Promise<void>;
  onAdminApproveTimesheet: (sheet: AdminTimesheet) => Promise<void>;
  onAdminReturnTimesheet: (sheet: AdminTimesheet) => Promise<void>;
  submitting: string | null;
};

export function TimesheetsWorkspace({
  timesheets,
  adminTimesheets,
  canApproveTimesheets,
  onGenerateTimesheet,
  onSubmitTimesheet,
  onAdminSubmitTimesheet,
  onAdminApproveTimesheet,
  onAdminReturnTimesheet,
  submitting,
}: TimesheetsWorkspaceProps) {
  const counts = {
    draft: timesheets.filter((sheet) => sheet.status === "draft" || sheet.status === "rejected").length,
    submitted: timesheets.filter((sheet) => sheet.status === "submitted").length,
    approved: timesheets.filter((sheet) => sheet.status === "approved").length,
  };
  const [adminStatusFilter, setAdminStatusFilter] = useState<"all" | "unsubmitted" | "draft" | "submitted" | "approved" | "rejected">(
    "all",
  );

  const currentSheet = timesheets
    .slice()
    .sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
  const adminCounts = {
    unsubmitted: adminTimesheets.filter((sheet) => sheet.status === "unsubmitted").length,
    draft: adminTimesheets.filter((sheet) => sheet.status === "draft" || sheet.status === "rejected").length,
    submitted: adminTimesheets.filter((sheet) => sheet.status === "submitted").length,
    approved: adminTimesheets.filter((sheet) => sheet.status === "approved").length,
  };
  const visibleAdminTimesheets = useMemo(() => {
    if (adminStatusFilter === "all") return adminTimesheets;
    if (adminStatusFilter === "draft") {
      return adminTimesheets.filter((sheet) => sheet.status === "draft" || sheet.status === "rejected");
    }
    return adminTimesheets.filter((sheet) => sheet.status === adminStatusFilter);
  }, [adminStatusFilter, adminTimesheets]);

  return (
    <div className="aq-lite-stack">
      <div className="aq-lite-grid aq-lite-grid-4">
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Current week</p>
          <h3>{currentSheet ? `${formatNumber(currentSheet.total_hours, 1)}h` : "No sheet"}</h3>
          <p className="aq-lite-muted">{currentSheet ? currentSheet.status : "Generate the current week when needed."}</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Ready to submit</p>
          <h3>{counts.draft}</h3>
          <p className="aq-lite-muted">Draft and returned sheets stay in one queue.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Pending review</p>
          <h3>{counts.submitted}</h3>
          <p className="aq-lite-muted">Submitted sheets wait here instead of getting buried across views.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Approved</p>
          <h3>{counts.approved}</h3>
          <p className="aq-lite-muted">Approved sheets form the clean billing source of truth.</p>
        </section>
      </div>

      <div className="aq-lite-grid aq-lite-grid-2">
        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Weekly controls</p>
              <h3>My timesheets</h3>
            </div>
            <button type="button" onClick={() => void onGenerateTimesheet()} disabled={submitting === "timesheet-generate"}>
              {submitting === "timesheet-generate" ? "Generating…" : "Generate this week"}
            </button>
          </div>
          <table className="aq-lite-table">
            <thead>
              <tr>
                <th>Week</th>
                <th>Status</th>
                <th>Total hours</th>
                <th data-disable-sort="true" />
              </tr>
            </thead>
            <tbody>
              {timesheets.map((sheet) => (
                <tr key={sheet.id}>
                  <td>
                    {formatDate(sheet.week_start)} - {formatDate(sheet.week_end)}
                  </td>
                  <td><StatusBadge status={sheet.status} /></td>
                  <td>{formatNumber(sheet.total_hours, 1)}</td>
                  <td>
                    {sheet.status === "draft" || sheet.status === "rejected" ? (
                      <button
                        type="button"
                        onClick={() => void onSubmitTimesheet(sheet.id)}
                        disabled={submitting === `timesheet-${sheet.id}`}
                      >
                        {submitting === `timesheet-${sheet.id}` ? "Submitting…" : "Submit"}
                      </button>
                    ) : (
                      <span className="aq-lite-muted">No action</span>
                    )}
                  </td>
                </tr>
              ))}
              {timesheets.length === 0 ? (
                <tr>
                  <td colSpan={4} className="aq-lite-muted">
                    No timesheets yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Flow</p>
              <h3>Simple weekly rhythm</h3>
            </div>
          </div>
          <div className="aq-lite-note-stack">
            <div className="aq-lite-note">
              <strong>1. Enter time daily</strong>
              <p>Keep the week current. Time should not be reconstructed at the end of the pay period.</p>
            </div>
            <div className="aq-lite-note">
              <strong>2. Generate once</strong>
              <p>The current week becomes a timesheet on demand, with no extra setup screen.</p>
            </div>
            <div className="aq-lite-note">
              <strong>3. Submit from the roster</strong>
              <p>Submission is available in the same table where you review the week.</p>
            </div>
          </div>
        </section>
      </div>

      {canApproveTimesheets ? (
        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Admin queue</p>
              <h3>All employee timesheets</h3>
            </div>
            <div className="aq-lite-toolbar">
              <button type="button" className={adminStatusFilter === "all" ? "is-active" : ""} onClick={() => setAdminStatusFilter("all")}>
                All
              </button>
              <button
                type="button"
                className={adminStatusFilter === "unsubmitted" ? "is-active" : ""}
                onClick={() => setAdminStatusFilter("unsubmitted")}
              >
                Unsubmitted ({adminCounts.unsubmitted})
              </button>
              <button
                type="button"
                className={adminStatusFilter === "submitted" ? "is-active" : ""}
                onClick={() => setAdminStatusFilter("submitted")}
              >
                Submitted ({adminCounts.submitted})
              </button>
              <button
                type="button"
                className={adminStatusFilter === "approved" ? "is-active" : ""}
                onClick={() => setAdminStatusFilter("approved")}
              >
                Approved ({adminCounts.approved})
              </button>
            </div>
          </div>
          <GroupedList
            rows={visibleAdminTimesheets}
            persistKey="timesheets.admin"
            searchPredicate={(s, q) =>
              `${s.user_full_name || ""} ${s.user_email || ""} ${s.status}`.toLowerCase().includes(q)
            }
            searchPlaceholder="Search employee / status"
            emptyHint="No employee timesheets in this view."
            groupOptions={[
              {
                key: "employee",
                label: "Employee",
                groupBy: (s) => s.user_full_name || s.user_email || `User ${s.user_id}`,
              },
              {
                key: "status",
                label: "Status",
                groupBy: (s) => s.status,
              },
              {
                key: "month",
                label: "Week start month",
                groupBy: (s) => (s.week_start || "").slice(0, 7) || "—",
                sortBuckets: (a, b) => b.localeCompare(a),
              },
            ]}
            renderGroupSummary={(items) => {
              const hours = items.reduce((s, x) => s + (x.total_hours || 0), 0);
              return `${items.length} sheet${items.length === 1 ? "" : "s"} · ${formatNumber(hours, 0)}h`;
            }}
            renderRow={(sheet) => (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.4fr 180px 90px 70px 1.6fr",
                  gap: 8,
                  padding: "6px 8px",
                  fontSize: 12,
                  borderBottom: "1px solid #f0f3f6",
                  alignItems: "center",
                }}
              >
                <span>
                  <strong>{sheet.user_full_name || sheet.user_email || `User ${sheet.user_id}`}</strong>
                  <div style={{ color: "var(--aq-muted)", fontSize: 10 }}>{sheet.user_email || "No email"}</div>
                </span>
                <span>{formatDate(sheet.week_start)} → {formatDate(sheet.week_end)}</span>
                <span><StatusBadge status={sheet.status} /></span>
                <span style={{ textAlign: "right" }}>{formatNumber(sheet.total_hours, 1)}h</span>
                <span style={{ display: "flex", gap: 4, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {(sheet.status === "unsubmitted" || sheet.status === "draft" || sheet.status === "rejected") && (
                    <>
                      <button
                        type="button"
                        onClick={() => void onAdminSubmitTimesheet(sheet)}
                        disabled={submitting === `timesheet-admin-submit-${sheet.user_id}-${sheet.week_start}`}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >
                        {submitting === `timesheet-admin-submit-${sheet.user_id}-${sheet.week_start}` ? "…" : "Submit"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onAdminApproveTimesheet(sheet)}
                        disabled={submitting === `timesheet-admin-approve-${sheet.user_id}-${sheet.week_start}`}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >
                        {submitting === `timesheet-admin-approve-${sheet.user_id}-${sheet.week_start}` ? "…" : "Approve"}
                      </button>
                    </>
                  )}
                  {sheet.status === "submitted" && (
                    <>
                      <button
                        type="button"
                        onClick={() => void onAdminApproveTimesheet(sheet)}
                        disabled={submitting === `timesheet-admin-approve-${sheet.user_id}-${sheet.week_start}`}
                        style={{ padding: "2px 8px", fontSize: 11 }}
                      >
                        {submitting === `timesheet-admin-approve-${sheet.user_id}-${sheet.week_start}` ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onAdminReturnTimesheet(sheet)}
                        disabled={submitting === `timesheet-admin-return-${sheet.user_id}-${sheet.week_start}`}
                        style={{ padding: "2px 8px", fontSize: 11, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}
                      >
                        {submitting === `timesheet-admin-return-${sheet.user_id}-${sheet.week_start}` ? "…" : "Return"}
                      </button>
                    </>
                  )}
                  {sheet.status === "approved" && (
                    <button
                      type="button"
                      onClick={() => void onAdminReturnTimesheet(sheet)}
                      disabled={submitting === `timesheet-admin-return-${sheet.user_id}-${sheet.week_start}`}
                      style={{ padding: "2px 8px", fontSize: 11, background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}
                    >
                      {submitting === `timesheet-admin-return-${sheet.user_id}-${sheet.week_start}` ? "…" : "Return"}
                    </button>
                  )}
                </span>
              </div>
            )}
            initiallyOpen="first"
          />
        </section>
      ) : null}
    </div>
  );
}
