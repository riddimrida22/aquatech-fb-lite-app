"use client";

import { useMemo, useState } from "react";

import { AdminTimesheet, Timesheet, formatDate, formatNumber } from "./workspaceShared";
import { StatusBadge } from "./StatusBadge";
import { GroupedList } from "./GroupedList";
import AdoptionTracker from "./AdoptionTracker";

type TimesheetsWorkspaceProps = {
  timesheets: Timesheet[];
  adminTimesheets: AdminTimesheet[];
  canApproveTimesheets: boolean;
  onGenerateTimesheet: (weekStart?: string) => Promise<void>;
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

  const sortedTimesheets = useMemo(
    () => timesheets.slice().sort((a, b) => b.week_start.localeCompare(a.week_start)),
    [timesheets],
  );
  const currentSheet = sortedTimesheets[0];
  // Roster is a dropdown (pick a week) instead of a long table — defaults to the newest.
  const [selectedTimesheetId, setSelectedTimesheetId] = useState<number | null>(null);
  // Any-week generator so future (or prior) weeks become submittable, not just the current one.
  const [genWeek, setGenWeek] = useState<string>("");
  const selectedSheet =
    timesheets.find((s) => s.id === selectedTimesheetId) ?? sortedTimesheets[0] ?? null;
  const adminCounts = {
    unsubmitted: adminTimesheets.filter((sheet) => sheet.status === "unsubmitted").length,
    draft: adminTimesheets.filter((sheet) => sheet.status === "draft" || sheet.status === "rejected").length,
    submitted: adminTimesheets.filter((sheet) => sheet.status === "submitted").length,
    approved: adminTimesheets.filter((sheet) => sheet.status === "approved").length,
  };

  // Admin employee + period selectors so the roster isn't one long list — the
  // admin picks any employee (incl. their own) and a pay period (defaults to the
  // most recent, so nothing shows until/unless a period is chosen).
  const employeeOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of adminTimesheets) m.set(s.user_id, s.user_full_name || s.user_email || `User ${s.user_id}`);
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [adminTimesheets]);
  const periodOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of adminTimesheets) {
      if (s.week_start) m.set(s.week_start, `${formatDate(s.week_start)} – ${formatDate(s.week_end)}`);
    }
    return Array.from(m, ([week_start, label]) => ({ week_start, label })).sort((a, b) => b.week_start.localeCompare(a.week_start));
  }, [adminTimesheets]);
  const [adminEmployee, setAdminEmployee] = useState<number | "all">("all");
  const [adminPeriod, setAdminPeriod] = useState<string>(""); // "" → resolves to latest period
  const effectivePeriod = adminPeriod || (periodOptions[0]?.week_start ?? "all");

  const visibleAdminTimesheets = useMemo(() => {
    let rows = adminTimesheets;
    if (adminStatusFilter === "draft") {
      rows = rows.filter((s) => s.status === "draft" || s.status === "rejected");
    } else if (adminStatusFilter !== "all") {
      rows = rows.filter((s) => s.status === adminStatusFilter);
    }
    if (adminEmployee !== "all") rows = rows.filter((s) => s.user_id === adminEmployee);
    if (effectivePeriod !== "all") rows = rows.filter((s) => s.week_start === effectivePeriod);
    return rows;
  }, [adminStatusFilter, adminTimesheets, adminEmployee, effectivePeriod]);

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
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <button type="button" onClick={() => void onGenerateTimesheet()} disabled={submitting === "timesheet-generate"}>
                {submitting === "timesheet-generate" ? "Generating…" : "Generate this week"}
              </button>
              <span style={{ color: "var(--aq-muted)", fontSize: 11 }}>or pick a week:</span>
              <input
                type="date"
                value={genWeek}
                onChange={(e) => setGenWeek(e.target.value)}
                title="Any date — snaps to that week's Monday"
                style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "var(--aq-input-bg,#fff)", color: "inherit", fontSize: 12 }}
              />
              <button
                type="button"
                onClick={() => void onGenerateTimesheet(genWeek || undefined)}
                disabled={!genWeek || submitting === "timesheet-generate"}
                style={{ background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }}
              >
                Generate that week
              </button>
            </div>
          </div>
          {timesheets.length === 0 ? (
            <p className="aq-lite-muted">No timesheets yet. Generate the current week to start.</p>
          ) : (
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 4 }}>
                Week
                <select
                  value={selectedSheet?.id ?? ""}
                  onChange={(e) => setSelectedTimesheetId(Number(e.target.value))}
                  style={{
                    display: "block",
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--aq-border,rgba(0,0,0,0.15))",
                    background: "var(--aq-input-bg,#fff)",
                    color: "inherit",
                  }}
                >
                  {sortedTimesheets.map((sheet) => (
                    <option key={sheet.id} value={sheet.id}>
                      {formatDate(sheet.week_start)} – {formatDate(sheet.week_end)} · {sheet.status} ·{" "}
                      {formatNumber(sheet.total_hours, 1)}h
                    </option>
                  ))}
                </select>
              </label>
              {selectedSheet ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: "1px solid var(--aq-border)",
                  }}
                >
                  <StatusBadge status={selectedSheet.status} />
                  <span style={{ fontWeight: 500 }}>{formatNumber(selectedSheet.total_hours, 1)}h</span>
                  <span style={{ marginLeft: "auto" }}>
                    {selectedSheet.status === "draft" || selectedSheet.status === "rejected" ? (
                      <button
                        type="button"
                        onClick={() => void onSubmitTimesheet(selectedSheet.id)}
                        disabled={submitting === `timesheet-${selectedSheet.id}`}
                      >
                        {submitting === `timesheet-${selectedSheet.id}` ? "Submitting…" : "Submit for approval"}
                      </button>
                    ) : (
                      <span className="aq-lite-muted">No action needed</span>
                    )}
                  </span>
                </div>
              ) : null}
            </div>
          )}
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

      {canApproveTimesheets ? <AdoptionTracker /> : null}

      {canApproveTimesheets ? (
        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Admin queue</p>
              <h3>All employee timesheets</h3>
            </div>
            <div className="aq-lite-toolbar">
              <select
                value={adminEmployee}
                onChange={(e) => setAdminEmployee(e.target.value === "all" ? "all" : Number(e.target.value))}
                title="Employee"
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "var(--aq-input-bg,#fff)", color: "inherit" }}
              >
                <option value="all">All employees</option>
                {employeeOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <select
                value={effectivePeriod}
                onChange={(e) => setAdminPeriod(e.target.value)}
                title="Pay period"
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "var(--aq-input-bg,#fff)", color: "inherit" }}
              >
                <option value="all">All periods</option>
                {periodOptions.map((o) => (
                  <option key={o.week_start} value={o.week_start}>{o.label}</option>
                ))}
              </select>
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
