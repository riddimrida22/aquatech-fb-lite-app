"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { API_BASE, apiDelete, apiGet, apiPost, apiPut } from "../lib/api";

const DEV_AUTH_ENABLED = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true";
const ENABLE_CLIENT_PAYMENT_LINKS = false;
const ALLOW_TIMESHEET_SUBMIT = false;

type User = {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  start_date: string | null;
  permissions: string[];
};

type Project = {
  id: number;
  name: string;
  client_name: string | null;
  pm_user_id: number | null;
  start_date: string | null;
  overall_budget_fee: number;
  target_gross_margin_pct: number;
  is_overhead: boolean;
  is_billable: boolean;
  is_active: boolean;
};

type Timesheet = {
  id: number;
  user_id: number;
  week_start: string;
  week_end: string;
  status: string;
  total_hours: number;
};

type AdminTimesheet = Timesheet & {
  user_email: string;
  user_full_name: string;
};

type TimeEntry = {
  id: number;
  user_id: number;
  project_id: number;
  task_id: number;
  subtask_id: number;
  user_email?: string | null;
  user_full_name?: string | null;
  project_name?: string | null;
  task_name?: string | null;
  subtask_code?: string | null;
  subtask_name?: string | null;
  work_date: string;
  hours: number;
  note: string;
  bill_rate_applied: number;
  cost_rate_applied: number;
};

type LatestRate = {
  user_id: number;
  effective_date: string;
  bill_rate: number;
  cost_rate: number;
};

type WbsSubtask = {
  id: number;
  code: string;
  name: string;
  budget_hours: number;
  budget_fee: number;
};

type WbsTask = {
  id: number;
  name: string;
  is_billable: boolean;
  subtasks: WbsSubtask[];
};

type ProjectWbs = {
  tasks: WbsTask[];
};

type TimeViewMode = "day" | "week" | "month";
type ReportPreset = "weekly" | "monthly" | "annual" | "custom";
type InvoicePeriodPreset = "custom" | "weekly" | "monthly" | "annual" | "last30";
type DashboardView = "dashboard" | "time" | "timesheets" | "projects" | "people" | "accounting";
type TimesheetSubView = "mine" | "team";
type ProjectSubView = "cockpit" | "editor" | "setup" | "performance";
type PeopleSubView = "profiles" | "pending";
type DashboardSubView = "overview";
type TimeSubView = "entry";
type AccountingSubView = "workspace";

type MetricRow = {
  hours: number;
  revenue: number;
  cost: number;
  profit: number;
};

type EmployeeMetric = MetricRow & {
  user_id: number;
  email: string;
  name: string;
};

type TaskMetric = MetricRow & {
  task_id: number;
  task_name: string;
};

type SubtaskMetric = MetricRow & {
  subtask_id: number;
  subtask_code: string;
  subtask_name: string;
};

type ProjectPerformance = {
  project_id: number;
  project_name: string;
  project_is_billable?: boolean;
  budget_hours: number;
  budget_fee: number;
  overall_budget_fee: number;
  target_gross_margin_pct: number;
  actual_hours: number;
  actual_revenue: number;
  actual_cost: number;
  expense_cost?: number;
  actual_profit: number;
  margin_pct: number;
  target_profit: number;
  target_profit_gap: number;
  target_margin_gap_pct: number;
  by_employee: EmployeeMetric[];
  by_task: TaskMetric[];
  by_subtask: SubtaskMetric[];
};
type ProjectExpense = {
  id: number;
  project_id: number;
  expense_date: string;
  category: string;
  description: string;
  amount: number;
};

type AdminSummaryMode = "weekly" | "monthly";
type PerformanceRange = { start: string; end: string; has_data: boolean };
type ReconciliationSnapshot = {
  users_total: number;
  active_users_total: number;
  projects_total: number;
  active_projects_total: number;
  tasks_total: number;
  subtasks_total: number;
  time_entries_total: number;
  rates_total: number;
};
type ReconciliationMonthlyRow = {
  period: string;
  entry_count: number;
  unique_users: number;
  unique_projects: number;
  unique_tasks: number;
  unique_subtasks: number;
  total_hours: number;
  bill_amount: number;
  cost_amount: number;
  profit_amount: number;
  orphan_user_refs: number;
  orphan_project_refs: number;
  orphan_task_refs: number;
  orphan_subtask_refs: number;
  zero_or_negative_rate_entries: number;
};
type ReconciliationReport = {
  start: string;
  end: string;
  snapshot: ReconciliationSnapshot;
  monthly: ReconciliationMonthlyRow[];
};
type InvoicePreviewLine = {
  user_id: number;
  project_id: number;
  task_id: number;
  subtask_id: number;
  work_date: string;
  employee: string;
  project: string;
  task: string;
  subtask: string;
  hours: number;
  bill_rate: number;
  cost_rate: number;
  amount: number;
  note: string;
  source_time_entry_id: number;
};
type InvoicePreview = {
  start: string;
  end: string;
  approved_only: boolean;
  project_id: number | null;
  client_name: string;
  line_count: number;
  total_hours: number;
  subtotal_amount: number;
  total_cost: number;
  total_profit: number;
  logo_url: string;
  lines: InvoicePreviewLine[];
};
type InvoiceLine = {
  id: number;
  user_id: number | null;
  project_id: number | null;
  task_id: number | null;
  subtask_id: number | null;
  work_date: string;
  employee: string;
  project: string;
  task: string;
  subtask: string;
  description: string;
  hours: number;
  bill_rate: number;
  cost_rate: number;
  amount: number;
  note: string;
  source_time_entry_id: number | null;
};
type InvoiceRecord = {
  id: number;
  invoice_number: string;
  status: string;
  source: string;
  project_id: number | null;
  client_name: string;
  start_date: string;
  end_date: string;
  issue_date: string;
  due_date: string;
  subtotal_amount: number;
  amount_paid: number;
  balance_due: number;
  total_cost: number;
  total_profit: number;
  payment_link_enabled?: boolean;
  payment_link_expires_at?: string | null;
  payment_link_url?: string | null;
  paid_date: string | null;
  notes: string;
  logo_url: string;
  line_count: number;
  lines: InvoiceLine[];
};
type InvoiceTaskSummaryRow = {
  task: string;
  previously_billed: number;
  this_invoice: number;
  billed_to_date: number;
  contract_maximum: number;
  contract_balance_remaining: number;
  pct_complete_this_invoice: number;
  pct_complete_to_date: number;
};
type InvoiceAppendixEntry = {
  time_entry_id: number;
  work_date: string;
  project: string;
  task: string;
  subtask: string;
  note: string;
  hours: number;
  is_invoiced: boolean;
};
type InvoiceAppendixWeek = {
  user_id: number;
  employee: string;
  email: string;
  week_start: string;
  week_end: string;
  total_hours: number;
  invoiced_hours: number;
  entries: InvoiceAppendixEntry[];
};
type InvoiceRenderContext = {
  invoice_id: number;
  invoice_number: string;
  summary_rows: InvoiceTaskSummaryRow[];
  appendix_weeks: InvoiceAppendixWeek[];
};
type InvoicePaymentLink = {
  invoice_id: number;
  invoice_number: string;
  payment_link_url: string;
  token: string;
  expires_at: string;
  enabled: boolean;
};
type LegacyInvoiceImportRow = {
  row_number: number;
  invoice_number: string;
  client_name: string;
  issue_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  amount_paid: number | null;
  balance_due: number | null;
  status: string;
  reason: string | null;
};
type LegacyInvoiceImportResult = {
  apply: boolean;
  count: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: LegacyInvoiceImportRow[];
};
type ArClientRow = {
  client_name: string;
  invoice_count: number;
  outstanding: number;
  overdue: number;
};
type ArSummary = {
  as_of: string;
  invoice_count_open: number;
  total_outstanding: number;
  overdue_invoice_count: number;
  overdue_total: number;
  aging: {
    current: number;
    "1_30": number;
    "31_60": number;
    "61_90": number;
    "90_plus": number;
  };
  top_clients: ArClientRow[];
};
type RecurringInvoiceSchedule = {
  id: number;
  name: string;
  project_id: number | null;
  cadence: "weekly" | "monthly";
  approved_only: boolean;
  due_days: number;
  next_run_date: string;
  last_run_date: string | null;
  auto_send_email: boolean;
  recipient_email: string;
  notes_template: string;
  is_active: boolean;
  created_at: string;
};
type RecurringInvoiceRunResult = {
  run_date: string;
  schedules_considered: number;
  invoices_created: number;
  skipped_no_billable_entries: number;
  skipped_existing_for_period: number;
  errors: number;
  invoice_ids: number[];
};
type ReapplyRatesResult = {
  ok: boolean;
  start: string;
  end: string;
  user_id: number | null;
  entry_count: number;
  updated: number;
  unchanged: number;
  skipped_no_rate: number;
};

function parseYmdUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function datesInRange(start: string, end: string): string[] {
  const result: string[] = [];
  let cursor = parseYmdUtc(start);
  const endDate = parseYmdUtc(end);
  while (cursor.getTime() <= endDate.getTime()) {
    result.push(formatYmdUtc(cursor));
    cursor = addDaysUtc(cursor, 1);
  }
  return result;
}

function monthGridDates(anchorDate: string): (string | null)[] {
  const anchor = parseYmdUtc(anchorDate);
  const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  const startWeekday = monthStart.getUTCDay();
  const mondayOffset = (startWeekday + 6) % 7;
  const grid: (string | null)[] = [];
  for (let i = 0; i < mondayOffset; i++) {
    grid.push(null);
  }
  let cursor = monthStart;
  while (cursor.getTime() <= monthEnd.getTime()) {
    grid.push(formatYmdUtc(cursor));
    cursor = addDaysUtc(cursor, 1);
  }
  while (grid.length % 7 !== 0) {
    grid.push(null);
  }
  return grid;
}

function rangeFor(mode: TimeViewMode, anchorDate: string): { start: string; end: string; label: string } {
  const anchor = parseYmdUtc(anchorDate);
  if (mode === "day") {
    const day = formatYmdUtc(anchor);
    return { start: day, end: day, label: day };
  }
  if (mode === "week") {
    const weekday = anchor.getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const weekStart = addDaysUtc(anchor, -mondayOffset);
    const weekEnd = addDaysUtc(weekStart, 6);
    return { start: formatYmdUtc(weekStart), end: formatYmdUtc(weekEnd), label: `${formatYmdUtc(weekStart)} to ${formatYmdUtc(weekEnd)}` };
  }
  const monthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0));
  return { start: formatYmdUtc(monthStart), end: formatYmdUtc(monthEnd), label: `${formatYmdUtc(monthStart)} to ${formatYmdUtc(monthEnd)}` };
}

function weekStartForYmd(ymd: string): string {
  const d = parseYmdUtc(ymd);
  const weekday = d.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return formatYmdUtc(addDaysUtc(d, -mondayOffset));
}

function dayLabelFromYmd(ymd: string): string {
  const d = parseYmdUtc(ymd);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function monthDayLabel(ymd: string): string {
  const d = parseYmdUtc(ymd);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function weekRangeLabel(days: (string | null)[]): string {
  const filled = days.filter(Boolean) as string[];
  if (filled.length === 0) return "—";
  const first = filled[0];
  const last = filled[filled.length - 1];
  const firstMonth = first.slice(0, 7);
  const lastMonth = last.slice(0, 7);
  if (firstMonth === lastMonth) {
    return `${monthDayLabel(first)} - ${last.slice(8, 10)}`;
  }
  return `${monthDayLabel(first)} - ${monthDayLabel(last)}`;
}

function presetRange(preset: ReportPreset, todayYmd: string): { start: string; end: string } {
  const today = parseYmdUtc(todayYmd);
  if (preset === "weekly") {
    const weekday = today.getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const start = addDaysUtc(today, -mondayOffset);
    const end = addDaysUtc(start, 6);
    return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
  }
  if (preset === "monthly") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
  }
  if (preset === "annual") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
    return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
  }
  return { start: todayYmd, end: todayYmd };
}

function invoicePresetRange(preset: InvoicePeriodPreset, todayYmd: string): { start: string; end: string } {
  if (preset === "weekly" || preset === "monthly" || preset === "annual") {
    return presetRange(preset, todayYmd);
  }
  if (preset === "last30") {
    const end = parseYmdUtc(todayYmd);
    const start = addDaysUtc(end, -29);
    return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
  }
  return { start: todayYmd, end: todayYmd };
}

function parseRateInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatCurrency(value: number, minimumFractionDigits = 2): string {
  const normalized = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(normalized);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits: minimumFractionDigits,
  });
  return normalized < 0 ? `($${formatted})` : `$${formatted}`;
}

function moneyTextStyle(value: number): { color?: string; fontVariantNumeric: "tabular-nums" } {
  if (value < 0) return { color: "#b00020", fontVariantNumeric: "tabular-nums" };
  return { fontVariantNumeric: "tabular-nums" };
}

function Currency({ value, digits = 2 }: { value: number; digits?: number }) {
  return <span style={moneyTextStyle(value)}>{formatCurrency(value, digits)}</span>;
}

function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

function isPlaceholderProjectName(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  if (!n) return true;
  return n.includes("placeholder") || /^project[\s-]*\d+$/.test(n);
}

function isHiddenProjectName(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  return n === "no project" || n === "imported project";
}

function daysBetweenInclusive(startYmd: string, endYmd: string): number {
  if (!isValidYmd(startYmd) || !isValidYmd(endYmd)) return 0;
  const start = parseYmdUtc(startYmd);
  const end = parseYmdUtc(endYmd);
  const diffMs = end.getTime() - start.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
}

function showNativeDatePicker(input: HTMLInputElement): void {
  const picker = (input as HTMLInputElement & { showPicker?: () => void }).showPicker;
  if (typeof picker === "function") {
    try {
      picker.call(input);
    } catch {
      // Some browsers block showPicker unless triggered by specific user gestures.
    }
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type InvoiceTemplateId = "default" | "stantec_bc" | "hdr";

type InvoiceTemplateMeta = {
  id: InvoiceTemplateId;
  label: string;
  billToLines: string[];
  periodLabel: string;
  references: Array<{ label: string; value: string }>;
};

const OVERHEAD_RATE = 1.14;
const PROFIT_RATE = 0.1;

function isProfitExemptEmployee(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  return n.includes("bertrand byrne");
}

type InvoiceTaskMath = {
  task: string;
  staffRows: Array<{ employee: string; hours: number; directRate: number; amount: number }>;
  principalRows: Array<{ employee: string; hours: number; billRate: number; amount: number }>;
  staffDirect: number;
  staffOverhead: number;
  staffProfit: number;
  staffSubtotal: number;
  principalAmount: number;
  principalOverhead: number;
  principalSubtotal: number;
  totalLabor: number;
};

function buildInvoiceTaskMath(lines: InvoiceLine[]): InvoiceTaskMath[] {
  const byTask = new Map<string, InvoiceLine[]>();
  for (const l of lines) {
    const key = l.task || "Task";
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key)!.push(l);
  }
  const out: InvoiceTaskMath[] = [];
  for (const [task, taskLines] of Array.from(byTask.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const staffMap = new Map<string, { hours: number; amount: number }>();
    const principalMap = new Map<string, { hours: number; amount: number }>();
    for (const l of taskLines) {
      const emp = l.employee || "Unassigned";
      const h = Number(l.hours || 0);
      if (isProfitExemptEmployee(emp)) {
        const cur = principalMap.get(emp) || { hours: 0, amount: 0 };
        cur.hours += h;
        cur.amount += Number(l.amount || 0);
        principalMap.set(emp, cur);
      } else {
        const cur = staffMap.get(emp) || { hours: 0, amount: 0 };
        cur.hours += h;
        cur.amount += h * Number(l.cost_rate || 0);
        staffMap.set(emp, cur);
      }
    }
    const staffRows = Array.from(staffMap.entries()).map(([employee, v]) => ({
      employee,
      hours: v.hours,
      directRate: v.hours > 0 ? v.amount / v.hours : 0,
      amount: v.amount,
    }));
    const principalRows = Array.from(principalMap.entries()).map(([employee, v]) => ({
      employee,
      hours: v.hours,
      billRate: v.hours > 0 ? v.amount / v.hours : 0,
      amount: v.amount,
    }));
    const staffDirect = staffRows.reduce((s, r) => s + r.amount, 0);
    const staffOverhead = staffDirect * OVERHEAD_RATE;
    const staffProfit = (staffDirect + staffOverhead) * PROFIT_RATE;
    const staffSubtotal = staffDirect + staffOverhead + staffProfit;
    const principalAmount = principalRows.reduce((s, r) => s + r.amount, 0);
    const principalOverhead = principalAmount * OVERHEAD_RATE;
    const principalSubtotal = principalAmount + principalOverhead;
    out.push({
      task,
      staffRows,
      principalRows,
      staffDirect,
      staffOverhead,
      staffProfit,
      staffSubtotal,
      principalAmount,
      principalOverhead,
      principalSubtotal,
      totalLabor: staffSubtotal + principalSubtotal,
    });
  }
  return out;
}

function detectInvoiceTemplate(inv: InvoiceRecord): InvoiceTemplateId {
  const sampleProject = inv.lines.length > 0 ? inv.lines[0].project || "" : "";
  const haystack = `${inv.client_name || ""} ${sampleProject} ${inv.invoice_number || ""}`.toLowerCase();
  if (haystack.includes("hdr") || haystack.includes("henningson") || haystack.includes("durham")) return "hdr";
  if (haystack.includes("stantec") || haystack.includes("brown") || haystack.includes("caldwell") || haystack.includes("sbc")) {
    return "stantec_bc";
  }
  return "default";
}

function invoiceTemplateMeta(inv: InvoiceRecord): InvoiceTemplateMeta {
  const id = detectInvoiceTemplate(inv);
  if (id === "hdr") {
    return {
      id,
      label: "HDR",
      billToLines: [
        "Henningson, Durham & Richardson Architecture and Engineering, P.C.",
        "500 Seventh Avenue, 15th Floor",
        "New York, NY 10018-4502",
        "Attention: Timothy Groninger",
      ],
      periodLabel: "Support Services for the Period",
      references: [
        { label: "Purchase Order#", value: "PO# 1000100113624" },
        { label: "Contract ID", value: "CSO-LTCP04: Combined Sewer Overflow Long Term Control Plan-04" },
        { label: "Contract Reg No.", value: "CT 826 20258800169" },
      ],
    };
  }
  if (id === "stantec_bc") {
    return {
      id,
      label: "Stantec + Brown & Caldwell",
      billToLines: [
        "Melissa Carter, Project Manager",
        "Stantec/Brown and Caldwell",
        "475 Fifth Avenue, 12th Floor, New York, NY 10017",
      ],
      periodLabel: "Support Services for the Period",
      references: [
        { label: "Contract ID", value: "BWT Citywide Regulatory Program Assistance, 1539-REG" },
        { label: "Contract Reg No.", value: "Assignment 014 (ASGMT-014)" },
      ],
    };
  }
  return {
    id: "default",
    label: "Standard",
    billToLines: [inv.client_name || "Aquatech Client"],
    periodLabel: "Period",
    references: [],
  };
}

function timesheetStatusStyle(status: string): { background: string; color: string; border: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "approved") return { background: "#e9f8ee", color: "#0f6b2f", border: "1px solid #b9e5c6" };
  if (normalized === "submitted") return { background: "#fff5e8", color: "#9a5a00", border: "1px solid #f1d2a7" };
  if (normalized === "rejected") return { background: "#ffeef0", color: "#9b1c2f", border: "1px solid #f4bcc4" };
  return { background: "#f2f4f7", color: "#394150", border: "1px solid #d9dee7" };
}

function invoiceStatusStyle(status: string): { background: string; color: string; border: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "paid") return { background: "#e9f8ee", color: "#0f6b2f", border: "1px solid #b9e5c6" };
  if (normalized === "partial") return { background: "#fff5e8", color: "#9a5a00", border: "1px solid #f1d2a7" };
  if (normalized === "sent") return { background: "#eef5ff", color: "#13427a", border: "1px solid #c7daf8" };
  if (normalized === "void") return { background: "#f1f3f5", color: "#555", border: "1px solid #d7dce2" };
  if (normalized === "draft") return { background: "#f7f6ee", color: "#6b5a00", border: "1px solid #e4d9a4" };
  return { background: "#f2f4f7", color: "#394150", border: "1px solid #d9dee7" };
}

