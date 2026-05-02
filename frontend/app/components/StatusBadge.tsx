"use client";

type StatusKind = "good" | "warn" | "bad" | "info" | "neutral" | "mute";

const PRESETS: Record<string, StatusKind> = {
  // Invoice statuses
  draft: "mute",
  sent: "info",
  viewed: "info",
  paid: "good",
  partial: "warn",
  overdue: "bad",
  void: "mute",
  voided: "mute",
  cancelled: "mute",
  canceled: "mute",
  unpaid: "warn",
  // Timesheet statuses
  unsubmitted: "mute",
  submitted: "info",
  approved: "good",
  returned: "bad",
  rejected: "bad",
  // Project / general
  active: "good",
  inactive: "mute",
  closed: "mute",
  completed: "info",
  paused: "warn",
  on_hold: "warn",
  "on hold": "warn",
  planning: "info",
  // Time entry billing status
  billable: "good",
  "non-billable": "mute",
  unbilled: "info",
  billed: "good",
};

function classifyStatus(status: string | null | undefined): StatusKind {
  if (!status) return "mute";
  const key = String(status).trim().toLowerCase();
  return PRESETS[key] ?? "neutral";
}

function prettify(status: string | null | undefined): string {
  if (!status) return "—";
  const s = String(status).trim();
  if (!s) return "—";
  // Replace underscores with spaces and capitalize first letter
  const spaced = s.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function StatusBadge({ status, kind, label }: { status?: string | null; kind?: StatusKind; label?: string }) {
  const k = kind ?? classifyStatus(status);
  const text = label ?? prettify(status);
  const cls =
    k === "good"
      ? "aq-lite-badge aq-lite-badge-good"
      : k === "warn"
        ? "aq-lite-badge aq-lite-badge-warn"
        : k === "bad"
          ? "aq-lite-badge aq-lite-badge-bad"
          : k === "info"
            ? "aq-lite-badge aq-lite-badge-info"
            : k === "neutral"
              ? "aq-lite-badge aq-lite-badge-neutral"
              : "aq-lite-badge aq-lite-badge-mute";
  return <span className={cls}>{text}</span>;
}
