"use client";

import { useEffect, useMemo, useState } from "react";

import { AdminTimesheet, formatDate, formatNumber } from "./workspaceShared";

const SEEN_KEY = "aqt-seen-submitted-timesheets";

// In-app "someone submitted a timesheet" alert for approvers. Email notifications
// exist server-side but SMTP is off in prod, so this dashboard popup is the live path.
// Tracks a per-(user,week) "seen" set in localStorage so it only nags on NEW submissions.
export function TimesheetSubmitAlert({
  adminTimesheets,
  onReview,
}: {
  adminTimesheets: AdminTimesheet[];
  onReview: () => void;
}) {
  const submitted = useMemo(
    () => adminTimesheets.filter((s) => s.status === "submitted"),
    [adminTimesheets],
  );
  const keyOf = (s: AdminTimesheet) => `${s.user_id}-${s.week_start}`;

  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      if (raw) setSeen(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  const fresh = useMemo(() => submitted.filter((s) => !seen.has(keyOf(s))), [submitted, seen]);

  if (!hydrated || fresh.length === 0) return null;

  const dismiss = () => {
    const next = new Set(seen);
    submitted.forEach((s) => next.add(keyOf(s)));
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(next)));
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="alert"
      className="aq-lite-panel"
      style={{
        borderLeft: "4px solid var(--aq-primary,#21737e)",
        background: "var(--aq-primary-soft,rgba(33,115,126,0.10))",
        marginBottom: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 22, lineHeight: "24px" }}>🔔</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>
            {fresh.length} timesheet{fresh.length === 1 ? "" : "s"} submitted for approval
          </strong>
          <div style={{ marginTop: 4, fontSize: 13, color: "var(--aq-muted)" }}>
            {fresh.slice(0, 5).map((s) => (
              <div key={keyOf(s)}>
                {s.user_full_name || s.user_email || `User ${s.user_id}`} — {formatDate(s.week_start)} →{" "}
                {formatDate(s.week_end)} · {formatNumber(s.total_hours, 1)}h
              </div>
            ))}
            {fresh.length > 5 ? <div>+{fresh.length - 5} more…</div> : null}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button type="button" onClick={onReview}>
            Review
          </button>
          <button
            type="button"
            onClick={dismiss}
            style={{
              background: "transparent",
              color: "var(--aq-primary-dark)",
              border: "1px solid var(--aq-border)",
              boxShadow: "none",
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