export default function Home() {
  const [me, setMe] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [adminTimesheets, setAdminTimesheets] = useState<AdminTimesheet[]>([]);
  const [projectPerformance, setProjectPerformance] = useState<ProjectPerformance[]>([]);
  const [message, setMessage] = useState<string>("");

  const [bootstrapEmail, setBootstrapEmail] = useState("admin@aquatechpc.com");
  const [bootstrapName, setBootstrapName] = useState("Aquatech Admin");
  const [loginEmail, setLoginEmail] = useState("admin@aquatechpc.com");

  const [projectName, setProjectName] = useState("Demo Project");
  const [projectClient, setProjectClient] = useState("Aquatech Client");
  const [projectStartDate, setProjectStartDate] = useState("");
  const [projectOverallBudget, setProjectOverallBudget] = useState("50000");
  const [projectTargetMargin, setProjectTargetMargin] = useState("35");
  const [projectIsBillable, setProjectIsBillable] = useState(true);
  const [projectPmUserId, setProjectPmUserId] = useState<number | null>(null);
  const [taskName, setTaskName] = useState("Design");
  const [subtaskName, setSubtaskName] = useState("Hydraulic Analysis");
  const [subtaskCode, setSubtaskCode] = useState("DES-01");

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedSubtaskId, setSelectedSubtaskId] = useState<number | null>(null);
  const [entryDate, setEntryDate] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [entryProjectId, setEntryProjectId] = useState<number | null>(null);
  const [entryTaskId, setEntryTaskId] = useState<number | null>(null);
  const [entrySubtaskId, setEntrySubtaskId] = useState<number | null>(null);
  const [entryHours, setEntryHours] = useState("8");
  const [entryNote, setEntryNote] = useState("");
  const [wbsByProject, setWbsByProject] = useState<Record<number, WbsTask[]>>({});
  const [timeViewMode, setTimeViewMode] = useState<TimeViewMode>("week");
  const [timeAnchorDate, setTimeAnchorDate] = useState(new Date().toISOString().slice(0, 10));
  const [monthWeekIndex, setMonthWeekIndex] = useState(0);
  const [timeFilterUserId, setTimeFilterUserId] = useState<number | null>(null);
  const [timeFilterProjectId, setTimeFilterProjectId] = useState<number | null>(null);
  const [timeFilterTaskId, setTimeFilterTaskId] = useState<number | null>(null);
  const [timeFilterSubtaskId, setTimeFilterSubtaskId] = useState<number | null>(null);
  const [rateBill, setRateBill] = useState("220");
  const [rateCost, setRateCost] = useState("90");
  const [rateDate, setRateDate] = useState(new Date().toISOString().slice(0, 10));
  const [staffRateUserId, setStaffRateUserId] = useState<number | null>(null);
  const [staffRateBill, setStaffRateBill] = useState("220");
  const [staffRateCost, setStaffRateCost] = useState("90");
  const [staffRateDate, setStaffRateDate] = useState(new Date().toISOString().slice(0, 10));
  const [latestRates, setLatestRates] = useState<Record<number, LatestRate>>({});
  const [rateDrafts, setRateDrafts] = useState<Record<number, { effective_date: string; bill_rate: string; cost_rate: string }>>({});
  const [timesheetStatusFilter, setTimesheetStatusFilter] = useState("");
  const [myTimesheetPeriodFilter, setMyTimesheetPeriodFilter] = useState("");
  const [timesheetUserFilter, setTimesheetUserFilter] = useState<number | null>(null);
  const [timesheetPeriodFilter, setTimesheetPeriodFilter] = useState("");
  const todayYmd = new Date().toISOString().slice(0, 10);
  const [reapplyRateStart, setReapplyRateStart] = useState(`${todayYmd.slice(0, 4)}-01-01`);
  const [reapplyRateEnd, setReapplyRateEnd] = useState(`${todayYmd.slice(0, 4)}-12-31`);
  const [reportPreset, setReportPreset] = useState<ReportPreset>("custom");
  const [activeView, setActiveView] = useState<DashboardView>("dashboard");
  const [dashboardSubView, setDashboardSubView] = useState<DashboardSubView>("overview");
  const [timeSubView, setTimeSubView] = useState<TimeSubView>("entry");
  const [timesheetSubView, setTimesheetSubView] = useState<TimesheetSubView>("mine");
  const [projectSubView, setProjectSubView] = useState<ProjectSubView>("cockpit");
  const [peopleSubView, setPeopleSubView] = useState<PeopleSubView>("profiles");
  const [accountingSubView, setAccountingSubView] = useState<AccountingSubView>("workspace");
  const [projectEditorProjectId, setProjectEditorProjectId] = useState<number | null>(null);
  const [peopleEditorUserId, setPeopleEditorUserId] = useState<number | null>(null);
  const [performanceProjectId, setPerformanceProjectId] = useState<number | null>(null);
  const [performanceExpanded, setPerformanceExpanded] = useState<Record<string, boolean>>({});
  const [dashboardExpandedProjects, setDashboardExpandedProjects] = useState<Record<number, boolean>>({});
  const [reportStart, setReportStart] = useState(todayYmd);
  const [reportEnd, setReportEnd] = useState(todayYmd);
  const [reportRangeInitialized, setReportRangeInitialized] = useState(false);
  const [reconciliationSnapshot, setReconciliationSnapshot] = useState<ReconciliationSnapshot | null>(null);
  const [reconciliationMonthly, setReconciliationMonthly] = useState<ReconciliationMonthlyRow[]>([]);
  const [invoiceStart, setInvoiceStart] = useState(`${todayYmd.slice(0, 4)}-01-01`);
  const [invoiceEnd, setInvoiceEnd] = useState(todayYmd);
  const [invoicePeriodPreset, setInvoicePeriodPreset] = useState<InvoicePeriodPreset>("custom");
  const [invoiceProjectId, setInvoiceProjectId] = useState<number | null>(null);
  const [invoiceApprovedOnly, setInvoiceApprovedOnly] = useState(true);
  const [invoicePreview, setInvoicePreview] = useState<InvoicePreview | null>(null);
  const [savedInvoices, setSavedInvoices] = useState<InvoiceRecord[]>([]);
  const [invoiceDetail, setInvoiceDetail] = useState<InvoiceRecord | null>(null);
  const [invoiceRenderContext, setInvoiceRenderContext] = useState<InvoiceRenderContext | null>(null);
  const [invoiceSelectedId, setInvoiceSelectedId] = useState<number | null>(null);
  const [invoiceViewerOpen, setInvoiceViewerOpen] = useState(false);
  const [paymentLinkDays, setPaymentLinkDays] = useState("14");
  const [generatedPaymentLink, setGeneratedPaymentLink] = useState<string>("");
  const [invoiceNotes, setInvoiceNotes] = useState("");
  const [invoicePaidAmount, setInvoicePaidAmount] = useState("0");
  const [invoicePaidDate, setInvoicePaidDate] = useState("");
  const [invoiceStatusDraft, setInvoiceStatusDraft] = useState("sent");
  const [recurringSchedules, setRecurringSchedules] = useState<RecurringInvoiceSchedule[]>([]);
  const [recurringName, setRecurringName] = useState("Monthly Project Invoice");
  const [recurringProjectId, setRecurringProjectId] = useState<number | null>(null);
  const [recurringCadence, setRecurringCadence] = useState<"weekly" | "monthly">("monthly");
  const [recurringApprovedOnly, setRecurringApprovedOnly] = useState(true);
  const [recurringDueDays, setRecurringDueDays] = useState("30");
  const [recurringNextRunDate, setRecurringNextRunDate] = useState(todayYmd);
  const [recurringAutoSendEmail, setRecurringAutoSendEmail] = useState(false);
  const [recurringRecipientEmail, setRecurringRecipientEmail] = useState("");
  const [recurringNotesTemplate, setRecurringNotesTemplate] = useState("");
  const [legacyInvoiceFile, setLegacyInvoiceFile] = useState<File | null>(null);
  const [legacyInvoiceApply, setLegacyInvoiceApply] = useState(false);
  const [legacyInvoiceSummary, setLegacyInvoiceSummary] = useState("");
  const [legacyInvoiceMappingJson, setLegacyInvoiceMappingJson] = useState(
    '{\n  "invoice_number": ["Invoice #", "Invoice Number"],\n  "client_name": ["Client"],\n  "issue_date": ["Invoice Date"],\n  "due_date": ["Due Date"],\n  "status": ["Status"],\n  "total_amount": ["Total"],\n  "amount_paid": ["Paid"],\n  "balance_due": ["Balance"]\n}',
  );
  const [arSummary, setArSummary] = useState<ArSummary | null>(null);
  const initAdminRange = useMemo(() => presetRange("weekly", todayYmd), [todayYmd]);
  const [adminEntryUserId, setAdminEntryUserId] = useState<number | null>(null);
  const [adminEntryStart, setAdminEntryStart] = useState(initAdminRange.start);
  const [adminEntryEnd, setAdminEntryEnd] = useState(initAdminRange.end);
  const [adminEntryProjectId, setAdminEntryProjectId] = useState<number | null>(null);
  const [adminEntryTaskId, setAdminEntryTaskId] = useState<number | null>(null);
  const [adminEntrySubtaskId, setAdminEntrySubtaskId] = useState<number | null>(null);
  const [adminEntryRows, setAdminEntryRows] = useState<TimeEntry[]>([]);
  const [adminExpandedDays, setAdminExpandedDays] = useState<Record<string, boolean>>({});
  const [adminSummaryMode, setAdminSummaryMode] = useState<AdminSummaryMode>("weekly");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importApply, setImportApply] = useState(false);
  const [importSummary, setImportSummary] = useState<string>("");
  const [importMappingJson, setImportMappingJson] = useState(
    '{\n  "date": ["Date"],\n  "employee": ["Team Member"],\n  "project": ["Project"],\n  "task": ["Service"],\n  "hours": ["Hours"],\n  "note": ["Note"],\n  "status": ["Approval Status", "Status"]\n}',
  );
  const [projectDrafts, setProjectDrafts] = useState<
    Record<
      number,
      {
        name: string;
        client_name: string;
        pm_user_id: string;
        start_date: string;
        overall_budget_fee: string;
        target_gross_margin_pct: string;
        is_overhead: boolean;
        is_billable: boolean;
        is_active: boolean;
      }
    >
  >({});
  const [peopleDrafts, setPeopleDrafts] = useState<
    Record<number, { full_name: string; start_date: string; role: string; is_active: boolean }>
  >({});
  const [taskDrafts, setTaskDrafts] = useState<Record<number, { name: string; is_billable: boolean }>>({});
  const [subtaskDrafts, setSubtaskDrafts] = useState<
    Record<number, { code: string; name: string; budget_hours: string; budget_fee: string }>
  >({});
  const [projectExpenses, setProjectExpenses] = useState<Record<number, ProjectExpense[]>>({});
  const [expenseDate, setExpenseDate] = useState(todayYmd);
  const [expenseCategory, setExpenseCategory] = useState("General");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("0");

  const canManageUsers = useMemo(() => me?.permissions.includes("MANAGE_USERS"), [me]);
  const canManageProjects = useMemo(() => me?.permissions.includes("MANAGE_PROJECTS"), [me]);
  const canManageRates = useMemo(() => me?.permissions.includes("MANAGE_RATES"), [me]);
  const canApproveTimesheets = useMemo(() => me?.permissions.includes("APPROVE_TIMESHEETS"), [me]);
  const canViewFinancials = useMemo(() => me?.permissions.includes("VIEW_FINANCIALS"), [me]);
  const currentRange = useMemo(() => rangeFor(timeViewMode, timeAnchorDate), [timeViewMode, timeAnchorDate]);
  const visibleDates = useMemo(() => datesInRange(currentRange.start, currentRange.end), [currentRange.start, currentRange.end]);
  const monthWeekRanges = useMemo(() => {
    if (timeViewMode !== "month") return [] as string[][];
    const chunks: string[][] = [];
    for (let i = 0; i < visibleDates.length; i += 7) {
      chunks.push(visibleDates.slice(i, i + 7));
    }
    return chunks;
  }, [timeViewMode, visibleDates]);
  const displayedGridDates = useMemo(() => {
    if (timeViewMode !== "month") return visibleDates;
    return monthWeekRanges[monthWeekIndex] || monthWeekRanges[0] || [];
  }, [monthWeekIndex, monthWeekRanges, timeViewMode, visibleDates]);
  const displayedGridLabel = useMemo(() => {
    if (timeViewMode !== "month") return currentRange.label;
    const slice = displayedGridDates;
    if (slice.length === 0) return currentRange.label;
    return `${slice[0]} to ${slice[slice.length - 1]} (week ${monthWeekIndex + 1} of ${monthWeekRanges.length})`;
  }, [currentRange.label, displayedGridDates, monthWeekIndex, monthWeekRanges.length, timeViewMode]);
  const monthGrid = useMemo(() => monthGridDates(timeAnchorDate), [timeAnchorDate]);
  const monthWeeks = useMemo(() => {
    const out: (string | null)[][] = [];
    for (let i = 0; i < monthGrid.length; i += 7) {
      out.push(monthGrid.slice(i, i + 7));
    }
    return out;
  }, [monthGrid]);
  const dailyHours = useMemo(() => {
    const hours: Record<string, number> = {};
    for (const entry of timeEntries) {
      hours[entry.work_date] = (hours[entry.work_date] || 0) + Number(entry.hours || 0);
    }
    return hours;
  }, [timeEntries]);
  const selectedDayEntries = useMemo(
    () => (entryDate ? timeEntries.filter((t) => t.work_date === entryDate) : []),
    [entryDate, timeEntries],
  );
  const monthTotalHours = useMemo(
    () =>
      visibleDates.reduce((sum, day) => {
        return sum + Number(dailyHours[day] || 0);
      }, 0),
    [visibleDates, dailyHours],
  );
  const timeGridRows = useMemo(() => {
    const grouped: Record<
      string,
      {
        key: string;
        projectLabel: string;
        taskLabel: string;
        subtaskLabel: string;
        byDay: Record<string, number>;
        byDayNotes: Record<string, string[]>;
        total: number;
      }
    > = {};
    for (const entry of timeEntries) {
      const key = `${entry.project_id}|${entry.task_id}|${entry.subtask_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          key,
          projectLabel: entry.project_name || `Project ${entry.project_id}`,
          taskLabel: entry.task_name || `Task ${entry.task_id}`,
          subtaskLabel: entry.subtask_code
            ? `${entry.subtask_code}${entry.subtask_name ? ` - ${entry.subtask_name}` : ""}`
            : entry.subtask_name || `Subtask ${entry.subtask_id}`,
          byDay: {},
          byDayNotes: {},
          total: 0,
        };
      }
      const hours = Number(entry.hours || 0);
      grouped[key].byDay[entry.work_date] = (grouped[key].byDay[entry.work_date] || 0) + hours;
      const trimmedNote = (entry.note || "").trim();
      if (trimmedNote) {
        grouped[key].byDayNotes[entry.work_date] = grouped[key].byDayNotes[entry.work_date] || [];
        grouped[key].byDayNotes[entry.work_date].push(trimmedNote);
      }
      grouped[key].total += hours;
    }
    return Object.values(grouped).sort((a, b) => a.projectLabel.localeCompare(b.projectLabel) || a.taskLabel.localeCompare(b.taskLabel));
  }, [timeEntries]);
  const timeGridDayTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const day of displayedGridDates) totals[day] = 0;
    for (const row of timeGridRows) {
      for (const day of displayedGridDates) {
        totals[day] += Number(row.byDay[day] || 0);
      }
    }
    return totals;
  }, [displayedGridDates, timeGridRows]);
  const dashboardProjectPerformance = useMemo(
    () => projectPerformance.filter((p) => !isPlaceholderProjectName(p.project_name)),
    [projectPerformance],
  );
  const dashboardKpiContextLabel = useMemo(() => {
    if (reportPreset === "weekly") return `Weekly period (${reportStart} to ${reportEnd})`;
    if (reportPreset === "monthly") return `Monthly period (${reportStart} to ${reportEnd})`;
    if (reportPreset === "annual") return `Annual period (${reportStart} to ${reportEnd})`;
    return `Custom period (${reportStart} to ${reportEnd})`;
  }, [reportEnd, reportPreset, reportStart]);
  const dashboardStats = useMemo(() => {
    const totals = dashboardProjectPerformance.reduce(
      (acc, p) => {
        acc.budget += p.overall_budget_fee || p.budget_fee || 0;
        acc.revenue += p.actual_revenue || 0;
        acc.cost += p.actual_cost || 0;
        acc.profit += p.actual_profit || 0;
        return acc;
      },
      { budget: 0, revenue: 0, cost: 0, profit: 0 },
    );
    const submittedCount = adminTimesheets.filter((t) => t.status === "submitted").length;
    return { ...totals, submittedCount, pendingUsers: pendingUsers.length };
  }, [dashboardProjectPerformance, adminTimesheets, pendingUsers]);
  const activeUsers = useMemo(() => allUsers.filter((u) => u.is_active), [allUsers]);
  const performanceByProjectId = useMemo(() => {
    const map: Record<number, ProjectPerformance> = {};
    for (const p of projectPerformance) map[p.project_id] = p;
    return map;
  }, [projectPerformance]);
  const projectCockpitRows = useMemo(() => {
    const pmById = new Map(allUsers.map((u) => [u.id, u]));
    return projects
      .filter((p) => p.is_active)
      .map((p) => {
        const perf = performanceByProjectId[p.id] || null;
        const margin = perf ? perf.margin_pct : null;
        const profit = perf ? perf.actual_profit : null;
        const onTarget = perf ? perf.target_margin_gap_pct >= 0 && perf.actual_profit >= 0 : null;
        const pm = (p.pm_user_id ? pmById.get(p.pm_user_id) : null) || null;
        return {
          id: p.id,
          name: p.name,
          client: p.client_name || "-",
          pm: pm ? (pm.full_name || pm.email) : me?.email || "-",
          isBillable: p.is_billable,
          budget: p.overall_budget_fee || 0,
          revenue: perf ? perf.actual_revenue : 0,
          cost: perf ? perf.actual_cost : 0,
          profit,
          margin,
          status: !p.is_billable ? "Non-billable (cost only)" : onTarget === null ? "No financial data yet" : onTarget ? "On Target" : "At Risk",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, performanceByProjectId, allUsers, me?.email]);
  const selectedPerformanceProject = useMemo(
    () => (performanceProjectId ? performanceByProjectId[performanceProjectId] || null : null),
    [performanceProjectId, performanceByProjectId],
  );
  const selectedPeopleUser = useMemo(
    () => (peopleEditorUserId ? allUsers.find((u) => u.id === peopleEditorUserId) || null : null),
    [peopleEditorUserId, allUsers],
  );
  const selectedInvoice = useMemo(
    () => (invoiceDetail && invoiceSelectedId === invoiceDetail.id ? invoiceDetail : (invoiceSelectedId ? savedInvoices.find((inv) => inv.id === invoiceSelectedId) || null : null)),
    [invoiceSelectedId, savedInvoices, invoiceDetail],
  );
  const pmUserOptions = useMemo(() => {
    if (activeUsers.length > 0) return activeUsers;
    return me ? [me] : [];
  }, [activeUsers, me]);
  const maxAchievableMarginPct = useMemo(() => {
    const rates = Object.values(latestRates);
    if (rates.length === 0) return null;
    let max = 0;
    for (const r of rates) {
      if (r.bill_rate > 0) {
        const m = ((r.bill_rate - r.cost_rate) / r.bill_rate) * 100;
        if (m > max) max = m;
      }
    }
    return Number.isFinite(max) ? max : null;
  }, [latestRates]);
  const dashboardAtRiskProjects = useMemo(
    () =>
      [...dashboardProjectPerformance]
        .filter((p) => (p.project_is_billable ?? true) && (p.target_margin_gap_pct < 0 || p.actual_profit < 0))
        .sort((a, b) => a.target_margin_gap_pct - b.target_margin_gap_pct),
    [dashboardProjectPerformance],
  );
  const dashboardUsersWithoutRates = useMemo(() => {
    const rateUserIds = new Set(Object.keys(latestRates).map((v) => Number(v)));
    return activeUsers.filter((u) => !rateUserIds.has(u.id));
  }, [activeUsers, latestRates]);
  const dashboardMissingTimesheets = useMemo(() => {
    if (!canApproveTimesheets) return [];
    const present = new Set(adminTimesheets.map((t) => t.user_id));
    return activeUsers.filter((u) => !present.has(u.id));
  }, [activeUsers, adminTimesheets, canApproveTimesheets]);
  const adminEntriesByDay = useMemo(() => {
    const grouped: Record<string, TimeEntry[]> = {};
    for (const row of adminEntryRows) {
      grouped[row.work_date] = grouped[row.work_date] || [];
      grouped[row.work_date].push(row);
    }
    return Object.keys(grouped)
      .sort()
      .map((day) => ({ day, rows: grouped[day] }));
  }, [adminEntryRows]);
  const adminSummaryRows = useMemo(() => {
    const grouped: Record<
      string,
      {
        period: string;
        employee: string;
        project: string;
        hours: number;
        revenue: number;
        cost: number;
        profit: number;
      }
    > = {};
    for (const row of adminEntryRows) {
      const period =
        adminSummaryMode === "weekly"
          ? `${weekStartForYmd(row.work_date)} to ${formatYmdUtc(addDaysUtc(parseYmdUtc(weekStartForYmd(row.work_date)), 6))}`
          : row.work_date.slice(0, 7);
      const employee = row.user_full_name || row.user_email || `User ${row.user_id}`;
      const project = row.project_name || `Project ${row.project_id}`;
      const key = `${period}||${employee}||${project}`;
      if (!grouped[key]) {
        grouped[key] = { period, employee, project, hours: 0, revenue: 0, cost: 0, profit: 0 };
      }
      grouped[key].hours += Number(row.hours || 0);
      grouped[key].revenue += Number(row.hours || 0) * Number(row.bill_rate_applied || 0);
      grouped[key].cost += Number(row.hours || 0) * Number(row.cost_rate_applied || 0);
      grouped[key].profit += Number(row.hours || 0) * (Number(row.bill_rate_applied || 0) - Number(row.cost_rate_applied || 0));
    }
    return Object.values(grouped).sort((a, b) => {
      if (a.period !== b.period) return a.period.localeCompare(b.period);
      if (a.employee !== b.employee) return a.employee.localeCompare(b.employee);
      return a.project.localeCompare(b.project);
    });
  }, [adminEntryRows, adminSummaryMode]);
  const adminSummaryTotals = useMemo(() => {
    return adminSummaryRows.reduce(
      (acc, r) => {
        acc.hours += r.hours;
        acc.revenue += r.revenue;
        acc.cost += r.cost;
        acc.profit += r.profit;
        return acc;
      },
      { hours: 0, revenue: 0, cost: 0, profit: 0 },
    );
  }, [adminSummaryRows]);
  const availableTimesheetUsers = useMemo(() => {
    const userIds = new Set<number>();
    for (const t of adminTimesheets) userIds.add(t.user_id);
    const byId = new Map(allUsers.map((u) => [u.id, u]));
    return Array.from(userIds)
      .map((id) => byId.get(id) || null)
      .filter((u): u is User => Boolean(u))
      .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }, [adminTimesheets, allUsers]);
  const availableTimesheetPeriods = useMemo(() => {
    if (!timesheetUserFilter) return [];
    const vals = new Set<string>();
    for (const t of adminTimesheets) {
      if (t.user_id === timesheetUserFilter) vals.add(`${t.week_start} to ${t.week_end}`);
    }
    return Array.from(vals).sort((a, b) => b.localeCompare(a));
  }, [adminTimesheets, timesheetUserFilter]);
  const selectedAdminTimesheets = useMemo(() => {
    if (!timesheetUserFilter || !timesheetPeriodFilter) return [];
    return adminTimesheets.filter(
      (t) => t.user_id === timesheetUserFilter && `${t.week_start} to ${t.week_end}` === timesheetPeriodFilter,
    );
  }, [adminTimesheets, timesheetUserFilter, timesheetPeriodFilter]);
  const availableMyTimesheetPeriods = useMemo(() => {
    const vals = new Set<string>();
    for (const t of timesheets) vals.add(`${t.week_start} to ${t.week_end}`);
    return Array.from(vals).sort((a, b) => b.localeCompare(a));
  }, [timesheets]);
  const selectedMyTimesheets = useMemo(() => {
    if (!myTimesheetPeriodFilter) return [];
    return timesheets.filter((t) => `${t.week_start} to ${t.week_end}` === myTimesheetPeriodFilter);
  }, [timesheets, myTimesheetPeriodFilter]);
  const myTimesheetSummary = useMemo(() => {
    return timesheets.reduce(
      (acc, t) => {
        acc.total += 1;
        acc.hours += Number(t.total_hours || 0);
        if (t.status === "draft") acc.draft += 1;
        if (t.status === "submitted") acc.submitted += 1;
        if (t.status === "approved") acc.approved += 1;
        return acc;
      },
      { total: 0, hours: 0, draft: 0, submitted: 0, approved: 0 },
    );
  }, [timesheets]);

  async function refreshAuth() {
    try {
      const user = await apiGet<User>("/auth/me");
      setMe(user);
    } catch {
      setMe(null);
    }
  }

  function isAuthError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.startsWith("401 ") || err.message.includes('"Not authenticated"');
  }

  function handleApiError(err: unknown) {
    if (isAuthError(err)) {
      setMe(null);
      setMessage("Session expired. Please sign in again.");
      return;
    }
    setMessage(String(err));
  }

  async function refreshData() {
    if (!me) return;
    try {
      const allProjects = await apiGet<Project[]>("/projects");
      const p = allProjects.filter((proj) => !isHiddenProjectName(proj.name));
      setProjects(p);
      setProjectEditorProjectId((prev) => {
        if (p.length === 0) return null;
        if (prev && p.some((proj) => proj.id === prev)) return prev;
        return p[0].id;
      });
      setProjectDrafts((prev) => {
        const next = { ...prev };
        for (const proj of p) {
          if (!next[proj.id]) {
            next[proj.id] = {
              name: proj.name,
              client_name: proj.client_name || "",
              pm_user_id: proj.pm_user_id ? String(proj.pm_user_id) : "",
              start_date: proj.start_date || "",
              overall_budget_fee: String(proj.overall_budget_fee || 0),
              target_gross_margin_pct: String(proj.target_gross_margin_pct || 0),
              is_overhead: proj.is_overhead,
              is_billable: proj.is_billable,
              is_active: proj.is_active,
            };
            continue;
          }
          if (typeof next[proj.id].is_billable !== "boolean") {
            next[proj.id] = { ...next[proj.id], is_billable: proj.is_billable };
          }
        }
        return next;
      });
      const params = new URLSearchParams({ start: currentRange.start, end: currentRange.end });
      if (timeFilterUserId) params.set("user_id", String(timeFilterUserId));
      if (timeFilterProjectId) params.set("project_id", String(timeFilterProjectId));
      if (timeFilterTaskId) params.set("task_id", String(timeFilterTaskId));
      if (timeFilterSubtaskId) params.set("subtask_id", String(timeFilterSubtaskId));
      const entries = await apiGet<TimeEntry[]>(`/time-entries?${params.toString()}`);
      setTimeEntries(entries);
      const mine = await apiGet<Timesheet[]>("/timesheets/mine");
      setTimesheets(mine);
      if (canManageUsers) {
        const pending = await apiGet<User[]>("/users/pending");
        const users = await apiGet<User[]>("/users");
        setPendingUsers(pending);
        setAllUsers(users);
        setPeopleDrafts((prev) => {
          const next = { ...prev };
          for (const u of users) {
            if (!next[u.id]) {
              next[u.id] = {
                full_name: u.full_name || "",
                start_date: u.start_date || "",
                role: u.role || "employee",
                is_active: !!u.is_active,
              };
            }
          }
          return next;
        });
        setAdminEntryUserId((prev) => {
          const active = users.filter((u) => u.is_active);
          if (active.length === 0) return null;
          if (prev && active.some((u) => u.id === prev)) return prev;
          return active[0].id;
        });
        setPeopleEditorUserId((prev) => {
          const active = users.filter((u) => u.is_active);
          if (active.length === 0) return null;
          if (prev && active.some((u) => u.id === prev)) return prev;
          return active[0].id;
        });
        if (canManageRates) {
          const latest = await apiGet<LatestRate[]>("/rates/latest");
          const latestMap: Record<number, LatestRate> = {};
          const draftMap: Record<number, { effective_date: string; bill_rate: string; cost_rate: string }> = {};
          for (const r of latest) {
            latestMap[r.user_id] = r;
            draftMap[r.user_id] = {
              effective_date: r.effective_date,
              bill_rate: String(r.bill_rate),
              cost_rate: String(r.cost_rate),
            };
          }
          setLatestRates(latestMap);
          setRateDrafts(draftMap);
        }
      } else {
        setPendingUsers([]);
        setAllUsers([]);
      }
    } catch (e) {
      handleApiError(e);
    }
  }

  async function refreshAdminEntryRows() {
    if (!canApproveTimesheets || !adminEntryUserId) {
      setAdminEntryRows([]);
      return;
    }
    if (!isValidYmd(adminEntryStart) || !isValidYmd(adminEntryEnd)) return;
    const params = new URLSearchParams({
      start: adminEntryStart,
      end: adminEntryEnd,
      user_id: String(adminEntryUserId),
    });
    if (adminEntryProjectId) params.set("project_id", String(adminEntryProjectId));
    if (adminEntryTaskId) params.set("task_id", String(adminEntryTaskId));
    if (adminEntrySubtaskId) params.set("subtask_id", String(adminEntrySubtaskId));
    try {
      const rows = await apiGet<TimeEntry[]>(`/time-entries?${params.toString()}`);
      setAdminEntryRows(rows);
    } catch (err) {
      handleApiError(err);
    }
  }

  async function refreshAdminTimesheets() {
    if (!canApproveTimesheets) {
      setAdminTimesheets([]);
      return;
    }
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) return;
    const params = new URLSearchParams({ start: reportStart, end: reportEnd });
    if (timesheetStatusFilter) params.set("status_filter", timesheetStatusFilter);
    if (timesheetUserFilter) params.set("user_id", String(timesheetUserFilter));
    try {
      const rows = await apiGet<AdminTimesheet[]>(`/timesheets/all?${params.toString()}`);
      setAdminTimesheets(rows);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshProjectPerformance() {
    if (!canViewFinancials) {
      setProjectPerformance([]);
      return;
    }
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) return;
    const params = new URLSearchParams({ start: reportStart, end: reportEnd });
    try {
      const payload = await apiGet<{ projects: ProjectPerformance[] }>(`/reports/project-performance?${params.toString()}`);
      const rows = payload.projects || [];
      setProjectPerformance(rows);
      setPerformanceProjectId((prev) => {
        if (rows.length === 0) return null;
        if (prev && rows.some((r) => r.project_id === prev)) return prev;
        return rows[0].project_id;
      });
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshReconciliationReport() {
    if (!canViewFinancials) {
      setReconciliationSnapshot(null);
      setReconciliationMonthly([]);
      return;
    }
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) return;
    const params = new URLSearchParams({ start: reportStart, end: reportEnd });
    try {
      const payload = await apiGet<ReconciliationReport>(`/reports/reconciliation?${params.toString()}`);
      setReconciliationSnapshot(payload.snapshot);
      setReconciliationMonthly(payload.monthly || []);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshInvoicePreview() {
    if (!canViewFinancials) {
      setInvoicePreview(null);
      return;
    }
    if (!isValidYmd(invoiceStart) || !isValidYmd(invoiceEnd)) return;
    try {
      const params = new URLSearchParams({
        start: invoiceStart,
        end: invoiceEnd,
        approved_only: invoiceApprovedOnly ? "true" : "false",
      });
      if (invoiceProjectId) params.set("project_id", String(invoiceProjectId));
      const payload = await apiGet<InvoicePreview>(`/invoices/preview?${params.toString()}`);
      setInvoicePreview(payload);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshInvoices() {
    if (!canViewFinancials) {
      setSavedInvoices([]);
      return;
    }
    try {
      const rows = await apiGet<InvoiceRecord[]>("/invoices");
      setSavedInvoices(rows);
      setInvoiceDetail((prev) => (prev && rows.some((r) => r.id === prev.id) ? prev : null));
      setInvoiceSelectedId((prev) => {
        if (rows.length === 0) return null;
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0].id;
      });
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshSelectedInvoiceDetail(invoiceId: number | null) {
    if (!invoiceId || !canViewFinancials) {
      setInvoiceDetail(null);
      setInvoiceRenderContext(null);
      return;
    }
    try {
      const detail = await apiGet<InvoiceRecord>(`/invoices/${invoiceId}`);
      setInvoiceDetail(detail);
      const ctx = await apiGet<InvoiceRenderContext>(`/invoices/${invoiceId}/render-context`);
      setInvoiceRenderContext(ctx);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshArSummary() {
    if (!canViewFinancials) {
      setArSummary(null);
      return;
    }
    try {
      const payload = await apiGet<ArSummary>("/reports/ar-summary");
      setArSummary(payload);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshRecurringSchedules() {
    if (!canViewFinancials) {
      setRecurringSchedules([]);
      return;
    }
    try {
      const rows = await apiGet<RecurringInvoiceSchedule[]>("/invoices/recurring/schedules");
      setRecurringSchedules(rows);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshProjectPerformanceRange() {
    if (!canViewFinancials || reportRangeInitialized) return;
    try {
      const range = await apiGet<PerformanceRange>("/reports/project-performance-range");
      setReportPreset("custom");
      const spanDays = daysBetweenInclusive(range.start, range.end);
      if (spanDays > 120) {
        const limited = presetRange("monthly", todayYmd);
        setReportStart(limited.start);
        setReportEnd(limited.end);
      } else {
        setReportStart(range.start);
        setReportEnd(range.end);
      }
      setReportRangeInitialized(true);
    } catch (err) {
      setMessage(String(err));
    }
  }

  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("auth_status");
    const detail = params.get("auth_detail");
    if (!status) return;
    if (status === "ok") {
      setMessage("Signed in with Google.");
      refreshAuth();
    } else {
      setMessage(`Google sign-in failed: ${detail || "unknown_error"}`);
    }
    params.delete("auth_status");
    params.delete("auth_detail");
    const q = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  }, []);

  useEffect(() => {
    refreshData();
  }, [
    me?.id,
    canManageUsers,
    currentRange.start,
    currentRange.end,
    timeFilterUserId,
    timeFilterProjectId,
    timeFilterTaskId,
    timeFilterSubtaskId,
  ]);

  useEffect(() => {
    setMonthWeekIndex(0);
  }, [timeViewMode, timeAnchorDate, currentRange.start, currentRange.end]);

  useEffect(() => {
    if (monthWeekIndex < monthWeekRanges.length) return;
    setMonthWeekIndex(0);
  }, [monthWeekIndex, monthWeekRanges.length]);

  useEffect(() => {
    refreshAdminTimesheets();
    refreshProjectPerformance();
    refreshReconciliationReport();
  }, [me?.id, canApproveTimesheets, canViewFinancials, reportStart, reportEnd, timesheetStatusFilter, timesheetUserFilter]);

  useEffect(() => {
    refreshInvoicePreview();
  }, [me?.id, canViewFinancials, invoiceStart, invoiceEnd, invoiceProjectId, invoiceApprovedOnly]);

  useEffect(() => {
    refreshInvoices();
  }, [me?.id, canViewFinancials]);

  useEffect(() => {
    refreshArSummary();
  }, [me?.id, canViewFinancials]);

  useEffect(() => {
    refreshRecurringSchedules();
  }, [me?.id, canViewFinancials]);

  useEffect(() => {
    if (!selectedInvoice) return;
    setInvoicePaidAmount(String(selectedInvoice.amount_paid ?? 0));
    setInvoicePaidDate(selectedInvoice.paid_date || "");
    setInvoiceStatusDraft(selectedInvoice.status || "sent");
  }, [selectedInvoice?.id]);

  useEffect(() => {
    refreshSelectedInvoiceDetail(invoiceSelectedId);
  }, [invoiceSelectedId, me?.id, canViewFinancials]);

  useEffect(() => {
    setGeneratedPaymentLink("");
  }, [invoiceSelectedId]);

  useEffect(() => {
    if (!canApproveTimesheets && timesheetSubView === "team") {
      setTimesheetSubView("mine");
    }
  }, [canApproveTimesheets, timesheetSubView]);

  useEffect(() => {
    if (!message.includes("date_from_datetime_parsing")) return;
    if (isValidYmd(reportStart) && isValidYmd(reportEnd) && isValidYmd(adminEntryStart) && isValidYmd(adminEntryEnd)) {
      setMessage("");
    }
  }, [reportStart, reportEnd, adminEntryStart, adminEntryEnd, message]);

  useEffect(() => {
    refreshProjectPerformanceRange();
  }, [me?.id, canViewFinancials, reportRangeInitialized]);

  useEffect(() => {
    refreshAdminEntryRows();
  }, [me?.id, canApproveTimesheets, adminEntryUserId, adminEntryStart, adminEntryEnd, adminEntryProjectId, adminEntryTaskId, adminEntrySubtaskId]);

  useEffect(() => {
    if (!timesheetPeriodFilter) return;
    if (!availableTimesheetPeriods.includes(timesheetPeriodFilter)) {
      setTimesheetPeriodFilter("");
    }
  }, [availableTimesheetPeriods, timesheetPeriodFilter]);

  useEffect(() => {
    if (!projectEditorProjectId) return;
    ensureProjectWbs(projectEditorProjectId);
    refreshProjectExpenses(projectEditorProjectId);
  }, [projectEditorProjectId]);

  useEffect(() => {
    if (projectPmUserId) return;
    if (pmUserOptions.length > 0) {
      const preferred = pmUserOptions.find((u) => me && u.id === me.id) || pmUserOptions[0];
      setProjectPmUserId(preferred.id);
      return;
    }
    if (me) setProjectPmUserId(me.id);
  }, [pmUserOptions, me?.id, projectPmUserId]);

  async function handleBootstrap(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    try {
      const user = await apiPost<User>("/auth/dev/bootstrap-admin", {
        email: bootstrapEmail,
        full_name: bootstrapName,
      });
      setMe(user);
      setMessage("Bootstrap admin created and signed in.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    try {
      const user = await apiPost<User>("/auth/dev/login", { email: loginEmail });
      setMe(user);
      setMessage(`Signed in as ${user.email}`);
    } catch (err) {
      setMessage(String(err));
    }
  }

  function handleGoogleSignIn() {
    window.location.href = `${API_BASE}/auth/google/login`;
  }

  async function handleLogout() {
    await apiPost<{ ok: boolean }>("/auth/logout");
    setMe(null);
    setProjects([]);
    setTimesheets([]);
    setPendingUsers([]);
  }

  async function activateUser(userId: number) {
    try {
      await apiPost<User>(`/users/${userId}/activate`);
      setMessage("User activated.");
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function provisionDefaultStaff() {
    try {
      const res = await apiPost<{ created: number; updated: number; kept_admin: number }>("/users/provision-default-staff");
      setMessage(`Provisioned staff. Created: ${res.created}, Updated: ${res.updated}, Kept admin: ${res.kept_admin}.`);
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function createProject(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    try {
      const overallBudget = Number(projectOverallBudget);
      const targetMargin = Number(projectTargetMargin);
      if (!Number.isFinite(overallBudget) || overallBudget < 0 || !Number.isFinite(targetMargin) || targetMargin < 0 || targetMargin > 100) {
        setMessage("Project budget must be >= 0 and target gross margin must be 0-100.");
        return;
      }
      if (!projectPmUserId) {
        setMessage("Select a PM before creating project.");
        return;
      }
      if (maxAchievableMarginPct !== null && targetMargin > maxAchievableMarginPct) {
        setMessage(`Warning: target margin ${targetMargin.toFixed(1)}% exceeds current max estimated margin ${maxAchievableMarginPct.toFixed(1)}% from configured rates.`);
      }
      const p = await apiPost<Project>("/projects", {
        name: projectName,
        client_name: projectClient,
        pm_user_id: projectPmUserId,
        start_date: projectStartDate || null,
        overall_budget_fee: overallBudget,
        target_gross_margin_pct: targetMargin,
        is_overhead: false,
        is_billable: projectIsBillable,
      });
      setSelectedProjectId(p.id);
      if (!isHiddenProjectName(p.name)) setProjects((prev) => [p, ...prev]);
      setMessage("Project created.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function createTask(e: FormEvent) {
    e.preventDefault();
    if (!selectedProjectId) return;
    try {
      const selectedProject = projects.find((p) => p.id === selectedProjectId);
      const t = await apiPost<{ id: number }>(`/projects/${selectedProjectId}/tasks`, {
        name: taskName,
        is_billable: selectedProject ? selectedProject.is_billable : true,
      });
      setSelectedTaskId(t.id);
      setMessage("Task created.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function createSubtask(e: FormEvent) {
    e.preventDefault();
    if (!selectedTaskId) return;
    try {
      const s = await apiPost<{ id: number }>(`/tasks/${selectedTaskId}/subtasks`, {
        code: subtaskCode,
        name: subtaskName,
        budget_hours: 120,
        budget_fee: 24000,
      });
      setSelectedSubtaskId(s.id);
      setMessage("Subtask created.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function addRate() {
    if (!me) return;
    if (!canManageRates) {
      setMessage("You do not have permission to set rates. Ask an admin/manager to set your rate.");
      return;
    }
    const bill = parseRateInput(rateBill);
    const cost = parseRateInput(rateCost);
    if (bill === null || cost === null) {
      setMessage("Enter valid positive bill/cost rates (up to 4 decimals).");
      return;
    }
    try {
      await apiPost("/rates", {
        user_id: me.id,
        effective_date: rateDate,
        bill_rate: bill,
        cost_rate: cost,
      });
      setMessage("Rate configured.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function setStaffRate() {
    if (!canManageRates || !canManageUsers) {
      setMessage("You do not have permission to set staff rates.");
      return;
    }
    if (!staffRateUserId) {
      setMessage("Select a staff member.");
      return;
    }
    const bill = parseRateInput(staffRateBill);
    const cost = parseRateInput(staffRateCost);
    if (bill === null || cost === null) {
      setMessage("Enter valid positive bill/cost rates (up to 4 decimals).");
      return;
    }
    try {
      await apiPost("/rates", {
        user_id: staffRateUserId,
        effective_date: staffRateDate,
        bill_rate: bill,
        cost_rate: cost,
      });
      const selected = allUsers.find((u) => u.id === staffRateUserId);
      setMessage(`Rate saved for ${selected?.email || `user ${staffRateUserId}`}.`);
    } catch (err) {
      setMessage(String(err));
    }
  }

  function setRateDraft(userId: number, patch: Partial<{ effective_date: string; bill_rate: string; cost_rate: string }>) {
    setRateDrafts((prev) => ({
      ...prev,
      [userId]: {
        effective_date: prev[userId]?.effective_date || new Date().toISOString().slice(0, 10),
        bill_rate: prev[userId]?.bill_rate || "220",
        cost_rate: prev[userId]?.cost_rate || "90",
        ...patch,
      },
    }));
  }

  function setPeopleDraft(
    userId: number,
    patch: Partial<{ full_name: string; start_date: string; role: string; is_active: boolean }>,
  ) {
    setPeopleDrafts((prev) => ({
      ...prev,
      [userId]: {
        full_name: prev[userId]?.full_name || "",
        start_date: prev[userId]?.start_date || "",
        role: prev[userId]?.role || "employee",
        is_active: prev[userId]?.is_active ?? true,
        ...patch,
      },
    }));
  }

  async function saveUserProfile(userId: number) {
    const d = peopleDrafts[userId];
    if (!d) {
      setMessage("No employee draft to save.");
      return;
    }
    if (!d.full_name.trim()) {
      setMessage("Employee full name is required.");
      return;
    }
    if (!["admin", "manager", "employee"].includes(d.role)) {
      setMessage("Role must be admin, manager, or employee.");
      return;
    }
    try {
      await apiPut(`/users/${userId}`, {
        full_name: d.full_name.trim(),
        start_date: d.start_date || null,
        role: d.role,
        is_active: d.is_active,
      });
      const u = allUsers.find((x) => x.id === userId);
      setMessage(`Employee profile updated for ${u?.email || userId}.`);
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function saveRateForUser(userId: number) {
    const d = rateDrafts[userId];
    if (!d) {
      setMessage("No rate draft for selected user.");
      return;
    }
    const bill = parseRateInput(d.bill_rate);
    const cost = parseRateInput(d.cost_rate);
    if (bill === null || cost === null) {
      setMessage("Enter valid positive bill/cost rates (up to 4 decimals).");
      return;
    }
    try {
      await apiPost("/rates", {
        user_id: userId,
        effective_date: d.effective_date,
        bill_rate: bill,
        cost_rate: cost,
      });
      const u = allUsers.find((x) => x.id === userId);
      setMessage(`Rate saved for ${u?.email || userId}.`);
      setLatestRates((prev) => ({
        ...prev,
        [userId]: { user_id: userId, effective_date: d.effective_date, bill_rate: bill, cost_rate: cost },
      }));
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function reapplyRatesForEntries(userId: number | null) {
    if (!canManageRates) {
      setMessage("You do not have permission to reapply rates.");
      return;
    }
    if (!isValidYmd(reapplyRateStart) || !isValidYmd(reapplyRateEnd)) {
      setMessage("Use valid reapply start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const params = new URLSearchParams({ start: reapplyRateStart, end: reapplyRateEnd });
      if (userId) params.set("user_id", String(userId));
      const res = await apiPost<ReapplyRatesResult>(`/rates/reapply-to-entries?${params.toString()}`, {});
      setMessage(`Rates reapplied. Updated: ${res.updated}, unchanged: ${res.unchanged}, no-rate skipped: ${res.skipped_no_rate}.`);
      refreshData();
      refreshAdminEntryRows();
      refreshProjectPerformance();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function ensureProjectWbs(projectId: number) {
    if (wbsByProject[projectId]) return;
    const payload = await apiGet<ProjectWbs>(`/projects/${projectId}/wbs`);
    setWbsByProject((prev) => ({ ...prev, [projectId]: payload.tasks || [] }));
    setTaskDrafts((prev) => {
      const next = { ...prev };
      for (const t of payload.tasks || []) {
        if (!next[t.id]) {
          next[t.id] = { name: t.name, is_billable: t.is_billable };
          continue;
        }
        if (typeof next[t.id].is_billable !== "boolean") {
          next[t.id] = { ...next[t.id], is_billable: t.is_billable };
        }
      }
      return next;
    });
    setSubtaskDrafts((prev) => {
      const next = { ...prev };
      for (const t of payload.tasks || []) {
        for (const s of t.subtasks || []) {
          if (!next[s.id]) {
            next[s.id] = {
              code: s.code,
              name: s.name,
              budget_hours: String(s.budget_hours),
              budget_fee: String(s.budget_fee),
            };
          }
        }
      }
      return next;
    });
  }

  async function setEntryProject(projectId: number | null) {
    if (projectId) {
      await ensureProjectWbs(projectId);
    }
    setEntryProjectId(projectId);
    setEntryTaskId(null);
    setEntrySubtaskId(null);
  }

  async function setTimeFilterProject(projectId: number | null) {
    if (projectId) {
      await ensureProjectWbs(projectId);
    }
    setTimeFilterProjectId(projectId);
    setTimeFilterTaskId(null);
    setTimeFilterSubtaskId(null);
  }

  async function setAdminFilterProject(projectId: number | null) {
    if (projectId) {
      await ensureProjectWbs(projectId);
    }
    setAdminEntryProjectId(projectId);
    setAdminEntryTaskId(null);
    setAdminEntrySubtaskId(null);
  }

  function setProjectDraft(
    projectId: number,
    patch: Partial<{
      name: string;
      client_name: string;
      pm_user_id: string;
      start_date: string;
      overall_budget_fee: string;
      target_gross_margin_pct: string;
      is_overhead: boolean;
      is_billable: boolean;
      is_active: boolean;
    }>,
  ) {
    setProjectDrafts((prev) => ({
      ...prev,
      [projectId]: {
        name: prev[projectId]?.name || "",
        client_name: prev[projectId]?.client_name || "",
        pm_user_id: prev[projectId]?.pm_user_id || "",
        start_date: prev[projectId]?.start_date || "",
        overall_budget_fee: prev[projectId]?.overall_budget_fee || "0",
        target_gross_margin_pct: prev[projectId]?.target_gross_margin_pct || "0",
        is_overhead: prev[projectId]?.is_overhead || false,
        is_billable: prev[projectId]?.is_billable ?? true,
        is_active: prev[projectId]?.is_active ?? true,
        ...patch,
      },
    }));
  }

  function setTaskDraft(taskId: number, patch: Partial<{ name: string; is_billable: boolean }>) {
    setTaskDrafts((prev) => ({
      ...prev,
      [taskId]: {
        name: prev[taskId]?.name || "",
        is_billable: prev[taskId]?.is_billable ?? true,
        ...patch,
      },
    }));
  }

  function setSubtaskDraft(
    subtaskId: number,
    patch: Partial<{ code: string; name: string; budget_hours: string; budget_fee: string }>,
  ) {
    setSubtaskDrafts((prev) => ({
      ...prev,
      [subtaskId]: {
        code: prev[subtaskId]?.code || "",
        name: prev[subtaskId]?.name || "",
        budget_hours: prev[subtaskId]?.budget_hours || "0",
        budget_fee: prev[subtaskId]?.budget_fee || "0",
        ...patch,
      },
    }));
  }

  async function saveProject(projectId: number) {
    const d = projectDrafts[projectId];
    if (!d) return;
    try {
      await ensureProjectWbs(projectId);
      const subtasks = (wbsByProject[projectId] || []).flatMap((t) => t.subtasks || []);
      const subtaskBudgetSum = subtasks.reduce((sum, s) => sum + Number(s.budget_fee || 0), 0);
      const overallBudget = Number(d.overall_budget_fee);
      const targetMargin = Number(d.target_gross_margin_pct);
      if (!Number.isFinite(overallBudget) || overallBudget < 0 || !Number.isFinite(targetMargin) || targetMargin < 0 || targetMargin > 100) {
        setMessage("Project budget must be >= 0 and target gross margin must be 0-100.");
        return;
      }
      if (overallBudget < subtaskBudgetSum) {
        setMessage(`Overall budget fee cannot be lower than WBS subtotal (${subtaskBudgetSum.toFixed(2)}).`);
        return;
      }
      if (maxAchievableMarginPct !== null && targetMargin > maxAchievableMarginPct) {
        setMessage(`Warning: target margin ${targetMargin.toFixed(1)}% exceeds current max estimated margin ${maxAchievableMarginPct.toFixed(1)}% from configured rates.`);
      }
      await apiPut(`/projects/${projectId}`, {
        name: d.name,
        client_name: d.client_name || null,
        pm_user_id: d.pm_user_id ? Number(d.pm_user_id) : null,
        start_date: d.start_date || null,
        overall_budget_fee: overallBudget,
        target_gross_margin_pct: targetMargin,
        is_overhead: d.is_overhead,
        is_billable: d.is_billable,
        is_active: d.is_active,
      });
      setMessage("Project updated.");
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function saveTask(taskId: number) {
    const d = taskDrafts[taskId];
    if (!d) return;
    try {
      await apiPut(`/tasks/${taskId}`, { name: d.name, is_billable: d.is_billable });
      setMessage("Task updated.");
      setWbsByProject({});
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function saveSubtask(subtaskId: number) {
    const d = subtaskDrafts[subtaskId];
    if (!d) return;
    try {
      await apiPut(`/subtasks/${subtaskId}`, {
        code: d.code,
        name: d.name,
        budget_hours: Number(d.budget_hours),
        budget_fee: Number(d.budget_fee),
      });
      setMessage("Subtask budget updated.");
      setWbsByProject({});
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshProjectExpenses(projectId: number) {
    try {
      const rows = await apiGet<ProjectExpense[]>(`/projects/${projectId}/expenses`);
      setProjectExpenses((prev) => ({ ...prev, [projectId]: rows }));
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function addProjectExpense(projectId: number) {
    const amount = Number(expenseAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Expense amount must be greater than 0.");
      return;
    }
    if (!isValidYmd(expenseDate)) {
      setMessage("Use valid expense date in YYYY-MM-DD format.");
      return;
    }
    try {
      await apiPost(`/projects/${projectId}/expenses`, {
        expense_date: expenseDate,
        category: expenseCategory || "General",
        description: expenseDescription || "",
        amount,
      });
      setMessage("Project expense added.");
      setExpenseDescription("");
      setExpenseAmount("0");
      refreshProjectExpenses(projectId);
      refreshProjectPerformance();
    } catch (err) {
      setMessage(String(err));
    }
  }

  function openEntryForDate(day: string) {
    setEntryDate(day);
    setEditingEntryId(null);
    setEntryProjectId(null);
    setEntryTaskId(null);
    setEntrySubtaskId(null);
    setEntryHours("8");
    setEntryNote("");
  }

  function closeEntryModal() {
    setEditingEntryId(null);
    setEntryDate(null);
  }

  async function editExistingEntry(entry: TimeEntry) {
    await ensureProjectWbs(entry.project_id);
    setEntryDate(entry.work_date);
    setEditingEntryId(entry.id);
    setEntryProjectId(entry.project_id);
    setEntryTaskId(entry.task_id);
    setEntrySubtaskId(entry.subtask_id);
    setEntryHours(String(entry.hours));
    setEntryNote(entry.note || "");
  }

  async function saveSelectedDayEntry() {
    if (!entryDate || !entryProjectId || !entryTaskId || !entrySubtaskId || Number(entryHours) <= 0) {
      setMessage("Pick date, project, task, subtask, and positive hours.");
      return;
    }
    try {
      if (editingEntryId) {
        await apiPut(`/time-entries/${editingEntryId}`, {
          project_id: entryProjectId,
          task_id: entryTaskId,
          subtask_id: entrySubtaskId,
          work_date: entryDate,
          hours: Number(entryHours),
          note: entryNote || "Time entry",
        });
        setMessage(`Updated time entry #${editingEntryId}.`);
      } else {
        await apiPost("/time-entries", {
          project_id: entryProjectId,
          task_id: entryTaskId,
          subtask_id: entrySubtaskId,
          work_date: entryDate,
          hours: Number(entryHours),
          note: entryNote || "Time entry",
        });
        setMessage(`Saved time entry for ${entryDate}.`);
      }
      setEditingEntryId(null);
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function deleteEntry(entryId: number) {
    try {
      await apiDelete(`/time-entries/${entryId}`);
      if (editingEntryId === entryId) {
        setEditingEntryId(null);
      }
      setMessage(`Deleted time entry #${entryId}.`);
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function generateTimesheet() {
    try {
      await apiPost("/timesheets/generate");
      setMessage("Timesheet generated/refreshed.");
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function submitTimesheet(id: number) {
    try {
      await apiPost(`/timesheets/${id}/submit`);
      setMessage("Timesheet submitted.");
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function approveTimesheet(id: number) {
    try {
      await apiPost(`/timesheets/${id}/approve`);
      setMessage("Timesheet approved.");
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function approveVisibleSubmittedTimesheets() {
    if (!canApproveTimesheets) {
      setMessage("You do not have permission to bulk approve.");
      return;
    }
    const ids = selectedAdminTimesheets.filter((t) => t.status === "submitted").map((t) => t.id);
    if (ids.length === 0) {
      setMessage("No submitted timesheets in current filters.");
      return;
    }
    try {
      let approved = 0;
      for (const id of ids) {
        await apiPost(`/timesheets/${id}/approve`);
        approved += 1;
      }
      setMessage(`Bulk approved ${approved} timesheet${approved === 1 ? "" : "s"}.`);
      refreshAdminTimesheets();
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function generateTimesheetsForRange() {
    if (!canApproveTimesheets) {
      setMessage("You do not have permission to generate range timesheets.");
      return;
    }
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) {
      setMessage("Use valid report start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const params = new URLSearchParams({ start: reportStart, end: reportEnd });
      if (timesheetUserFilter) params.set("user_id", String(timesheetUserFilter));
      const res = await apiPost<{ created: number; existing: number; weeks_found: number }>(
        `/timesheets/generate-range?${params.toString()}`,
        {},
      );
      setMessage(`Historical timesheets generated. Created: ${res.created}, existing: ${res.existing}, weeks found: ${res.weeks_found}.`);
      refreshAdminTimesheets();
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  function shiftTimeRange(direction: -1 | 1) {
    const anchor = parseYmdUtc(timeAnchorDate);
    if (timeViewMode === "day") {
      setTimeAnchorDate(formatYmdUtc(addDaysUtc(anchor, direction)));
      return;
    }
    if (timeViewMode === "week") {
      setTimeAnchorDate(formatYmdUtc(addDaysUtc(anchor, direction * 7)));
      return;
    }
    const shifted = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + direction, 1));
    setTimeAnchorDate(formatYmdUtc(shifted));
  }

  function applyReportPreset(preset: ReportPreset) {
    setReportPreset(preset);
    if (preset === "custom") return;
    const range = presetRange(preset, new Date().toISOString().slice(0, 10));
    setReportStart(range.start);
    setReportEnd(range.end);
  }

  function applyInvoicePeriodPreset(preset: InvoicePeriodPreset) {
    setInvoicePeriodPreset(preset);
    if (preset === "custom") return;
    const range = invoicePresetRange(preset, new Date().toISOString().slice(0, 10));
    setInvoiceStart(range.start);
    setInvoiceEnd(range.end);
  }

  async function runFreshbooksImport() {
    if (!importFile) {
      setMessage("Select a FreshBooks CSV file first.");
      return;
    }
    try {
      const form = new FormData();
      form.append("file", importFile);
      form.append("mapping_overrides", importMappingJson);
      const res = await fetch(`${API_BASE}/time-import/freshbooks?apply=${importApply ? "true" : "false"}`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${text}`);
      }
      const payload = JSON.parse(text);
      setImportSummary(
        `Rows: ${payload.count} | Imported: ${payload.imported} | Skipped: ${payload.skipped} | Errors: ${payload.errors} | Non-approved skipped: ${payload.non_approved_skipped ?? 0}`,
      );
      setMessage(importApply ? "FreshBooks import applied." : "FreshBooks import preview ready.");
      if (importApply) {
        if (payload.min_imported_date && payload.max_imported_date) {
          setReportPreset("custom");
          setReportStart(payload.min_imported_date);
          setReportEnd(payload.max_imported_date);
        }
        refreshData();
        refreshAdminEntryRows();
        refreshProjectPerformance();
      }
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function exportAdminEntryCsv() {
    if (!adminEntryUserId) {
      setMessage("Select employee before exporting CSV.");
      return;
    }
    if (!isValidYmd(adminEntryStart) || !isValidYmd(adminEntryEnd)) {
      setMessage("Use valid start/end dates in YYYY-MM-DD format.");
      return;
    }
    const params = new URLSearchParams({
      start: adminEntryStart,
      end: adminEntryEnd,
      user_id: String(adminEntryUserId),
    });
    if (adminEntryProjectId) params.set("project_id", String(adminEntryProjectId));
    if (adminEntryTaskId) params.set("task_id", String(adminEntryTaskId));
    if (adminEntrySubtaskId) params.set("subtask_id", String(adminEntrySubtaskId));
    try {
      const res = await fetch(`${API_BASE}/time-entries/export.csv?${params.toString()}`, {
        method: "GET",
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status} ${text}`);
      }
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const contentDisposition = res.headers.get("content-disposition") || "";
      const match = contentDisposition.match(/filename=\"?([^\"]+)\"?/i);
      const filename = match?.[1] || `time_entries_${adminEntryUserId}_${adminEntryStart}_${adminEntryEnd}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute("download", filename);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage("CSV exported.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function exportProjectPerformanceCsv() {
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) {
      setMessage("Use valid report start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const params = new URLSearchParams({ start: reportStart, end: reportEnd });
      const res = await fetch(`${API_BASE}/reports/project-performance.csv?${params.toString()}`, {
        method: "GET",
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute("download", `project_performance_${reportStart}_${reportEnd}.csv`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage("Project performance CSV exported.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function exportReconciliationCsv() {
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) {
      setMessage("Use valid report start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const params = new URLSearchParams({ start: reportStart, end: reportEnd });
      const res = await fetch(`${API_BASE}/reports/reconciliation.csv?${params.toString()}`, {
        method: "GET",
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute("download", `reconciliation_${reportStart}_${reportEnd}.csv`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage("Reconciliation CSV exported.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function createInvoiceFromPeriod() {
    if (!canManageProjects) {
      setMessage("You do not have permission to create invoices.");
      return;
    }
    if (!isValidYmd(invoiceStart) || !isValidYmd(invoiceEnd)) {
      setMessage("Use valid invoice start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const payload = await apiPost<InvoiceRecord>("/invoices", {
        start: invoiceStart,
        end: invoiceEnd,
        project_id: invoiceProjectId,
        approved_only: invoiceApprovedOnly,
        notes: invoiceNotes,
      });
      setMessage(`Invoice ${payload.invoice_number} created as draft.`);
      setInvoiceDetail(payload);
      setInvoiceSelectedId(payload.id);
      setInvoiceViewerOpen(true);
      refreshInvoices();
      refreshInvoicePreview();
      refreshArSummary();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function seedStandardWbs(projectId: number) {
    if (!canManageProjects) {
      setMessage("You do not have permission to seed project WBS.");
      return;
    }
    try {
      const res = await apiPost<{ ok: boolean; added_tasks: number; added_subtasks: number }>(
        `/projects/${projectId}/seed-standard-wbs?target_tasks=10&target_subtasks=4`,
        {},
      );
      setMessage(`Standard WBS ready. Added tasks: ${res.added_tasks}, added subtasks: ${res.added_subtasks}.`);
      setWbsByProject({});
      refreshData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function updateInvoicePayment() {
    if (!invoiceSelectedId) {
      setMessage("Select an invoice first.");
      return;
    }
    const paid = Number(invoicePaidAmount);
    if (!Number.isFinite(paid) || paid < 0) {
      setMessage("Amount paid must be a valid number >= 0.");
      return;
    }
    try {
      await apiPut<InvoiceRecord>(`/invoices/${invoiceSelectedId}/payment`, {
        amount_paid: paid,
        paid_date: invoicePaidDate || null,
        status: invoiceStatusDraft || null,
      });
      setMessage("Invoice payment status updated.");
      refreshInvoices();
      refreshArSummary();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function markInvoiceAsSent() {
    if (!selectedInvoice) {
      setMessage("Select an invoice first.");
      return;
    }
    try {
      await apiPut<InvoiceRecord>(`/invoices/${selectedInvoice.id}/payment`, {
        amount_paid: selectedInvoice.amount_paid ?? 0,
        paid_date: selectedInvoice.paid_date || null,
        status: "sent",
      });
      setMessage(`Invoice ${selectedInvoice.invoice_number} marked as sent.`);
      refreshSelectedInvoiceDetail(selectedInvoice.id);
      refreshInvoices();
      refreshArSummary();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function downloadInvoicePdf(inv: InvoiceRecord) {
    const win = window.open("", "_blank");
    if (!win) {
      setMessage("Pop-up blocked. Allow pop-ups to download PDF.");
      return;
    }
    const template = invoiceTemplateMeta(inv);
    const taskMath = buildInvoiceTaskMath(inv.lines);
    let renderCtx: InvoiceRenderContext | null = null;
    try {
      if (invoiceRenderContext && invoiceRenderContext.invoice_id === inv.id) {
        renderCtx = invoiceRenderContext;
      } else {
        renderCtx = await apiGet<InvoiceRenderContext>(`/invoices/${inv.id}/render-context`);
      }
    } catch {
      renderCtx = null;
    }
    const byTask: Record<string, { task: string; hours: number; amount: number }> = {};
    const byEmployee: Record<string, { employee: string; hours: number; amount: number }> = {};
    for (const line of inv.lines) {
      const taskKey = `${line.task || "-"} / ${line.subtask || "-"}`;
      if (!byTask[taskKey]) byTask[taskKey] = { task: taskKey, hours: 0, amount: 0 };
      byTask[taskKey].hours += Number(line.hours || 0);
      byTask[taskKey].amount += Number(line.amount || 0);

      const empKey = line.employee || "Unassigned";
      if (!byEmployee[empKey]) byEmployee[empKey] = { employee: empKey, hours: 0, amount: 0 };
      byEmployee[empKey].hours += Number(line.hours || 0);
      byEmployee[empKey].amount += Number(line.amount || 0);
    }
    const taskRows = Object.values(byTask)
      .sort((a, b) => a.task.localeCompare(b.task))
      .map(
        (r) => `
          <tr>
            <td>${escapeHtml(r.task)}</td>
            <td style="text-align:right">${r.hours.toFixed(2)}</td>
            <td style="text-align:right">${formatCurrency(r.amount)}</td>
          </tr>`,
      )
      .join("");
    const employeeRows = Object.values(byEmployee)
      .sort((a, b) => a.employee.localeCompare(b.employee))
      .map(
        (r) => `
          <tr>
            <td>${escapeHtml(r.employee)}</td>
            <td style="text-align:right">${r.hours.toFixed(2)}</td>
            <td style="text-align:right">${formatCurrency(r.amount)}</td>
          </tr>`,
      )
      .join("");
    const billToHtml = template.billToLines.map((line) => escapeHtml(line)).join("<br/>");
    const refHtml = template.references
      .map((r) => `<strong>${escapeHtml(r.label)}:</strong> ${escapeHtml(r.value)}`)
      .join("<br/>");
    const summaryRowsHtml =
      (renderCtx?.summary_rows || [])
        .map(
          (r) => `
          <tr>
            <td>${escapeHtml(r.task)}</td>
            <td style="text-align:right">${formatCurrency(r.previously_billed)}</td>
            <td style="text-align:right">${formatCurrency(r.this_invoice)}</td>
            <td style="text-align:right">${formatCurrency(r.billed_to_date)}</td>
            <td style="text-align:right">${formatCurrency(r.contract_maximum)}</td>
            <td style="text-align:right">${formatCurrency(r.contract_balance_remaining)}</td>
            <td style="text-align:right">${r.pct_complete_this_invoice.toFixed(2)}%</td>
            <td style="text-align:right">${r.pct_complete_to_date.toFixed(2)}%</td>
          </tr>`,
        )
        .join("") || `<tr><td colspan="8" style="text-align:center;color:#666">Summary unavailable for this invoice.</td></tr>`;
    const taskMathHtml = taskMath
      .map((tm) => {
        const staffRowsHtml = tm.staffRows
          .map(
            (r) => `<tr><td>${escapeHtml(r.employee)}</td><td style="text-align:right">${r.hours.toFixed(2)}</td><td style="text-align:right">${formatCurrency(r.directRate)}</td><td style="text-align:right">${formatCurrency(r.amount)}</td></tr>`,
          )
          .join("");
        const principalRowsHtml = tm.principalRows
          .map(
            (r) => `<tr><td>${escapeHtml(r.employee)}</td><td style="text-align:right">${r.hours.toFixed(2)}</td><td style="text-align:right">${formatCurrency(r.billRate)}</td><td style="text-align:right">${formatCurrency(r.amount)}</td></tr>`,
          )
          .join("");
        return `
          <h2>Task - ${escapeHtml(tm.task)}</h2>
          ${staffRowsHtml ? `<table><thead><tr><th>Employee Name</th><th style="text-align:right">Hours</th><th style="text-align:right">Direct Salary Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>${staffRowsHtml}
          <tr><td colspan="3"><strong>Direct Salary</strong></td><td style="text-align:right"><strong>${formatCurrency(tm.staffDirect)}</strong></td></tr>
          <tr><td colspan="3">Overhead Rate @114%</td><td style="text-align:right">${formatCurrency(tm.staffOverhead)}</td></tr>
          <tr><td colspan="3">Profit @ 10% on Labor & OH</td><td style="text-align:right">${formatCurrency(tm.staffProfit)}</td></tr>
          <tr><td colspan="3"><strong>Direct Labor</strong></td><td style="text-align:right"><strong>${formatCurrency(tm.staffSubtotal)}</strong></td></tr>
          </tbody></table>` : ""}
          ${principalRowsHtml ? `<table><thead><tr><th>Employee Name</th><th style="text-align:right">Hours</th><th style="text-align:right">Billing Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>${principalRowsHtml}
          <tr><td colspan="3">Overhead Rate @114%</td><td style="text-align:right">${formatCurrency(tm.principalOverhead)}</td></tr>
          <tr><td colspan="3"><strong>Direct Labor</strong></td><td style="text-align:right"><strong>${formatCurrency(tm.principalSubtotal)}</strong></td></tr>
          </tbody></table>` : ""}
          <div class="meta"><strong>Total Labor:</strong> ${formatCurrency(tm.totalLabor)}</div>
        `;
      })
      .join("");
    const appendixHtml = (renderCtx?.appendix_weeks || [])
      .map((wk) => {
        const entryRows = wk.entries
          .map(
            (e) => `
            <tr class="${e.is_invoiced ? "hl" : ""}">
              <td>${escapeHtml(e.work_date)}</td>
              <td>${escapeHtml(e.project)}</td>
              <td>${escapeHtml(`${e.task} / ${e.subtask}`)}</td>
              <td>${escapeHtml(e.note || "-")}</td>
              <td style="text-align:right">${e.hours.toFixed(2)}</td>
            </tr>`,
          )
          .join("");
        return `
          <div class="week-block">
            <div class="meta"><strong>Employee:</strong> ${escapeHtml(wk.employee)} (${escapeHtml(wk.email || "-")})<br/>
              <strong>Week:</strong> ${escapeHtml(wk.week_start)} to ${escapeHtml(wk.week_end)}<br/>
              <strong>Weekly Hours:</strong> ${wk.total_hours.toFixed(2)} | <strong>Invoiced Hours:</strong> ${wk.invoiced_hours.toFixed(2)}
            </div>
            <table>
              <thead>
                <tr><th>Date</th><th>Project</th><th>Task/Subtask</th><th>Note</th><th style="text-align:right">Hours</th></tr>
              </thead>
              <tbody>${entryRows}</tbody>
            </table>
          </div>`;
      })
      .join("");
    const rows = inv.lines
      .map(
        (line) => `
          <tr>
            <td>${escapeHtml(line.work_date)}</td>
            <td>${escapeHtml(line.employee || "-")}</td>
            <td>${escapeHtml(line.project || "-")}</td>
            <td>${escapeHtml(`${line.task || "-"} / ${line.subtask || "-"}`)}</td>
            <td style="text-align:right">${line.hours.toFixed(2)}</td>
            <td style="text-align:right">${formatCurrency(line.bill_rate)}</td>
            <td style="text-align:right">${formatCurrency(line.amount)}</td>
            <td>${escapeHtml(line.note || "-")}</td>
          </tr>`,
      )
      .join("");
    win.document.write(`<!doctype html>
<html><head><meta charset="utf-8" /><title>${escapeHtml(inv.invoice_number)}</title>
<style>
body{font-family:Arial,sans-serif;padding:24px;color:#111}
.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
h1{margin:0;font-size:24px}
h2{margin:16px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:.4px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
th,td{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}
th{background:#f5f7f9}
.meta{font-size:12px;line-height:1.5}
.summary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
.box{border:1px solid #d8d8d8;padding:8px}
.tot{margin-top:12px;text-align:right;font-size:13px}
.week-block{page-break-inside:avoid;margin:0 0 16px}
.hl td{border:2px solid #2f6fed;background:#eef4ff}
.sig{margin-top:10px;font-size:12px}
</style></head><body>
<div class="meta">Place Company Letterhead Here</div>
<div class="meta"><strong>Aquatech Engineering P.C.</strong><br/>15 Bonita Vista Road<br/>Mount Vernon, NY 10552</div>
<div class="top">
  <div><img src="/Aqt_Logo.png" style="width:170px" /></div>
  <div><h1>Invoice</h1><div class="meta">No: ${escapeHtml(inv.invoice_number)}<br/>Issued: ${escapeHtml(inv.issue_date)}<br/>Status: ${escapeHtml(inv.status)}<br/>Template: ${escapeHtml(template.label)}</div></div>
</div>
<div class="summary">
  <div class="box meta"><strong>Bill To</strong><br/>${billToHtml}</div>
  <div class="box meta"><strong>Invoice Info</strong><br/>${escapeHtml(template.periodLabel)}: ${escapeHtml(inv.start_date)} to ${escapeHtml(inv.end_date)}<br/>Date Issued: ${escapeHtml(inv.issue_date)}<br/>Invoice #: ${escapeHtml(inv.invoice_number)}<br/>This Invoice: ${formatCurrency(inv.subtotal_amount)}</div>
</div>
${refHtml ? `<div class="box meta">${refHtml}</div>` : ""}
<h2>Contract Summary by Task</h2>
<table><thead><tr><th>Task</th><th style="text-align:right">Total Billed Previously</th><th style="text-align:right">This Invoice</th><th style="text-align:right">Total Billed to Date</th><th style="text-align:right">Contract Maximum</th><th style="text-align:right">Contract Balance Remaining</th><th style="text-align:right">% Complete This Invoice</th><th style="text-align:right">% Complete To Date</th></tr></thead>
<tbody>${summaryRowsHtml}</tbody></table>
<div class="sig">Authorized Signature: Bertrand Byrne, CEO<br/>Title: Aquatech Engineering P.C.</div>
<h2>Professional Services Rate Math</h2>
${taskMathHtml || `<div class="meta">No rate detail rows available.</div>`}
<h2>Professional Services and Expense Detail</h2>
<table><thead><tr><th>Date</th><th>Employee</th><th>Project</th><th>Task/Subtask</th><th style="text-align:right">Hours</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th><th>Note</th></tr></thead>
<tbody>${rows}</tbody></table>
<h2>Timesheet Support (Full Employee Timesheets)</h2>
${appendixHtml || `<div class="meta">No appendix rows available.</div>`}
<div class="tot">
  Subtotal: ${formatCurrency(inv.subtotal_amount)}<br/>
  Paid: ${formatCurrency(inv.amount_paid)}<br/>
  Balance: ${formatCurrency(inv.balance_due)}
</div>
</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 200);
  }

  async function generatePaymentLink() {
    if (!invoiceSelectedId) {
      setMessage("Select an invoice first.");
      return;
    }
    const days = Number(paymentLinkDays);
    if (!Number.isFinite(days) || days < 1 || days > 120) {
      setMessage("Payment link expiry days must be between 1 and 120.");
      return;
    }
    try {
      const res = await apiPost<InvoicePaymentLink>(`/invoices/${invoiceSelectedId}/payment-link`, {
        expires_in_days: days,
      });
      setGeneratedPaymentLink(res.payment_link_url);
      setMessage(`Payment link generated for ${res.invoice_number}.`);
      refreshInvoices();
      refreshSelectedInvoiceDetail(invoiceSelectedId);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function runLegacyInvoiceImport() {
    if (!legacyInvoiceFile) {
      setMessage("Select a FreshBooks invoice CSV file first.");
      return;
    }
    try {
      const form = new FormData();
      form.append("file", legacyInvoiceFile);
      form.append("mapping_overrides", legacyInvoiceMappingJson);
      const res = await fetch(`${API_BASE}/invoices/import/freshbooks?apply=${legacyInvoiceApply ? "true" : "false"}`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as LegacyInvoiceImportResult;
      setLegacyInvoiceSummary(
        `Rows: ${payload.count} | Imported: ${payload.imported} | Updated: ${payload.updated} | Errors: ${payload.errors}`,
      );
      setMessage(legacyInvoiceApply ? "Legacy invoices imported." : "Legacy invoice import preview ready.");
      if (legacyInvoiceApply) {
        refreshInvoices();
        refreshArSummary();
      }
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function createRecurringSchedule() {
    if (!canManageProjects) {
      setMessage("You do not have permission to manage recurring invoices.");
      return;
    }
    const dueDays = Number(recurringDueDays);
    if (!Number.isFinite(dueDays) || dueDays < 1 || dueDays > 120) {
      setMessage("Due days must be between 1 and 120.");
      return;
    }
    if (!isValidYmd(recurringNextRunDate)) {
      setMessage("Use a valid next run date in YYYY-MM-DD format.");
      return;
    }
    try {
      const schedule = await apiPost<RecurringInvoiceSchedule>("/invoices/recurring/schedules", {
        name: recurringName,
        project_id: recurringProjectId,
        cadence: recurringCadence,
        approved_only: recurringApprovedOnly,
        due_days: dueDays,
        next_run_date: recurringNextRunDate,
        auto_send_email: recurringAutoSendEmail,
        recipient_email: recurringRecipientEmail || null,
        notes_template: recurringNotesTemplate,
        is_active: true,
      });
      setMessage(`Recurring schedule created: ${schedule.name}.`);
      refreshRecurringSchedules();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function toggleRecurringSchedule(schedule: RecurringInvoiceSchedule) {
    if (!canManageProjects) {
      setMessage("You do not have permission to manage recurring invoices.");
      return;
    }
    try {
      await apiPut<RecurringInvoiceSchedule>(`/invoices/recurring/schedules/${schedule.id}`, {
        is_active: !schedule.is_active,
      });
      setMessage(`Recurring schedule ${schedule.is_active ? "paused" : "activated"}.`);
      refreshRecurringSchedules();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function runRecurringInvoicesNow() {
    if (!canManageProjects) {
      setMessage("You do not have permission to run recurring invoices.");
      return;
    }
    try {
      const res = await apiPost<RecurringInvoiceRunResult>("/invoices/recurring/run", {});
      setMessage(
        `Recurring run complete. Created: ${res.invoices_created}, considered: ${res.schedules_considered}, skipped(no billable): ${res.skipped_no_billable_entries}, skipped(existing): ${res.skipped_existing_for_period}, errors: ${res.errors}.`,
      );
      refreshInvoices();
      refreshArSummary();
      refreshRecurringSchedules();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function exportTimesheetSummaryCsv(mode: "weekly" | "monthly") {
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) {
      setMessage("Use valid report start/end dates in YYYY-MM-DD format.");
      return;
    }
    try {
      const params = new URLSearchParams({ start: reportStart, end: reportEnd, mode });
      const res = await fetch(`${API_BASE}/timesheets/summary.csv?${params.toString()}`, {
        method: "GET",
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.setAttribute("download", `timesheet_summary_${mode}_${reportStart}_${reportEnd}.csv`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage(`Timesheet summary (${mode}) CSV exported.`);
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <main style={{ margin: "0 auto", maxWidth: 1140, padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <img src="/Aqt_Logo.png" alt="Aquatech Engineering P.C." style={{ width: 240, height: "auto" }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 34, lineHeight: 1.05, letterSpacing: "0.3px" }}>Project Controls Dashboard</h1>
            <p style={{ margin: "4px 0 0 0", color: "#345042" }}>Projects, staffing, time, and margin intelligence</p>
          </div>
        </div>
        {me && (
          <div style={{ border: "1px solid #dfe6e2", borderRadius: 8, padding: "6px 8px", minWidth: 210, fontSize: 12 }}>
            <div style={{ color: "#456354", marginBottom: 4 }}>
              Signed in: <strong>{me.email}</strong> ({me.role})
            </div>
            <button onClick={handleLogout} style={{ fontSize: 12, padding: "4px 8px" }}>Logout</button>
          </div>
        )}
      </div>
      {message && <p style={{ color: "#0a5" }}>{message}</p>}

      {!me && (
        <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
          <h2>Access</h2>
          {!DEV_AUTH_ENABLED && (
            <div style={{ marginBottom: 12 }}>
              <button onClick={handleGoogleSignIn}>Sign In With Google</button>
            </div>
          )}
          {DEV_AUTH_ENABLED && (
            <>
              <p style={{ marginTop: 0, color: "#345042" }}>
                Team access mode is active. Sign in with your company email below.
              </p>
              <form onSubmit={handleBootstrap} style={{ marginBottom: 12 }}>
                <h3>Bootstrap Admin (first run only)</h3>
                <input value={bootstrapEmail} onChange={(e) => setBootstrapEmail(e.target.value)} placeholder="admin@aquatechpc.com" />
                <input value={bootstrapName} onChange={(e) => setBootstrapName(e.target.value)} placeholder="Admin name" />
                <button type="submit">Create Admin</button>
              </form>

              <form onSubmit={handleLogin}>
                <h3>Dev Login</h3>
                <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="user@aquatechpc.com" />
                <button type="submit">Sign In</button>
              </form>
            </>
          )}
        </section>
      )}

      {me && (
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, alignItems: "start" }}>
          <aside style={{ border: "1px solid #ddd", padding: 12, position: "sticky", top: 12 }}>
            <h3 style={{ marginTop: 0 }}>Navigation</h3>
            <div style={{ display: "grid", gap: 8 }}>
              <button
                onClick={() => {
                  setActiveView("dashboard");
                  setDashboardSubView("overview");
                }}
                disabled={activeView === "dashboard"}
              >
                Dashboard
              </button>
              <button
                onClick={() => {
                  setEntryDate(null);
                  setEditingEntryId(null);
                  setActiveView("time");
                  setTimeSubView("entry");
                }}
                disabled={activeView === "time"}
              >
                Time Entry
              </button>
              <button
                onClick={() => {
                  setActiveView("timesheets");
                  setTimesheetSubView("mine");
                }}
                disabled={activeView === "timesheets"}
              >
                Timesheets
              </button>
              <button
                onClick={() => {
                  setActiveView("projects");
                  setProjectSubView("cockpit");
                }}
                disabled={activeView === "projects"}
              >
                Projects
              </button>
              <button
                onClick={() => {
                  setActiveView("people");
                  setPeopleSubView("profiles");
                }}
                disabled={activeView === "people"}
              >
                People & Rates
              </button>
              <button
                onClick={() => {
                  setActiveView("accounting");
                  setAccountingSubView("workspace");
                }}
                disabled={activeView === "accounting"}
              >
                Accounting
              </button>
            </div>
            {activeView === "dashboard" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>Dashboard</strong>
                <button onClick={() => setDashboardSubView("overview")} disabled={dashboardSubView === "overview"}>Overview</button>
              </div>
            )}
            {activeView === "time" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>Time Entry</strong>
                <button onClick={() => setTimeSubView("entry")} disabled={timeSubView === "entry"}>Log Time</button>
              </div>
            )}
            {activeView === "timesheets" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>Timesheets</strong>
                <button onClick={() => setTimesheetSubView("mine")} disabled={timesheetSubView === "mine"}>My Timesheet</button>
                {canApproveTimesheets && (
                  <button onClick={() => setTimesheetSubView("team")} disabled={timesheetSubView === "team"}>Team Review</button>
                )}
              </div>
            )}
            {activeView === "projects" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>Projects</strong>
                <button onClick={() => setProjectSubView("cockpit")} disabled={projectSubView === "cockpit"}>Project Cockpit</button>
                <button onClick={() => setProjectSubView("editor")} disabled={projectSubView === "editor"}>Active Projects</button>
                {canManageProjects && (
                  <button onClick={() => setProjectSubView("setup")} disabled={projectSubView === "setup"}>Create Project</button>
                )}
                {canViewFinancials && (
                  <button onClick={() => setProjectSubView("performance")} disabled={projectSubView === "performance"}>Performance</button>
                )}
              </div>
            )}
            {activeView === "people" && canManageUsers && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>People</strong>
                <button onClick={() => setPeopleSubView("profiles")} disabled={peopleSubView === "profiles"}>Employee Profiles</button>
                <button onClick={() => setPeopleSubView("pending")} disabled={peopleSubView === "pending"}>Pending Activation</button>
              </div>
            )}
            {activeView === "accounting" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10, display: "grid", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#555" }}>Accounting</strong>
                <button onClick={() => setAccountingSubView("workspace")} disabled={accountingSubView === "workspace"}>Workspace</button>
              </div>
            )}
          </aside>
          <div>
          {activeView === "dashboard" && dashboardSubView === "overview" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Dashboard</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a", fontSize: 13 }}>
                Financial KPI context: <strong>{dashboardKpiContextLabel}</strong>
              </p>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "8px 0 10px 0" }}>
                <button onClick={() => applyReportPreset("weekly")} disabled={reportPreset === "weekly"}>
                  Weekly
                </button>
                <button onClick={() => applyReportPreset("monthly")} disabled={reportPreset === "monthly"}>
                  Monthly
                </button>
                <button onClick={() => applyReportPreset("annual")} disabled={reportPreset === "annual"}>
                  Annual
                </button>
                <button onClick={() => applyReportPreset("custom")} disabled={reportPreset === "custom"}>
                  Custom
                </button>
                <input
                  type="date"
                  value={reportStart}
                  onChange={(e) => {
                    setReportPreset("custom");
                    setReportStart(e.target.value);
                  }}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                />
                <input
                  type="date"
                  value={reportEnd}
                  onChange={(e) => {
                    setReportPreset("custom");
                    setReportEnd(e.target.value);
                  }}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 10 }}>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Budget (PTD)<br /><strong><Currency value={dashboardStats.budget} digits={0} /></strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Revenue (PTD)<br /><strong><Currency value={dashboardStats.revenue} digits={0} /></strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Cost (PTD)<br /><strong><Currency value={dashboardStats.cost} digits={0} /></strong></div>
                <div style={{ border: "1px solid #eee", padding: 10, color: dashboardStats.profit >= 0 ? "#0a7a2f" : "#b00020" }}>
                  Profit (PTD)<br /><strong><Currency value={dashboardStats.profit} digits={0} /></strong>
                </div>
              </div>
              <p style={{ marginTop: 10 }}>
                Submitted timesheets awaiting approval: <strong>{dashboardStats.submittedCount}</strong> | Pending users: <strong>{dashboardStats.pendingUsers}</strong>
              </p>
              {canViewFinancials && (
                <div style={{ marginTop: 14 }}>
                  <h3 style={{ marginBottom: 8 }}>Project Metrics</h3>
                  {dashboardProjectPerformance.length === 0 && <p>No non-placeholder project metrics in this range.</p>}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(280px, 1fr))", gap: 8 }}>
                  {dashboardProjectPerformance.map((p) => {
                    const billable = p.project_is_billable ?? true;
                    const succeeding = billable ? (p.target_margin_gap_pct >= 0 && p.actual_profit >= 0) : true;
                    const color = billable ? (succeeding ? "#0a7a2f" : "#b00020") : "#666";
                    const expanded = !!dashboardExpandedProjects[p.project_id];
                    return (
                      <div key={`dash-proj-${p.project_id}`} style={{ border: "1px solid #eee", padding: 8, fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <div>
                            <strong style={{ fontSize: 13 }}>{p.project_name}</strong>
                            <span style={{ marginLeft: 8, color }}>
                              {billable ? (succeeding ? "On Target" : "At Risk") : "Non-billable (cost only)"}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", color, fontSize: 12 }}>
                            <span>Profit <Currency value={p.actual_profit} digits={0} /></span>
                            <span>Margin {p.margin_pct.toFixed(1)}%</span>
                            <span>Gap {p.target_margin_gap_pct.toFixed(1)}%</span>
                            <button onClick={() => setDashboardExpandedProjects((prev) => ({ ...prev, [p.project_id]: !prev[p.project_id] }))}>
                              {expanded ? "-" : "+"}
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div style={{ marginTop: 8, borderTop: "1px solid #f2f2f2", paddingTop: 8 }}>
                            <div>Budget (PTD) <Currency value={p.overall_budget_fee} /> | Revenue (PTD) <Currency value={p.actual_revenue} /> | Cost (PTD) <Currency value={p.actual_cost} /></div>
                            <div>Target Margin {p.target_gross_margin_pct.toFixed(1)}% | Target Profit <Currency value={p.target_profit} /> | Profit Gap <Currency value={p.target_profit_gap} /></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}
              {canManageUsers && (
                <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 10 }}>
                  <div style={{ border: "1px solid #ead0d0", background: "#fff6f6", padding: 10 }}>
                    <strong style={{ color: "#b00020" }}>At-Risk Projects</strong>
                    <div>{dashboardAtRiskProjects.length}</div>
                    {dashboardAtRiskProjects.slice(0, 3).map((p) => (
                      <div key={`risk-${p.project_id}`} style={{ fontSize: 12 }}>
                        {p.project_name}
                      </div>
                    ))}
                  </div>
                  <div style={{ border: "1px solid #efe2bf", background: "#fffaf0", padding: 10 }}>
                    <strong style={{ color: "#946200" }}>Missing Timesheets</strong>
                    <div>{dashboardMissingTimesheets.length}</div>
                    {dashboardMissingTimesheets.slice(0, 3).map((u) => (
                      <div key={`mts-${u.id}`} style={{ fontSize: 12 }}>
                        {u.email}
                      </div>
                    ))}
                  </div>
                  <div style={{ border: "1px solid #d9e7d9", background: "#f8fff8", padding: 10 }}>
                    <strong style={{ color: "#205d2f" }}>Users Without Rates</strong>
                    <div>{dashboardUsersWithoutRates.length}</div>
                    {dashboardUsersWithoutRates.slice(0, 3).map((u) => (
                      <div key={`nrate-${u.id}`} style={{ fontSize: 12 }}>
                        {u.email}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {canManageUsers && activeView === "people" && peopleSubView === "pending" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Pending Users</h2>
              <div style={{ marginBottom: 10 }}>
                <button onClick={provisionDefaultStaff}>Provision Aquatech Staff</button>
              </div>
              {pendingUsers.length === 0 && <p>No pending users.</p>}
              {pendingUsers.map((u) => (
                <div key={u.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{u.email}</span>
                  <button onClick={() => activateUser(u.id)}>Activate</button>
                </div>
              ))}
            </section>
          )}

          {activeView === "projects" && projectSubView === "cockpit" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Project Cockpit</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Operational cockpit for active projects, status, margin signal, and budget tracking.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Active Projects<br /><strong>{projectCockpitRows.length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>At Risk<br /><strong>{projectCockpitRows.filter((r) => r.status === "At Risk").length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>On Target<br /><strong>{projectCockpitRows.filter((r) => r.status === "On Target").length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Non-billable<br /><strong>{projectCockpitRows.filter((r) => r.status === "Non-billable (cost only)").length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>No Data<br /><strong>{projectCockpitRows.filter((r) => r.status === "No financial data yet").length}</strong></div>
              </div>
              {projectCockpitRows.length === 0 && <p>No active projects found.</p>}
              {projectCockpitRows.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>PM</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Budget</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Revenue</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projectCockpitRows.map((r) => (
                        <tr key={`cockpit-proj-${r.id}`}>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.name}</td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.client}</td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.pm}</td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                            <span style={{ color: r.status === "At Risk" ? "#b00020" : r.status === "On Target" ? "#0a7a2f" : "#666" }}>{r.status}</span>
                          </td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.budget} /></td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.revenue} /></td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.cost} /></td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.profit === null ? "-" : <Currency value={r.profit} />}</td>
                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.margin === null ? "-" : `${r.margin.toFixed(1)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {canManageProjects && activeView === "projects" && projectSubView === "setup" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Project Setup</h2>
              <form onSubmit={createProject} style={{ marginBottom: 8 }}>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Project Name</span>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name" />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Client Name</span>
                  <input value={projectClient} onChange={(e) => setProjectClient(e.target.value)} placeholder="Client" />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Project Start Date</span>
                  <input
                    type="date"
                    value={projectStartDate}
                    onChange={(e) => setProjectStartDate(e.target.value)}
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Overall Budget Fee</span>
                  <input value={projectOverallBudget} onChange={(e) => setProjectOverallBudget(e.target.value)} placeholder="Overall budget fee" />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Target Gross Margin %</span>
                  <input value={projectTargetMargin} onChange={(e) => setProjectTargetMargin(e.target.value)} placeholder="Target gross margin %" />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Project Manager</span>
                  <select value={projectPmUserId ?? ""} onChange={(e) => setProjectPmUserId(e.target.value ? Number(e.target.value) : null)}>
                    {pmUserOptions.length === 0 && <option value="">No users available</option>}
                    {pmUserOptions.map((u) => (
                      <option key={`pm-opt-${u.id}`} value={u.id}>
                        {u.full_name || u.email}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center", marginRight: 8, marginTop: 18 }}>
                  <input type="checkbox" checked={projectIsBillable} onChange={(e) => setProjectIsBillable(e.target.checked)} />
                  Billable Project
                </label>
                <button type="submit">Create Project</button>
              </form>
              <form onSubmit={createTask} style={{ marginBottom: 8 }}>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Task Name</span>
                  <input value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="Task name" />
                </label>
                <button type="submit">Create Task</button>
              </form>
              <form onSubmit={createSubtask}>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Subtask Code</span>
                  <input value={subtaskCode} onChange={(e) => setSubtaskCode(e.target.value)} placeholder="Code" />
                </label>
                <label style={{ display: "inline-flex", flexDirection: "column", marginRight: 8 }}>
                  <span>Subtask Name</span>
                  <input value={subtaskName} onChange={(e) => setSubtaskName(e.target.value)} placeholder="Subtask" />
                </label>
                <button type="submit">Create Subtask</button>
              </form>
            </section>
          )}

          {activeView === "time" && timeSubView === "entry" && <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
            <h2>Timesheet Entry</h2>
            {canManageRates && (
              <details style={{ marginBottom: 10 }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Rate settings</summary>
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="date"
                    value={rateDate}
                    onChange={(e) => setRateDate(e.target.value)}
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                    placeholder="YYYY-MM-DD"
                  />
                  <input value={rateBill} onChange={(e) => setRateBill(e.target.value)} placeholder="Bill Rate (max 4 dp)" />
                  <input value={rateCost} onChange={(e) => setRateCost(e.target.value)} placeholder="Cost Rate (max 4 dp)" />
                  <button onClick={addRate}>Save My Rate</button>
                </div>
              </details>
            )}
            <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong>Period:</strong>
              <select value={timeViewMode} onChange={(e) => setTimeViewMode(e.target.value as TimeViewMode)}>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
              <button onClick={() => shiftTimeRange(-1)}>Prev</button>
              <button onClick={() => setTimeAnchorDate(new Date().toISOString().slice(0, 10))}>Today</button>
              <button onClick={() => shiftTimeRange(1)}>Next</button>
              <span>{displayedGridLabel}</span>
              {timeViewMode === "month" && monthWeekRanges.length > 1 && (
                <>
                  <button onClick={() => setMonthWeekIndex((v) => Math.max(0, v - 1))} disabled={monthWeekIndex === 0}>
                    Prev Week
                  </button>
                  <button
                    onClick={() => setMonthWeekIndex((v) => Math.min(monthWeekRanges.length - 1, v + 1))}
                    disabled={monthWeekIndex >= monthWeekRanges.length - 1}
                  >
                    Next Week
                  </button>
                </>
              )}
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {(canManageUsers || canApproveTimesheets) && (
                <select value={timeFilterUserId ?? ""} onChange={(e) => setTimeFilterUserId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Me</option>
                  {allUsers.map((u) => (
                    <option key={`time-user-${u.id}`} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </select>
              )}
              <select value={timeFilterProjectId ?? ""} onChange={(e) => setTimeFilterProject(e.target.value ? Number(e.target.value) : null)}>
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={`tf-proj-${p.id}`} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={timeFilterTaskId ?? ""}
                onChange={(e) => {
                  setTimeFilterTaskId(e.target.value ? Number(e.target.value) : null);
                  setTimeFilterSubtaskId(null);
                }}
              >
                <option value="">All tasks</option>
                {(timeFilterProjectId ? wbsByProject[timeFilterProjectId] || [] : []).map((t) => (
                  <option key={`tf-task-${t.id}`} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select value={timeFilterSubtaskId ?? ""} onChange={(e) => setTimeFilterSubtaskId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">All subtasks</option>
                {((timeFilterProjectId ? wbsByProject[timeFilterProjectId] || [] : []).find((t) => t.id === timeFilterTaskId)?.subtasks || []).map((s) => (
                  <option key={`tf-sub-${s.id}`} value={s.id}>
                    {s.code} - {s.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setTimeFilterUserId(null);
                  setTimeFilterProjectId(null);
                  setTimeFilterTaskId(null);
                  setTimeFilterSubtaskId(null);
                }}
              >
                Clear Filters
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <h3 style={{ margin: "8px 0" }}>Timesheet Grid</h3>
              <div style={{ overflowX: "auto", border: "1px solid #cfd8df", borderRadius: 6 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: Math.max(960, 380 + displayedGridDates.length * 92) }}>
                  <thead>
                    <tr style={{ background: "#f7f9fb" }}>
                      <th style={{ borderBottom: "1px solid #cfd8df", borderRight: "1px solid #e1e7ec", textAlign: "left", padding: 8 }}>Project</th>
                      <th style={{ borderBottom: "1px solid #cfd8df", borderRight: "1px solid #e1e7ec", textAlign: "left", padding: 8 }}>Task</th>
                      <th style={{ borderBottom: "1px solid #cfd8df", borderRight: "1px solid #e1e7ec", textAlign: "left", padding: 8 }}>Subtask</th>
                      {displayedGridDates.map((day) => (
                        <th key={`grid-head-${day}`} style={{ borderBottom: "1px solid #cfd8df", borderLeft: "1px solid #e1e7ec", textAlign: "center", padding: 8, minWidth: 92, background: "#f4f7fa" }}>
                          <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
                            <span style={{ fontSize: 12 }}>{dayLabelFromYmd(day)}</span>
                            <button onClick={() => openEntryForDate(day)} title={`Add entry on ${day}`}>+</button>
                          </div>
                        </th>
                      ))}
                      <th style={{ borderBottom: "1px solid #cfd8df", borderLeft: "1px solid #e1e7ec", textAlign: "right", padding: 8 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeGridRows.length === 0 && (
                      <tr>
                        <td colSpan={displayedGridDates.length + 4} style={{ padding: 10, color: "#666" }}>
                          No rows yet for this period. Use + on any day to add time.
                        </td>
                      </tr>
                    )}
                    {timeGridRows.map((row) => (
                      <tr key={`grid-row-${row.key}`}>
                        <td style={{ borderBottom: "1px solid #e5ebf0", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>{row.projectLabel}</td>
                        <td style={{ borderBottom: "1px solid #e5ebf0", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>{row.taskLabel}</td>
                        <td style={{ borderBottom: "1px solid #e5ebf0", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>{row.subtaskLabel}</td>
                        {displayedGridDates.map((day) => (
                          (() => {
                            const noteList = row.byDayNotes[day] || [];
                            const noteTitle = noteList.length > 0 ? noteList.join("\n") : `Open entries for ${day}`;
                            return (
                          <td
                            key={`grid-cell-${row.key}-${day}`}
                            onClick={() => openEntryForDate(day)}
                            title={noteTitle}
                            style={{ borderBottom: "1px solid #e5ebf0", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "center", cursor: "pointer", background: row.byDay[day] ? "#fbfdff" : "#fff" }}
                          >
                            {row.byDay[day] ? (
                              <div style={{ display: "grid", gap: 2, justifyItems: "center" }}>
                                <strong style={{ fontSize: 12 }}>{row.byDay[day].toFixed(2)}</strong>
                                {noteList.length > 0 && (
                                  <span style={{ fontSize: 10, color: "#567", maxWidth: 78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {noteList[0]}
                                  </span>
                                )}
                              </div>
                            ) : ""}
                          </td>
                            );
                          })()
                        ))}
                        <td style={{ borderBottom: "1px solid #e5ebf0", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "right", fontWeight: 700 }}>{row.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#fafbfd" }}>
                      <td colSpan={3} style={{ borderTop: "1px solid #cfd8df", padding: 8, fontWeight: 700 }}>Period Totals</td>
                      {displayedGridDates.map((day) => (
                        <td key={`grid-total-${day}`} style={{ borderTop: "1px solid #cfd8df", borderLeft: "1px solid #e1e7ec", padding: 8, textAlign: "center", fontWeight: 700 }}>
                          {Number(timeGridDayTotals[day] || 0).toFixed(2)}
                        </td>
                      ))}
                      <td style={{ borderTop: "1px solid #cfd8df", borderLeft: "1px solid #e1e7ec", padding: 8, textAlign: "right", fontWeight: 700 }}>
                        {displayedGridDates.reduce((sum, d) => sum + Number(timeGridDayTotals[d] || 0), 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {entryDate && (
                <div
                  style={{
                    position: "fixed",
                    top: 0,
                    right: 0,
                    height: "100%",
                    display: "block",
                    zIndex: 1000,
                    pointerEvents: "none",
                  }}
                >
                  <div
                    style={{
                      width: 460,
                      maxWidth: "100%",
                      height: "100%",
                      background: "#fff",
                      padding: 16,
                      overflowY: "auto",
                      boxShadow: "-2px 0 12px rgba(0,0,0,0.18)",
                      pointerEvents: "auto",
                    }}
                  >
                    <h4 style={{ margin: "0 0 8px 0" }}>{editingEntryId ? `Edit Entry #${editingEntryId}` : "Add Entry"} - {entryDate}</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <select value={entryProjectId ?? ""} onChange={(e) => setEntryProject(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">Project</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={entryTaskId ?? ""}
                        onChange={(e) => {
                          setEntryTaskId(e.target.value ? Number(e.target.value) : null);
                          setEntrySubtaskId(null);
                        }}
                      >
                        <option value="">Task</option>
                        {(entryProjectId ? wbsByProject[entryProjectId] || [] : []).map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <select value={entrySubtaskId ?? ""} onChange={(e) => setEntrySubtaskId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">Subtask</option>
                        {((entryProjectId ? wbsByProject[entryProjectId] || [] : []).find((t) => t.id === entryTaskId)?.subtasks || []).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.code} - {s.name}
                          </option>
                        ))}
                      </select>
                      <input value={entryHours} onChange={(e) => setEntryHours(e.target.value)} placeholder="Hours" />
                      <input value={entryNote} onChange={(e) => setEntryNote(e.target.value)} placeholder="Note" />
                      <button onClick={saveSelectedDayEntry}>{editingEntryId ? "Update Entry" : "Save Entry"}</button>
                      <button onClick={closeEntryModal}>
                        Close
                      </button>
                    </div>
                    <div style={{ marginTop: 16 }}>
                      <h4 style={{ margin: "0 0 8px 0" }}>Entries On {entryDate}</h4>
                      {selectedDayEntries.length === 0 && <p>No entries on this day yet.</p>}
                      {selectedDayEntries.map((entry) => (
                        <div key={entry.id} style={{ border: "1px solid #eee", padding: 8, marginBottom: 8 }}>
                          <div>
                            {entry.hours}h | {entry.project_name || `P${entry.project_id}`} / {entry.task_name || `T${entry.task_id}`} / {entry.subtask_code ? `${entry.subtask_code} ${entry.subtask_name || ""}` : `S${entry.subtask_id}`}
                          </div>
                          <div>{entry.note || "-"}</div>
                          <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                            <button onClick={() => editExistingEntry(entry)}>Edit</button>
                            <button onClick={() => deleteEntry(entry.id)}>Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Entries in view ({timeEntries.length})</summary>
              <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#666" }}>Active period: {displayedGridLabel}</span>
              </div>
              <div style={{ marginTop: 8, overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project/Task/Subtask</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Bill</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeEntries.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: 8, color: "#666" }}>No time entries in this range.</td>
                      </tr>
                    )}
                    {timeEntries.map((entry) => (
                      <tr key={`entry-row-${entry.id}`}>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{entry.work_date}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{entry.hours.toFixed(2)}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                          {entry.project_name || `P${entry.project_id}`} / {entry.task_name || `T${entry.task_id}`} / {entry.subtask_code ? `${entry.subtask_code} ${entry.subtask_name || ""}` : `S${entry.subtask_id}`}
                        </td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={entry.bill_rate_applied} /></td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={entry.cost_rate_applied} /></td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{entry.note || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </section>}

          {canManageUsers && activeView === "people" && peopleSubView === "profiles" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>People & Rates</h2>
              <p>Select an employee and edit profile dates/details and rates in one panel.</p>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "inline-flex", flexDirection: "column", minWidth: 360 }}>
                  <span>Select Employee</span>
                  <select
                    value={peopleEditorUserId ?? ""}
                    onChange={(e) => setPeopleEditorUserId(e.target.value ? Number(e.target.value) : null)}
                  >
                    {allUsers.length === 0 && <option value="">No users</option>}
                    {allUsers.map((u) => (
                      <option key={`people-user-opt-${u.id}`} value={u.id}>
                        {u.full_name || u.email} ({u.email})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedPeopleUser && (
                <div style={{ border: "1px solid #eee", padding: 12, minHeight: 160 }}>
                  <h3 style={{ marginTop: 0, marginBottom: 10 }}>
                    {selectedPeopleUser.full_name || selectedPeopleUser.email}
                  </h3>
                  <div style={{ marginBottom: 10 }}>{selectedPeopleUser.email}</div>
                  {(() => {
                    const pd = peopleDrafts[selectedPeopleUser.id] || {
                      full_name: selectedPeopleUser.full_name || "",
                      start_date: selectedPeopleUser.start_date || "",
                      role: selectedPeopleUser.role || "employee",
                      is_active: !!selectedPeopleUser.is_active,
                    };
                    return (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>Employee Profile</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(160px, 1fr))", gap: 10, alignItems: "end" }}>
                          <label style={{ display: "inline-flex", flexDirection: "column" }}>
                            <span>Full Name</span>
                            <input value={pd.full_name} onChange={(e) => setPeopleDraft(selectedPeopleUser.id, { full_name: e.target.value })} placeholder="Full name" />
                          </label>
                          <label style={{ display: "inline-flex", flexDirection: "column" }}>
                            <span>Employee Start Date</span>
                            <input
                              type="date"
                              value={pd.start_date}
                              onChange={(e) => setPeopleDraft(selectedPeopleUser.id, { start_date: e.target.value })}
                              onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                              onClick={(e) => showNativeDatePicker(e.currentTarget)}
                            />
                          </label>
                          <label style={{ display: "inline-flex", flexDirection: "column" }}>
                            <span>Role</span>
                            <select value={pd.role} onChange={(e) => setPeopleDraft(selectedPeopleUser.id, { role: e.target.value })}>
                              <option value="employee">employee</option>
                              <option value="manager">manager</option>
                              <option value="admin">admin</option>
                            </select>
                          </label>
                          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                            <input type="checkbox" checked={pd.is_active} onChange={(e) => setPeopleDraft(selectedPeopleUser.id, { is_active: e.target.checked })} />
                            Active
                          </label>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <button onClick={() => saveUserProfile(selectedPeopleUser.id)}>Save Employee Profile</button>
                        </div>
                      </div>
                    );
                  })()}
                  {canManageRates ? (
                    <>
                      {(() => {
                        const d = rateDrafts[selectedPeopleUser.id] || {
                          effective_date: latestRates[selectedPeopleUser.id]?.effective_date || new Date().toISOString().slice(0, 10),
                          bill_rate: latestRates[selectedPeopleUser.id] ? String(latestRates[selectedPeopleUser.id].bill_rate) : "220",
                          cost_rate: latestRates[selectedPeopleUser.id] ? String(latestRates[selectedPeopleUser.id].cost_rate) : "90",
                        };
                        return (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 10, alignItems: "end", borderTop: "1px solid #f1f1f1", paddingTop: 10 }}>
                            <label style={{ display: "inline-flex", flexDirection: "column" }}>
                              <span>Effective Date</span>
                              <input
                                type="date"
                                value={d.effective_date}
                                onChange={(e) => setRateDraft(selectedPeopleUser.id, { effective_date: e.target.value })}
                                onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                                onClick={(e) => showNativeDatePicker(e.currentTarget)}
                                placeholder="YYYY-MM-DD"
                              />
                            </label>
                            <label style={{ display: "inline-flex", flexDirection: "column" }}>
                              <span>Bill Rate</span>
                              <input value={d.bill_rate} onChange={(e) => setRateDraft(selectedPeopleUser.id, { bill_rate: e.target.value })} placeholder="Bill Rate (max 4 dp)" />
                            </label>
                            <label style={{ display: "inline-flex", flexDirection: "column" }}>
                              <span>Cost Rate</span>
                              <input value={d.cost_rate} onChange={(e) => setRateDraft(selectedPeopleUser.id, { cost_rate: e.target.value })} placeholder="Cost Rate (max 4 dp)" />
                            </label>
                          </div>
                        );
                      })()}
                      <div style={{ marginTop: 10 }}>
                        <button onClick={() => saveRateForUser(selectedPeopleUser.id)}>Save Employee Rate</button>
                      </div>
                      <div style={{ marginTop: 10, borderTop: "1px solid #f1f1f1", paddingTop: 10 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>Override Existing Entry Rates</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            type="date"
                            value={reapplyRateStart}
                            onChange={(e) => setReapplyRateStart(e.target.value)}
                            onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                            onClick={(e) => showNativeDatePicker(e.currentTarget)}
                          />
                          <input
                            type="date"
                            value={reapplyRateEnd}
                            onChange={(e) => setReapplyRateEnd(e.target.value)}
                            onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                            onClick={(e) => showNativeDatePicker(e.currentTarget)}
                          />
                          <button onClick={() => reapplyRatesForEntries(selectedPeopleUser.id)}>
                            Reapply This Employee Rates
                          </button>
                          <button onClick={() => reapplyRatesForEntries(null)}>
                            Reapply All Employee Rates
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <p style={{ marginTop: 8, color: "#666" }}>You can edit employee profile fields here. Rate editing requires rate permission.</p>
                  )}
                </div>
              )}
            </section>
          )}

          {activeView === "timesheets" && timesheetSubView === "mine" && <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
            <h2 style={{ marginTop: 0 }}>My Timesheets</h2>
            <p style={{ marginTop: 4, color: "#4a4a4a" }}>Generate your week, then select a period to review that one timesheet.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
              <div style={{ border: "1px solid #eee", padding: 10 }}>Weeks<br /><strong>{myTimesheetSummary.total}</strong></div>
              <div style={{ border: "1px solid #eee", padding: 10 }}>Hours<br /><strong>{myTimesheetSummary.hours.toFixed(2)}</strong></div>
              <div style={{ border: "1px solid #eee", padding: 10 }}>Submitted<br /><strong>{myTimesheetSummary.submitted}</strong></div>
              <div style={{ border: "1px solid #eee", padding: 10 }}>Approved<br /><strong>{myTimesheetSummary.approved}</strong></div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <button onClick={generateTimesheet}>Generate Current Week</button>
              <select value={myTimesheetPeriodFilter} onChange={(e) => setMyTimesheetPeriodFilter(e.target.value)}>
                <option value="">Select period</option>
                {availableMyTimesheetPeriods.map((p) => (
                  <option key={`my-ts-period-${p}`} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {!ALLOW_TIMESHEET_SUBMIT && <span style={{ color: "#8a5a00", fontSize: 12 }}>Submit is disabled until staff launch next week.</span>}
            </div>
            {!myTimesheetPeriodFilter && <p>Select a period to display a timesheet.</p>}
            {myTimesheetPeriodFilter && selectedMyTimesheets.length === 0 && <p>No timesheet found for this period.</p>}
            {myTimesheetPeriodFilter && selectedMyTimesheets.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Week</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedMyTimesheets.map((t) => (
                      <tr key={`my-ts-${t.id}`}>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{t.week_start} to {t.week_end}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                          <span style={{ ...timesheetStatusStyle(t.status), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                            {t.status}
                          </span>
                        </td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right", fontWeight: 700 }}>{Number(t.total_hours || 0).toFixed(2)}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            {t.status === "draft" && ALLOW_TIMESHEET_SUBMIT && <button onClick={() => submitTimesheet(t.id)}>Submit</button>}
                            {t.status === "submitted" && canApproveTimesheets && <button onClick={() => approveTimesheet(t.id)}>Approve</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>}

          {canApproveTimesheets && activeView === "timesheets" && timesheetSubView === "team" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2 style={{ marginTop: 0 }}>Team Timesheets</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Select an employee and period, then review and approve only that specific timesheet.</p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <button onClick={() => applyReportPreset("weekly")} disabled={reportPreset === "weekly"}>
                  Weekly
                </button>
                <button onClick={() => applyReportPreset("monthly")} disabled={reportPreset === "monthly"}>
                  Monthly
                </button>
                <button onClick={() => applyReportPreset("annual")} disabled={reportPreset === "annual"}>
                  Annual
                </button>
                <button onClick={() => applyReportPreset("custom")} disabled={reportPreset === "custom"}>
                  Custom
                </button>
                <input
                  type="date"
                  value={reportStart}
                  onChange={(e) => setReportStart(e.target.value)}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  placeholder="YYYY-MM-DD"
                />
                <input
                  type="date"
                  value={reportEnd}
                  onChange={(e) => setReportEnd(e.target.value)}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  placeholder="YYYY-MM-DD"
                />
                <select value={timesheetStatusFilter} onChange={(e) => setTimesheetStatusFilter(e.target.value)}>
                  <option value="">All statuses</option>
                  <option value="draft">draft</option>
                  <option value="submitted">submitted</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                </select>
                <select
                  value={timesheetUserFilter ?? ""}
                  onChange={(e) => {
                    setTimesheetUserFilter(e.target.value ? Number(e.target.value) : null);
                    setTimesheetPeriodFilter("");
                  }}
                >
                  <option value="">Select employee</option>
                  {availableTimesheetUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name || u.email} ({u.email})
                    </option>
                  ))}
                </select>
                <select value={timesheetPeriodFilter} onChange={(e) => setTimesheetPeriodFilter(e.target.value)}>
                  <option value="">{timesheetUserFilter ? "Select period" : "Select employee first"}</option>
                  {availableTimesheetPeriods.map((p) => (
                    <option key={`ts-period-${p}`} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button onClick={generateTimesheetsForRange}>Generate Timesheets In Range</button>
                <button onClick={approveVisibleSubmittedTimesheets}>Approve Submitted In View</button>
                <button onClick={() => exportTimesheetSummaryCsv("weekly")}>Export Weekly CSV</button>
                <button onClick={() => exportTimesheetSummaryCsv("monthly")}>Export Monthly CSV</button>
              </div>
              {!timesheetUserFilter && <p>Select an employee to begin.</p>}
              {timesheetUserFilter && !timesheetPeriodFilter && <p>Select a period for the chosen employee.</p>}
              {timesheetUserFilter && timesheetPeriodFilter && selectedAdminTimesheets.length === 0 && <p>No timesheet found for this employee and period.</p>}
              {timesheetUserFilter && timesheetPeriodFilter && selectedAdminTimesheets.length > 0 && (
                <div style={{ border: "1px solid #eee", borderRadius: 8, maxHeight: 320, overflowY: "auto", padding: 8 }}>
                  {selectedAdminTimesheets.map((t) => (
                    <details key={`admin-ts-${t.id}`} style={{ marginBottom: 6, borderBottom: "1px solid #f3f3f3", paddingBottom: 6 }}>
                      <summary style={{ cursor: "pointer" }}>
                        {t.user_email} | {t.week_start} to {t.week_end} |{" "}
                        <span style={{ ...timesheetStatusStyle(t.status), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                          {t.status}
                        </span>{" "}
                        | {t.total_hours}h
                      </summary>
                      <div style={{ marginTop: 6, paddingLeft: 12 }}>
                        <div>Employee: {t.user_full_name}</div>
                        <div>Status: {t.status}</div>
                        <div>Total Hours: {t.total_hours}h</div>
                        {t.status === "submitted" && (
                          <button style={{ marginTop: 6 }} onClick={() => approveTimesheet(t.id)}>
                            Approve
                          </button>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 }}>
                <h3 style={{ marginTop: 0 }}>Time Entry Details (Selected Employee)</h3>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                  <select value={adminEntryUserId ?? ""} onChange={(e) => setAdminEntryUserId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Select employee</option>
                    {allUsers.map((u) => (
                      <option key={`ad-user-${u.id}`} value={u.id}>
                        {u.email}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={adminEntryStart}
                    onChange={(e) => setAdminEntryStart(e.target.value)}
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                    placeholder="YYYY-MM-DD"
                  />
                  <input
                    type="date"
                    value={adminEntryEnd}
                    onChange={(e) => setAdminEntryEnd(e.target.value)}
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                    placeholder="YYYY-MM-DD"
                  />
                  <select value={adminEntryProjectId ?? ""} onChange={(e) => setAdminFilterProject(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">All projects</option>
                    {projects.map((p) => (
                      <option key={`ad-proj-${p.id}`} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={adminEntryTaskId ?? ""}
                    onChange={(e) => {
                      setAdminEntryTaskId(e.target.value ? Number(e.target.value) : null);
                      setAdminEntrySubtaskId(null);
                    }}
                  >
                    <option value="">All tasks</option>
                    {(adminEntryProjectId ? wbsByProject[adminEntryProjectId] || [] : []).map((t) => (
                      <option key={`ad-task-${t.id}`} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <select value={adminEntrySubtaskId ?? ""} onChange={(e) => setAdminEntrySubtaskId(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">All subtasks</option>
                    {((adminEntryProjectId ? wbsByProject[adminEntryProjectId] || [] : []).find((t) => t.id === adminEntryTaskId)?.subtasks || []).map((s) => (
                      <option key={`ad-sub-${s.id}`} value={s.id}>
                        {s.code} - {s.name}
                      </option>
                    ))}
                  </select>
                  <button onClick={exportAdminEntryCsv} disabled={!adminEntryUserId}>
                    Export CSV
                  </button>
                </div>
                {adminEntryUserId && adminEntryRows.length === 0 && <p>No entries for selected filters.</p>}
                {adminEntryRows.length > 0 && (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Total Hours</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Entries</th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminEntriesByDay.map((g) => {
                          const total = g.rows.reduce((sum, r) => sum + Number(r.hours || 0), 0);
                          const expanded = !!adminExpandedDays[g.day];
                          return (
                            <tr key={`ad-group-row-${g.day}`}>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{g.day}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{total.toFixed(2)}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                  <button
                                    onClick={() =>
                                      setAdminExpandedDays((prev) => ({ ...prev, [g.day]: !prev[g.day] }))
                                    }
                                  >
                                    {expanded ? "Hide entries" : "Show entries"}
                                  </button>
                                </td>
                              </tr>
                          );
                        })}
                        {adminEntriesByDay.map((g) => {
                          const expanded = !!adminExpandedDays[g.day];
                          if (!expanded) return null;
                          return (
                            <tr key={`ad-group-detail-${g.day}`}>
                                  <td colSpan={3} style={{ borderBottom: "1px solid #eee", padding: 6, background: "#fafafa" }}>
                                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                      <thead>
                                        <tr>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Hours</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Subtask</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Bill</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Cost</th>
                                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {g.rows.map((r) => (
                                          <tr key={`ad-row-${r.id}`}>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.hours}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.project_name || `Project ${r.project_id}`}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.task_name || `Task ${r.task_id}`}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.subtask_code ? `${r.subtask_code} - ${r.subtask_name || ""}` : `Subtask ${r.subtask_id}`}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.bill_rate_applied}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.cost_rate_applied}</td>
                                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.note}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {adminEntryRows.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 10 }}>
                    <h4 style={{ marginTop: 0 }}>Summary By Employee And Project</h4>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                      <button onClick={() => setAdminSummaryMode("weekly")} disabled={adminSummaryMode === "weekly"}>
                        Weekly
                      </button>
                      <button onClick={() => setAdminSummaryMode("monthly")} disabled={adminSummaryMode === "monthly"}>
                        Monthly
                      </button>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Period</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Revenue</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminSummaryRows.map((r, idx) => (
                            <tr key={`admin-summary-${idx}`}>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.period}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.employee}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.project}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.revenue} /></td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.cost} /></td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.profit} /></td>
                            </tr>
                          ))}
                          <tr>
                            <td colSpan={3} style={{ borderTop: "2px solid #ddd", padding: 6, fontWeight: 700 }}>Totals</td>
                            <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}>{adminSummaryTotals.hours.toFixed(2)}</td>
                            <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}><Currency value={adminSummaryTotals.revenue} /></td>
                            <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}><Currency value={adminSummaryTotals.cost} /></td>
                            <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}><Currency value={adminSummaryTotals.profit} /></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {canViewFinancials && activeView === "projects" && projectSubView === "performance" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Project Performance</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <button onClick={() => applyReportPreset("weekly")} disabled={reportPreset === "weekly"}>
                  Weekly
                </button>
                <button onClick={() => applyReportPreset("monthly")} disabled={reportPreset === "monthly"}>
                  Monthly
                </button>
                <button onClick={() => applyReportPreset("annual")} disabled={reportPreset === "annual"}>
                  Annual
                </button>
                <button onClick={() => applyReportPreset("custom")} disabled={reportPreset === "custom"}>
                  Custom
                </button>
                <input
                  type="date"
                  value={reportStart}
                  onChange={(e) => setReportStart(e.target.value)}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  placeholder="YYYY-MM-DD"
                />
                <input
                  type="date"
                  value={reportEnd}
                  onChange={(e) => setReportEnd(e.target.value)}
                  onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                  onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  placeholder="YYYY-MM-DD"
                />
                <button onClick={exportProjectPerformanceCsv}>Export CSV</button>
              </div>
              {projectPerformance.length === 0 && <p>No projects found.</p>}
              {projectPerformance.length > 0 && (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ display: "inline-flex", flexDirection: "column", minWidth: 360 }}>
                      <span>Select Project</span>
                      <select
                        value={performanceProjectId ?? ""}
                        onChange={(e) => setPerformanceProjectId(e.target.value ? Number(e.target.value) : null)}
                      >
                        {projectPerformance.map((p) => (
                          <option key={`perf-select-${p.project_id}`} value={p.project_id}>
                            {p.project_name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {selectedPerformanceProject && (
                    <div style={{ border: "1px solid #eee", padding: 12 }}>
                      <h3 style={{ marginTop: 0 }}>{selectedPerformanceProject.project_name}</h3>
                      {(selectedPerformanceProject.project_is_billable ?? true) ? (
                        <div style={{ color: selectedPerformanceProject.target_margin_gap_pct >= 0 ? "#0a7a2f" : "#b00020", marginBottom: 8 }}>
                          Margin {selectedPerformanceProject.margin_pct.toFixed(1)}% | Target {selectedPerformanceProject.target_gross_margin_pct.toFixed(1)}% | Gap {selectedPerformanceProject.target_margin_gap_pct.toFixed(1)}%
                        </div>
                      ) : (
                        <div style={{ color: "#666", marginBottom: 8 }}>
                          Non-billable project: cost-only tracking (revenue and margin targets are not applied).
                        </div>
                      )}
                      <div>
                        Overall Budget <Currency value={selectedPerformanceProject.overall_budget_fee} /> | WBS Budget <Currency value={selectedPerformanceProject.budget_fee} /> | Revenue <Currency value={selectedPerformanceProject.actual_revenue} /> | Cost <Currency value={selectedPerformanceProject.actual_cost} /> | Profit <Currency value={selectedPerformanceProject.actual_profit} />
                      </div>
                      {(selectedPerformanceProject.project_is_billable ?? true) && (
                        <div style={{ marginTop: 6 }}>
                          Target Profit <Currency value={selectedPerformanceProject.target_profit} /> | Profit Gap <Currency value={selectedPerformanceProject.target_profit_gap} />
                        </div>
                      )}

                      {[
                        { key: "emp", title: "By Employee", rows: selectedPerformanceProject.by_employee.map((r) => `${r.email} | ${r.hours.toFixed(2)}h | Rev ${formatCurrency(r.revenue)} | Cost ${formatCurrency(r.cost)} | Profit ${formatCurrency(r.profit)}`) },
                        { key: "task", title: "By Task", rows: selectedPerformanceProject.by_task.map((r) => `${r.task_name} | ${r.hours.toFixed(2)}h | Rev ${formatCurrency(r.revenue)} | Cost ${formatCurrency(r.cost)} | Profit ${formatCurrency(r.profit)}`) },
                        { key: "sub", title: "By Subtask", rows: selectedPerformanceProject.by_subtask.map((r) => `${r.subtask_code} ${r.subtask_name} | ${r.hours.toFixed(2)}h | Rev ${formatCurrency(r.revenue)} | Cost ${formatCurrency(r.cost)} | Profit ${formatCurrency(r.profit)}`) },
                      ].map((section) => {
                        const sectionKey = `${selectedPerformanceProject.project_id}-${section.key}`;
                        const expanded = !!performanceExpanded[sectionKey];
                        return (
                          <div key={`perf-section-${sectionKey}`} style={{ marginTop: 10, borderTop: "1px solid #f2f2f2", paddingTop: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <strong>{section.title}</strong>
                              <button onClick={() => setPerformanceExpanded((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }))}>
                                {expanded ? "-" : "+"}
                              </button>
                            </div>
                            {expanded && (
                              <div style={{ marginTop: 6 }}>
                                {section.rows.length === 0 && <div>No data</div>}
                                {section.rows.map((line, idx) => (
                                  <div key={`perf-row-${sectionKey}-${idx}`}>{line}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {activeView === "projects" && projectSubView === "editor" && <section style={{ border: "1px solid #ddd", padding: 16 }}>
            <h2>Projects</h2>
            <p>Edit project info and WBS budgets below.</p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "inline-flex", flexDirection: "column", minWidth: 360 }}>
                <span>Select Project</span>
                <select
                  value={projectEditorProjectId ?? ""}
                  onChange={(e) => setProjectEditorProjectId(e.target.value ? Number(e.target.value) : null)}
                >
                  {projects.length === 0 && <option value="">No projects</option>}
                  {projects.map((p) => (
                    <option key={`project-editor-opt-${p.id}`} value={p.id}>
                      #{p.id} - {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {(() => {
              const p = projects.find((proj) => proj.id === projectEditorProjectId);
              if (!p) return <p>Select a project to edit details and WBS.</p>;
              const pd = projectDrafts[p.id] || {
                name: p.name,
                client_name: p.client_name || "",
                pm_user_id: p.pm_user_id ? String(p.pm_user_id) : "",
                start_date: p.start_date || "",
                overall_budget_fee: String(p.overall_budget_fee || 0),
                target_gross_margin_pct: String(p.target_gross_margin_pct || 0),
                is_overhead: p.is_overhead,
                is_billable: p.is_billable,
                is_active: p.is_active,
              };
              const tasks = wbsByProject[p.id] || [];
              return (
                <div key={`proj-edit-${p.id}`} style={{ border: "1px solid #eee", padding: 14, marginBottom: 12, minHeight: 520 }}>
                  <h3 style={{ marginTop: 0, marginBottom: 12 }}>
                    Project #{p.id}: {p.name}
                  </h3>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: "inline-flex", flexDirection: "column", minWidth: 260 }}>
                      <span>Project Start Date</span>
                      <input
                        type="date"
                        value={pd.start_date}
                        onChange={(e) => setProjectDraft(p.id, { start_date: e.target.value })}
                        onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                        onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      />
                    </label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Project Name</span>
                      <input value={pd.name} onChange={(e) => setProjectDraft(p.id, { name: e.target.value })} placeholder="Project name" />
                    </label>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Client Name</span>
                      <input value={pd.client_name} onChange={(e) => setProjectDraft(p.id, { client_name: e.target.value })} placeholder="Client name" />
                    </label>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>PM User ID</span>
                      <select value={pd.pm_user_id} onChange={(e) => setProjectDraft(p.id, { pm_user_id: e.target.value })}>
                        <option value="">Select PM</option>
                        {pmUserOptions.map((u) => (
                          <option key={`edit-pm-opt-${u.id}`} value={u.id}>
                            {u.full_name || u.email}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Overall Budget Fee</span>
                      <input
                        value={pd.overall_budget_fee}
                        onChange={(e) => setProjectDraft(p.id, { overall_budget_fee: e.target.value })}
                        placeholder="Overall budget fee"
                      />
                    </label>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Target Gross Margin %</span>
                      <input
                        value={pd.target_gross_margin_pct}
                        onChange={(e) => setProjectDraft(p.id, { target_gross_margin_pct: e.target.value })}
                        placeholder="Target gross margin %"
                      />
                    </label>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="checkbox" checked={pd.is_overhead} onChange={(e) => setProjectDraft(p.id, { is_overhead: e.target.checked })} />
                        Overhead
                      </label>
                      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="checkbox" checked={pd.is_billable} onChange={(e) => setProjectDraft(p.id, { is_billable: e.target.checked })} />
                        Billable
                      </label>
                      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="checkbox" checked={pd.is_active} onChange={(e) => setProjectDraft(p.id, { is_active: e.target.checked })} />
                        Active
                      </label>
                    </div>
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button onClick={() => saveProject(p.id)}>Save Project</button>
                    <button onClick={() => ensureProjectWbs(p.id)}>Load WBS</button>
                    <button onClick={() => seedStandardWbs(p.id)}>Apply Standard 10x4 WBS</button>
                  </div>
                  {maxAchievableMarginPct !== null && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#5b4a00" }}>
                      Current max estimated margin from configured rates: {maxAchievableMarginPct.toFixed(1)}%
                    </div>
                  )}

                  <div style={{ marginTop: 12, borderTop: "1px solid #f1f1f1", paddingTop: 10 }}>
                    <h4 style={{ margin: "0 0 8px 0" }}>Project Expenses</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                      <input
                        type="date"
                        value={expenseDate}
                        onChange={(e) => setExpenseDate(e.target.value)}
                        onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                        onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      />
                      <input value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)} placeholder="Category" />
                      <input value={expenseDescription} onChange={(e) => setExpenseDescription(e.target.value)} placeholder="Description" />
                      <input value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="Amount" />
                      <button onClick={() => addProjectExpense(p.id)}>Add Expense</button>
                      <button onClick={() => refreshProjectExpenses(p.id)}>Refresh Expenses</button>
                    </div>
                    <div style={{ maxHeight: 170, overflowY: "auto", border: "1px solid #f1f1f1", padding: 8 }}>
                      {(projectExpenses[p.id] || []).length === 0 && <div style={{ color: "#666" }}>No expenses logged yet.</div>}
                      {(projectExpenses[p.id] || []).map((ex) => (
                        <div key={`exp-${ex.id}`} style={{ borderBottom: "1px solid #f4f4f4", padding: "4px 0" }}>
                          {ex.expense_date} | {ex.category} | {formatCurrency(Number(ex.amount || 0))} | {ex.description || "-"}
                        </div>
                      ))}
                    </div>
                  </div>

                  {tasks.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      {tasks.map((t) => (
                        <div key={`task-edit-${t.id}`} style={{ borderTop: "1px solid #f1f1f1", paddingTop: 8, marginTop: 8 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <strong>Task #{t.id}</strong>
                            <label style={{ display: "inline-flex", flexDirection: "column" }}>
                              <span>Task Name</span>
                              <input
                                value={taskDrafts[t.id]?.name || t.name}
                                onChange={(e) => setTaskDraft(t.id, { name: e.target.value })}
                                placeholder="Task name"
                              />
                            </label>
                            <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={taskDrafts[t.id]?.is_billable ?? t.is_billable}
                                onChange={(e) => setTaskDraft(t.id, { is_billable: e.target.checked })}
                              />
                              Billable
                            </label>
                            <button onClick={() => saveTask(t.id)}>Save Task</button>
                          </div>
                          <div style={{ marginTop: 6 }}>
                            {(t.subtasks || []).map((s) => {
                              const sd = subtaskDrafts[s.id] || {
                                code: s.code,
                                name: s.name,
                                budget_hours: String(s.budget_hours),
                                budget_fee: String(s.budget_fee),
                              };
                              return (
                                <div key={`sub-edit-${s.id}`} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                                  <span>Subtask #{s.id}</span>
                                  <label style={{ display: "inline-flex", flexDirection: "column" }}>
                                    <span>Code</span>
                                    <input value={sd.code} onChange={(e) => setSubtaskDraft(s.id, { code: e.target.value })} placeholder="Code" />
                                  </label>
                                  <label style={{ display: "inline-flex", flexDirection: "column" }}>
                                    <span>Name</span>
                                    <input value={sd.name} onChange={(e) => setSubtaskDraft(s.id, { name: e.target.value })} placeholder="Name" />
                                  </label>
                                  <label style={{ display: "inline-flex", flexDirection: "column" }}>
                                    <span>Budget Hours</span>
                                    <input value={sd.budget_hours} onChange={(e) => setSubtaskDraft(s.id, { budget_hours: e.target.value })} placeholder="Budget hours" />
                                  </label>
                                  <label style={{ display: "inline-flex", flexDirection: "column" }}>
                                    <span>Budget Fee</span>
                                    <input value={sd.budget_fee} onChange={(e) => setSubtaskDraft(s.id, { budget_fee: e.target.value })} placeholder="Budget fee" />
                                  </label>
                                  <button onClick={() => saveSubtask(s.id)}>Save Subtask</button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </section>}

          {activeView === "accounting" && accountingSubView === "workspace" && (
            <section style={{ border: "1px solid #ddd", padding: 16 }}>
              <h2>Accounting</h2>
              <p>Use this area for invoicing, recurring billing setup, invoice continuity imports, and A/R tracking.</p>
              {canViewFinancials && (
                <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Invoicing Studio</h3>
                  <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                    Select a period, preview billable lines from timesheets, then create a branded invoice.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                    <select value={invoicePeriodPreset} onChange={(e) => applyInvoicePeriodPreset(e.target.value as InvoicePeriodPreset)}>
                      <option value="custom">Custom Period</option>
                      <option value="weekly">This Week</option>
                      <option value="monthly">This Month</option>
                      <option value="annual">This Year</option>
                      <option value="last30">Last 30 Days</option>
                    </select>
                    <input
                      type="date"
                      value={invoiceStart}
                      onChange={(e) => {
                        setInvoicePeriodPreset("custom");
                        setInvoiceStart(e.target.value);
                      }}
                      onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                      onClick={(e) => showNativeDatePicker(e.currentTarget)}
                    />
                    <input
                      type="date"
                      value={invoiceEnd}
                      onChange={(e) => {
                        setInvoicePeriodPreset("custom");
                        setInvoiceEnd(e.target.value);
                      }}
                      onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                      onClick={(e) => showNativeDatePicker(e.currentTarget)}
                    />
                    <select value={invoiceProjectId ?? ""} onChange={(e) => setInvoiceProjectId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">All projects</option>
                      {projects.map((p) => (
                        <option key={`inv-proj-${p.id}`} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={invoiceApprovedOnly} onChange={(e) => setInvoiceApprovedOnly(e.target.checked)} />
                      Approved timesheets only
                    </label>
                    <button onClick={refreshInvoicePreview}>Refresh Preview</button>
                    <button onClick={createInvoiceFromPeriod}>Create Draft Invoice</button>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <textarea
                      value={invoiceNotes}
                      onChange={(e) => setInvoiceNotes(e.target.value)}
                      rows={2}
                      placeholder="Invoice notes / payment terms"
                      style={{ width: "100%" }}
                    />
                  </div>
                  {invoicePreview && (
                    <div style={{ border: "1px solid #e6ece8", borderRadius: 10, padding: 12, marginBottom: 12, background: "linear-gradient(180deg,#fff,#f8fbf9)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <img src="/Aqt_Logo.png" alt="Aquatech Engineering P.C." style={{ width: 120, height: "auto" }} />
                          <div>
                            <div style={{ fontWeight: 700 }}>Invoice Preview</div>
                            <div style={{ color: "#4a4a4a", fontSize: 13 }}>
                              {invoicePreview.client_name} | {invoicePreview.start} to {invoicePreview.end}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(100px, 1fr))", gap: 8 }}>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>Lines<br /><strong>{invoicePreview.line_count}</strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>Hours<br /><strong>{invoicePreview.total_hours.toFixed(2)}</strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>Subtotal<br /><strong><Currency value={invoicePreview.subtotal_amount} /></strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>Profit<br /><strong><Currency value={invoicePreview.total_profit} /></strong></div>
                        </div>
                      </div>
                      <div style={{ overflowX: "auto", marginTop: 10, maxHeight: 280, overflowY: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                          <thead>
                            <tr>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task/Subtask</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Rate</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {invoicePreview.lines.map((line) => (
                              <tr key={`inv-preview-line-${line.source_time_entry_id}`}>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.work_date}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.employee}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.project}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.task} / {line.subtask}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.note || "-"}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{line.hours.toFixed(2)}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.bill_rate} /></td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.amount} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                  </div>
                </div>
              )}

              {invoiceViewerOpen && selectedInvoice && (
                <div style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,0.55)" }}>
                  {(() => {
                    const template = invoiceTemplateMeta(selectedInvoice);
                    return (
                  <div style={{ position: "absolute", inset: "2% 2%", background: "#fff", borderRadius: 10, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto 1fr auto" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #e6e6e6" }}>
                      <div style={{ fontWeight: 700, fontSize: 18 }}>Invoice {selectedInvoice.invoice_number} <span style={{ fontWeight: 500, color: "#4a4a4a", fontSize: 13 }}>({template.label} template)</span></div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => downloadInvoicePdf(selectedInvoice)}>Download PDF</button>
                        {selectedInvoice.status !== "sent" && selectedInvoice.status !== "paid" && selectedInvoice.status !== "void" && (
                          <button onClick={markInvoiceAsSent}>Mark as Sent</button>
                        )}
                        <button onClick={() => setInvoiceViewerOpen(false)}>Close</button>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "10px 14px", borderBottom: "1px solid #eee", fontSize: 13 }}>
                      <div>
                        <strong>Place Company Letterhead Here</strong>
                        <div>Aquatech Engineering P.C.</div>
                        <div>15 Bonita Vista Road</div>
                        <div>Mount Vernon, NY 10552</div>
                      </div>
                      <div />
                      <div>
                        <strong>Bill To:</strong>
                        {template.billToLines.map((line, idx) => (
                          <div key={`billto-line-${idx}`}>{line}</div>
                        ))}
                      </div>
                      <div><strong>Invoice Number:</strong> {selectedInvoice.invoice_number}</div>
                      <div><strong>{template.periodLabel}:</strong> {selectedInvoice.start_date} to {selectedInvoice.end_date}</div>
                      <div><strong>Date Issued:</strong> {selectedInvoice.issue_date}</div>
                      {template.references.map((ref, idx) => (
                        <div key={`inv-ref-${idx}`}><strong>{ref.label}:</strong> {ref.value}</div>
                      ))}
                    </div>
                    <div style={{ overflow: "auto", padding: 14 }}>
                      {invoiceRenderContext && invoiceRenderContext.invoice_id === selectedInvoice.id && invoiceRenderContext.summary_rows.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Contract Summary by Task</div>
                          <table style={{ borderCollapse: "collapse", width: "100%" }}>
                            <thead>
                              <tr>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Total Billed Previously</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>This Invoice</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Total Billed to Date</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Contract Maximum</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Contract Balance Remaining</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>% This Invoice</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>% To Date</th>
                              </tr>
                            </thead>
                            <tbody>
                              {invoiceRenderContext.summary_rows.map((r, idx) => (
                                <tr key={`inv-contract-sum-${idx}`}>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.task}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.previously_billed} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.this_invoice} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.billed_to_date} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.contract_maximum} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.contract_balance_remaining} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.pct_complete_this_invoice.toFixed(2)}%</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.pct_complete_to_date.toFixed(2)}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div style={{ marginTop: 8, fontSize: 12 }}>
                            <strong>Authorized Signature:</strong> Bertrand Byrne, CEO | <strong>Title:</strong> Aquatech Engineering P.C.
                          </div>
                        </div>
                      )}
                      {(() => {
                        const byTask: Record<string, { task: string; hours: number; amount: number }> = {};
                        const byEmployee: Record<string, { employee: string; hours: number; amount: number }> = {};
                        for (const line of selectedInvoice.lines) {
                          const key = `${line.task} / ${line.subtask}`;
                          if (!byTask[key]) byTask[key] = { task: key, hours: 0, amount: 0 };
                          byTask[key].hours += Number(line.hours || 0);
                          byTask[key].amount += Number(line.amount || 0);

                          const empKey = line.employee || "Unassigned";
                          if (!byEmployee[empKey]) byEmployee[empKey] = { employee: empKey, hours: 0, amount: 0 };
                          byEmployee[empKey].hours += Number(line.hours || 0);
                          byEmployee[empKey].amount += Number(line.amount || 0);
                        }
                        const rows = Object.values(byTask).sort((a, b) => a.task.localeCompare(b.task));
                        const empRows = Object.values(byEmployee).sort((a, b) => a.employee.localeCompare(b.employee));
                        return (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>Labor Billing Summary by Task</div>
                            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                              <thead>
                                <tr>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.map((r, idx) => (
                                  <tr key={`inv-task-sum-${idx}`}>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.task}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.amount} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div style={{ fontWeight: 700, margin: "12px 0 6px" }}>Labor Summary</div>
                            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                              <thead>
                                <tr>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {empRows.map((r, idx) => (
                                  <tr key={`inv-emp-sum-${idx}`}>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.employee}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.amount} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })()}
                      {(() => {
                        const taskMath = buildInvoiceTaskMath(selectedInvoice.lines);
                        if (taskMath.length === 0) return null;
                        return (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>Professional Services Rate Math</div>
                            {taskMath.map((tm, idx) => (
                              <div key={`task-math-${idx}`} style={{ border: "1px solid #ececec", padding: 8, marginBottom: 8 }}>
                                <div style={{ fontWeight: 700, marginBottom: 6 }}>Task - {tm.task}</div>
                                {tm.staffRows.length > 0 && (
                                  <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: 8 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee Name</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Direct Salary Rate</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {tm.staffRows.map((r, j) => (
                                        <tr key={`task-math-staff-${idx}-${j}`}>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.employee}</td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.directRate} /></td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.amount} /></td>
                                        </tr>
                                      ))}
                                      <tr><td colSpan={3} style={{ padding: 6 }}><strong>Direct Salary</strong></td><td style={{ padding: 6, textAlign: "right" }}><Currency value={tm.staffDirect} /></td></tr>
                                      <tr><td colSpan={3} style={{ padding: 6 }}>Overhead Rate @114%</td><td style={{ padding: 6, textAlign: "right" }}><Currency value={tm.staffOverhead} /></td></tr>
                                      <tr><td colSpan={3} style={{ padding: 6 }}>Profit @ 10% on Labor & OH</td><td style={{ padding: 6, textAlign: "right" }}><Currency value={tm.staffProfit} /></td></tr>
                                      <tr><td colSpan={3} style={{ padding: 6 }}><strong>Direct Labor</strong></td><td style={{ padding: 6, textAlign: "right" }}><strong><Currency value={tm.staffSubtotal} /></strong></td></tr>
                                    </tbody>
                                  </table>
                                )}
                                {tm.principalRows.length > 0 && (
                                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                    <thead>
                                      <tr>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee Name</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Billing Rate</th>
                                        <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {tm.principalRows.map((r, j) => (
                                        <tr key={`task-math-principal-${idx}-${j}`}>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.employee}</td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.hours.toFixed(2)}</td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.billRate} /></td>
                                          <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.amount} /></td>
                                        </tr>
                                      ))}
                                      <tr><td colSpan={3} style={{ padding: 6 }}>Overhead Rate @114%</td><td style={{ padding: 6, textAlign: "right" }}><Currency value={tm.principalOverhead} /></td></tr>
                                      <tr><td colSpan={3} style={{ padding: 6 }}><strong>Direct Labor</strong></td><td style={{ padding: 6, textAlign: "right" }}><strong><Currency value={tm.principalSubtotal} /></strong></td></tr>
                                    </tbody>
                                  </table>
                                )}
                                <div style={{ marginTop: 6 }}><strong>Total Labor:</strong> <Currency value={tm.totalLabor} /></div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Professional Services and Expense Detail</div>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task/Subtask</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Rate</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedInvoice.lines.map((line) => (
                            <tr key={`full-inv-line-${line.id}`}>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.work_date}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.employee || "-"}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.project || "-"}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.task} / {line.subtask}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.note || "-"}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{line.hours.toFixed(2)}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.bill_rate} /></td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.amount} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {invoiceRenderContext && invoiceRenderContext.invoice_id === selectedInvoice.id && invoiceRenderContext.appendix_weeks.length > 0 && (
                        <div style={{ marginTop: 14 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Timesheet Support (Full Employee Timesheets)</div>
                          {invoiceRenderContext.appendix_weeks.map((wk, idx) => (
                            <div key={`appendix-week-${idx}`} style={{ border: "1px solid #e6e6e6", padding: 10, marginBottom: 10 }}>
                              <div style={{ fontSize: 13, marginBottom: 6 }}>
                                <strong>Employee:</strong> {wk.employee} ({wk.email || "-"}) | <strong>Week:</strong> {wk.week_start} to {wk.week_end} |{" "}
                                <strong>Weekly Hours:</strong> {wk.total_hours.toFixed(2)} | <strong>Invoiced Hours:</strong> {wk.invoiced_hours.toFixed(2)}
                              </div>
                              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                                <thead>
                                  <tr>
                                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task/Subtask</th>
                                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                                    <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {wk.entries.map((e) => (
                                    <tr key={`appendix-entry-${e.time_entry_id}`} style={e.is_invoiced ? { background: "#eef4ff", boxShadow: "inset 0 0 0 2px #2f6fed" } : undefined}>
                                      <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{e.work_date}</td>
                                      <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{e.project}</td>
                                      <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{e.task} / {e.subtask}</td>
                                      <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{e.note || "-"}</td>
                                      <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{e.hours.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ padding: "10px 14px", borderTop: "1px solid #eee", display: "flex", justifyContent: "flex-end", gap: 16 }}>
                      <span>Subtotal <strong><Currency value={selectedInvoice.subtotal_amount} /></strong></span>
                      <span>Paid <strong><Currency value={selectedInvoice.amount_paid} /></strong></span>
                      <span>Balance <strong><Currency value={selectedInvoice.balance_due} /></strong></span>
                    </div>
                  </div>
                    );
                  })()}
                </div>
              )}

                  <div style={{ borderTop: "1px solid #eee", paddingTop: 10 }}>
                    <h4 style={{ marginTop: 0 }}>Saved Invoices</h4>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                      <select value={invoiceSelectedId ?? ""} onChange={(e) => setInvoiceSelectedId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">Select invoice</option>
                        {savedInvoices.map((inv) => (
                          <option key={`inv-opt-${inv.id}`} value={inv.id}>
                            {inv.invoice_number} | {inv.client_name} | {inv.start_date} to {inv.end_date}
                          </option>
                        ))}
                      </select>
                      <button onClick={refreshInvoices}>Refresh Invoices</button>
                    </div>
                    {selectedInvoice && (
                      <div style={{ border: "1px solid #eee", padding: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <div>
                            <strong>{selectedInvoice.invoice_number}</strong> | {selectedInvoice.client_name}
                            <div style={{ fontSize: 13, color: "#4a4a4a" }}>
                              Period: {selectedInvoice.start_date} to {selectedInvoice.end_date} | Issued: {selectedInvoice.issue_date} | source: {selectedInvoice.source} |{" "}
                              <span style={{ ...invoiceStatusStyle(selectedInvoice.status), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                                {selectedInvoice.status}
                              </span>
                            </div>
                          </div>
                          <img src="/Aqt_Logo.png" alt="Aquatech Engineering P.C." style={{ width: 100, height: "auto" }} />
                        </div>
                        <div style={{ marginTop: 8 }}>
                          Subtotal <Currency value={selectedInvoice.subtotal_amount} /> | Paid <Currency value={selectedInvoice.amount_paid} /> | Balance <Currency value={selectedInvoice.balance_due} /> | Cost <Currency value={selectedInvoice.total_cost} /> | Profit <Currency value={selectedInvoice.total_profit} /> | Lines {selectedInvoice.line_count}
                        </div>
                        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button onClick={() => setInvoiceViewerOpen(true)}>Open Fullscreen</button>
                          <button onClick={() => downloadInvoicePdf(selectedInvoice)}>Download PDF</button>
                          {selectedInvoice.status !== "sent" && selectedInvoice.status !== "paid" && selectedInvoice.status !== "void" && (
                            <button onClick={markInvoiceAsSent}>Mark as Sent</button>
                          )}
                        </div>
                        {selectedInvoice.notes && (
                          <div style={{ marginTop: 6, color: "#4a4a4a" }}>
                            Notes: {selectedInvoice.notes}
                          </div>
                        )}
                        {selectedInvoice.lines.length > 0 && (
                          <div style={{ marginTop: 10, maxHeight: 240, overflowY: "auto", border: "1px solid #f1f1f1" }}>
                            <table style={{ borderCollapse: "collapse", width: "100%" }}>
                              <thead>
                                <tr>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Date</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Employee</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Task/Subtask</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Note</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Rate</th>
                                  <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Amount</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedInvoice.lines.map((line) => (
                                  <tr key={`saved-line-${line.id}`}>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.work_date}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.employee || "-"}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.task} / {line.subtask}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{line.note || "-"}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{line.hours.toFixed(2)}</td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.bill_rate} /></td>
                                    <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={line.amount} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {ENABLE_CLIENT_PAYMENT_LINKS && (
                          <div style={{ marginTop: 10, borderTop: "1px solid #f1f1f1", paddingTop: 10 }}>
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>Payment Link</div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <input value={paymentLinkDays} onChange={(e) => setPaymentLinkDays(e.target.value)} placeholder="Expiry days" />
                              <button onClick={generatePaymentLink}>Generate Link</button>
                              {selectedInvoice.payment_link_url && (
                                <a href={selectedInvoice.payment_link_url} target="_blank" rel="noreferrer">
                                  Open Current Link
                                </a>
                              )}
                              {selectedInvoice.payment_link_expires_at && (
                                <span style={{ color: "#4a4a4a" }}>Expires: {selectedInvoice.payment_link_expires_at}</span>
                              )}
                            </div>
                            {generatedPaymentLink && (
                              <div style={{ marginTop: 6 }}>
                                <div style={{ fontSize: 12, color: "#4a4a4a" }}>Generated link</div>
                                <code style={{ wordBreak: "break-all" }}>{generatedPaymentLink}</code>
                              </div>
                            )}
                          </div>
                        )}
                        <div style={{ marginTop: 10, borderTop: "1px solid #f1f1f1", paddingTop: 10 }}>
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>Payment Status</div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <input value={invoicePaidAmount} onChange={(e) => setInvoicePaidAmount(e.target.value)} placeholder="Amount paid" />
                            <input
                              type="date"
                              value={invoicePaidDate}
                              onChange={(e) => setInvoicePaidDate(e.target.value)}
                              onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                              onClick={(e) => showNativeDatePicker(e.currentTarget)}
                            />
                            <select value={invoiceStatusDraft} onChange={(e) => setInvoiceStatusDraft(e.target.value)}>
                              <option value="draft">draft</option>
                              <option value="sent">sent</option>
                              <option value="partial">partial</option>
                              <option value="paid">paid</option>
                              <option value="void">void</option>
                            </select>
                            <button onClick={updateInvoicePayment}>Save Payment Update</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>Recurring Invoices</h4>
                    <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                      Configure weekly/monthly schedules and run due invoices automatically or on demand.
                    </p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 8 }}>
                      <input value={recurringName} onChange={(e) => setRecurringName(e.target.value)} placeholder="Schedule name" />
                      <select value={recurringProjectId ?? ""} onChange={(e) => setRecurringProjectId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">All projects</option>
                        {projects.map((p) => (
                          <option key={`rec-proj-${p.id}`} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <select value={recurringCadence} onChange={(e) => setRecurringCadence(e.target.value as "weekly" | "monthly")}>
                        <option value="weekly">weekly</option>
                        <option value="monthly">monthly</option>
                      </select>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={recurringApprovedOnly} onChange={(e) => setRecurringApprovedOnly(e.target.checked)} />
                        Approved only
                      </label>
                      <input value={recurringDueDays} onChange={(e) => setRecurringDueDays(e.target.value)} placeholder="Due days" />
                      <input
                        type="date"
                        value={recurringNextRunDate}
                        onChange={(e) => setRecurringNextRunDate(e.target.value)}
                        onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                        onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      />
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={recurringAutoSendEmail} onChange={(e) => setRecurringAutoSendEmail(e.target.checked)} />
                        Auto-email on create
                      </label>
                      <input value={recurringRecipientEmail} onChange={(e) => setRecurringRecipientEmail(e.target.value)} placeholder="Recipient email (optional)" />
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <textarea
                        value={recurringNotesTemplate}
                        onChange={(e) => setRecurringNotesTemplate(e.target.value)}
                        rows={2}
                        placeholder="Default invoice notes for this schedule"
                        style={{ width: "100%" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={createRecurringSchedule}>Create Schedule</button>
                      <button onClick={runRecurringInvoicesNow}>Run Due Schedules Now</button>
                      <button onClick={refreshRecurringSchedules}>Refresh</button>
                    </div>
                    <div style={{ marginTop: 10, overflowX: "auto" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Name</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Cadence</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Next Run</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Last Run</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recurringSchedules.map((s) => (
                            <tr key={`rec-row-${s.id}`}>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{s.name}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{s.cadence}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                {s.project_id ? (projects.find((p) => p.id === s.project_id)?.name || `Project ${s.project_id}`) : "All projects"}
                              </td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{s.next_run_date}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{s.last_run_date || "-"}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{s.is_active ? "active" : "paused"}</td>
                              <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                <button onClick={() => toggleRecurringSchedule(s)}>{s.is_active ? "Pause" : "Activate"}</button>
                              </td>
                            </tr>
                          ))}
                          {recurringSchedules.length === 0 && (
                            <tr>
                              <td colSpan={7} style={{ padding: 8, color: "#666" }}>No recurring schedules yet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>Legacy FreshBooks Invoice Import</h4>
                    <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                      Import historical invoices for continuity and outstanding-payment tracking.
                    </p>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="file" accept=".csv,text/csv" onChange={(e) => setLegacyInvoiceFile(e.target.files?.[0] || null)} />
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={legacyInvoiceApply} onChange={(e) => setLegacyInvoiceApply(e.target.checked)} />
                        Apply import (unchecked = preview)
                      </label>
                      <button onClick={runLegacyInvoiceImport}>{legacyInvoiceApply ? "Run Legacy Import" : "Run Legacy Preview"}</button>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <p style={{ marginBottom: 4 }}>Legacy mapping overrides (JSON):</p>
                      <textarea
                        value={legacyInvoiceMappingJson}
                        onChange={(e) => setLegacyInvoiceMappingJson(e.target.value)}
                        rows={7}
                        style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                      />
                    </div>
                    {legacyInvoiceSummary && <p style={{ marginTop: 8 }}>{legacyInvoiceSummary}</p>}
                  </div>

                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>A/R Dashboard</h4>
                    {arSummary ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: 10, marginBottom: 10 }}>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Open Invoices<br /><strong>{arSummary.invoice_count_open}</strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Outstanding<br /><strong><Currency value={arSummary.total_outstanding} /></strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue Count<br /><strong>{arSummary.overdue_invoice_count}</strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue Amount<br /><strong><Currency value={arSummary.overdue_total} /></strong></div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 8, marginBottom: 10 }}>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>Current<br /><strong><Currency value={arSummary.aging.current} /></strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>1-30<br /><strong><Currency value={arSummary.aging["1_30"]} /></strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>31-60<br /><strong><Currency value={arSummary.aging["31_60"]} /></strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>61-90<br /><strong><Currency value={arSummary.aging["61_90"]} /></strong></div>
                          <div style={{ border: "1px solid #edf1ee", padding: 8 }}>90+<br /><strong><Currency value={arSummary.aging["90_plus"]} /></strong></div>
                        </div>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ borderCollapse: "collapse", width: "100%" }}>
                            <thead>
                              <tr>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Open Invoices</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Outstanding</th>
                                <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Overdue</th>
                              </tr>
                            </thead>
                            <tbody>
                              {arSummary.top_clients.map((r) => (
                                <tr key={`ar-client-${r.client_name}`}>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.client_name}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.invoice_count}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.outstanding} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.overdue} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : (
                      <p>No A/R summary yet.</p>
                    )}
                  </div>
                </div>
              )}
              {canViewFinancials && (
                <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Reconciliation Report</h3>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                    <button onClick={() => applyReportPreset("weekly")} disabled={reportPreset === "weekly"}>
                      Weekly
                    </button>
                    <button onClick={() => applyReportPreset("monthly")} disabled={reportPreset === "monthly"}>
                      Monthly
                    </button>
                    <button onClick={() => applyReportPreset("annual")} disabled={reportPreset === "annual"}>
                      Annual
                    </button>
                    <button onClick={() => applyReportPreset("custom")} disabled={reportPreset === "custom"}>
                      Custom
                    </button>
                    <input
                      type="date"
                      value={reportStart}
                      onChange={(e) => setReportStart(e.target.value)}
                      onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                      onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      placeholder="YYYY-MM-DD"
                    />
                    <input
                      type="date"
                      value={reportEnd}
                      onChange={(e) => setReportEnd(e.target.value)}
                      onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                      onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      placeholder="YYYY-MM-DD"
                    />
                    <button onClick={exportReconciliationCsv}>Export Reconciliation CSV</button>
                  </div>
                  {reconciliationSnapshot ? (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Users<br /><strong>{reconciliationSnapshot.users_total}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Projects<br /><strong>{reconciliationSnapshot.projects_total}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Time Entries<br /><strong>{reconciliationSnapshot.time_entries_total}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Rates<br /><strong>{reconciliationSnapshot.rates_total}</strong></div>
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                          <thead>
                            <tr>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Month</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Entries</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Bill</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Orphan Refs</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Bad Rates</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reconciliationMonthly.map((r) => (
                              <tr key={`recon-${r.period}`}>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.period}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.entry_count}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.total_hours.toFixed(2)}</td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.bill_amount} /></td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.cost_amount} /></td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.profit_amount} /></td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>
                                  {r.orphan_user_refs + r.orphan_project_refs + r.orphan_task_refs + r.orphan_subtask_refs}
                                </td>
                                <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.zero_or_negative_rate_entries}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p>No reconciliation data in this range.</p>
                  )}
                </div>
              )}
              <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                <h3 style={{ marginTop: 0 }}>FreshBooks Time CSV Import</h3>
                <p>Upload a FreshBooks time export. Use preview first, then apply.</p>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={importApply} onChange={(e) => setImportApply(e.target.checked)} />
                    Apply import (unchecked = preview)
                  </label>
                  <button onClick={runFreshbooksImport}>{importApply ? "Run Apply Import" : "Run Preview"}</button>
                </div>
                <div style={{ marginTop: 10 }}>
                  <p style={{ marginBottom: 4 }}>Mapping overrides (JSON):</p>
                  <textarea
                    value={importMappingJson}
                    onChange={(e) => setImportMappingJson(e.target.value)}
                    rows={8}
                    style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  />
                </div>
                {importSummary && <p style={{ marginTop: 8 }}>{importSummary}</p>}
              </div>
            </section>
          )}
          </div>
        </div>
      )}
    </main>
  );
}
