"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, apiDelete, apiGet, apiPost, apiPut } from "../lib/api";
import { computeBudgetKpis, marginPct, toNumber } from "../lib/kpi";
import { deriveUserCapabilities } from "../lib/permissions";
import { BankFeedQuickActions } from "./components/BankFeedQuickActions";
import { DashboardDataQualityPanel } from "./components/DashboardDataQualityPanel";
import { FreshbooksCsvImportPanel } from "./components/FreshbooksCsvImportPanel";
import { PayrollSection } from "./components/PayrollSection";
import { ReportPeriodControls } from "./components/ReportPeriodControls";
import { SettingsWorkspaceHome } from "./components/SettingsWorkspaceHome";
import { PRIMARY_ACTION_LABELS, WORKSPACE_HINTS, WORKSPACE_TITLES } from "./components/workspaceMeta";
import { useAutoSortableTables } from "./components/useAutoSortableTables";

declare global {
  interface Window {
    Plaid?: {
      create: (opts: {
        token: string;
        onSuccess: (public_token: string, metadata: unknown) => void;
        onExit?: (err: unknown, metadata: unknown) => void;
      }) => { open: () => void; destroy?: () => void };
    };
  }
}

const DEV_AUTH_ENABLED = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true";
const ENABLE_CLIENT_PAYMENT_LINKS = false;
const ALLOW_TIMESHEET_SUBMIT = true;
const NO_SUBTASK_CODE = "NO-SUBTASK";

type User = {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  start_date: string | null;
  permissions: string[];
};

type AuditEvent = {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_user_id: number | null;
  actor_user_email: string | null;
  payload_json: string;
  created_at: string;
};

type Project = {
  id: number;
  name: string;
  client_name: string | null;
  pm_user_id: number | null;
  start_date: string | null;
  end_date: string | null;
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
type ReportPreset = "weekly" | "monthly" | "annual" | "project_to_date" | "custom";
type InvoicePeriodPreset = "custom" | "weekly" | "monthly" | "annual" | "last30";
type DashboardView =
  | "dashboard"
  | "clients"
  | "estimates"
  | "time"
  | "timesheets"
  | "projects"
  | "people"
  | "invoices"
  | "payments"
  | "expenses"
  | "payroll"
  | "reports"
  | "accounting"
  | "settings";
type TimesheetSubView = "mine" | "team" | "pending" | "analysis";
type ProjectSubView = "cockpit" | "editor" | "setup" | "performance";
type PeopleSubView = "profiles" | "pending";
type DashboardSubView = "overview" | "controls";
type DashboardDetailTab = "summary" | "employees" | "tasks" | "subtasks";
type TimeSubView = "entry";
type AccountingSubView = "workspace";
type SettingsSubView = "workspace" | "bank_connections" | "bank_transactions" | "expense_mix";
type InvoiceWorkspaceTab = "studio" | "saved" | "recurring" | "legacy" | "templates" | "ar";
type PaymentWorkspaceTab = "status" | "ar";
type ExpenseWorkspaceTab = "costs" | "reconciliation";
type ReportsWorkspaceTab = "overview" | "project" | "timesheets" | "financial" | "tax";
type DashboardChartScale = "amount" | "pct_budget";
type DashboardTrendChartType = "bar" | "line";
type DashboardAnalysisScope = "report_period" | "inception";
type DashboardAnalysisDimension = "employee" | "project" | "task" | "subtask";
type DashboardAnalysisMetric = "hours" | "pay" | "revenue" | "cost" | "profit" | "margin_pct";

type MetricRow = {
  hours: number;
  revenue: number;
  cost: number;
  profit: number;
};

type PieSlice = {
  label: string;
  value: number;
  color: string;
};

type DashboardAnalysisRow = {
  key: string;
  label: string;
  projects: number;
  hours: number;
  pay: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_pct: number;
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
type BankConnection = {
  id: number;
  provider: string;
  institution_name: string;
  institution_id: string | null;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  account_count: number;
  transaction_count: number;
};
type BankAccount = {
  id: number;
  connection_id: number;
  account_id: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  is_business: boolean;
  current_balance: number | null;
  available_balance: number | null;
  iso_currency_code: string | null;
};
type BankReconciliationQueueRow = {
  bank_transaction_id: number;
  connection_id: number;
  account_id: string;
  account_name: string | null;
  posted_date: string | null;
  description: string;
  amount: number;
  merchant_name: string | null;
  pending: boolean;
  is_business: boolean;
  expense_group: string | null;
  category: string | null;
  suggested_invoice_id: number | null;
  suggested_invoice_number: string | null;
  suggested_invoice_client: string | null;
  suggested_confidence: number | null;
};
type BankCategoryGroup = {
  group: string;
  categories: string[];
};
type BankSummaryBreakdown = "category" | "merchant" | "expense_group";
type BankExpenseSummaryRow = {
  dimension: BankSummaryBreakdown;
  label: string;
  transaction_count: number;
  amount_abs: number;
};
type BankReconciliationQueueResult = {
  rows: BankReconciliationQueueRow[];
  total: number;
  limit: number;
  offset: number;
};
type BankImportExpenseCatResult = {
  ok: boolean;
  connection_id: number;
  connection_name: string;
  accounts_created: number;
  transactions_created: number;
  transactions_updated: number;
  rows_total: number;
  rows_skipped: number;
};
type BankImportedPlaidReconcileResult = {
  ok: boolean;
  imported_candidates: number;
  plaid_candidates: number;
  matched_duplicates: number;
  remaining_unmatched_imported: number;
};
type BankCategoryRecommendationResult = {
  ok: boolean;
  reviewed: number;
  updated: number;
  skipped_manual: number;
  skipped_already_categorized: number;
  skipped_no_match: number;
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
  line_item_mode?: boolean;
  payment_rows?: number;
  payments_matched_invoices?: number;
  rows: LegacyInvoiceImportRow[];
};
type LegacyPaymentImportResult = {
  apply: boolean;
  count: number;
  updated: number;
  matched: number;
  unmatched: number;
  errors: number;
};
type InvoiceClientReconcileResult = {
  canonical_client_name: string;
  aliases: string[];
  invoices_updated: number;
  projects_updated: number;
};
type ArClientRow = {
  client_name: string;
  invoice_count: number;
  outstanding: number;
  overdue: number;
};
type ArSummary = {
  as_of: string;
  invoice_count_total?: number;
  total_invoiced?: number;
  total_paid_to_date?: number;
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
type UnbilledSinceLastInvoiceClientRow = {
  client_name: string;
  unbilled: number;
  project_count: number;
  work_hours?: number;
};
type UnbilledSinceLastInvoiceProjectRow = {
  client_name: string;
  project_id: number;
  project_name: string;
  work_hours: number;
  unbilled: number;
};
type UnbilledSinceLastInvoice = {
  as_of: string;
  by_client: UnbilledSinceLastInvoiceClientRow[];
  by_client_project?: UnbilledSinceLastInvoiceProjectRow[];
};
type InvoiceRevenueStatus = {
  as_of: string;
  invoice_count_total: number;
  invoice_count_open: number;
  total_invoiced: number;
  total_paid_to_date: number;
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
  earned_not_billed_total: number;
  unbilled_by_client: UnbilledSinceLastInvoiceClientRow[];
  unbilled_by_client_project?: UnbilledSinceLastInvoiceProjectRow[];
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

function parseTimesheetPeriodLabel(label: string): { start: string; end: string } | null {
  const parts = label.split(" to ");
  if (parts.length !== 2) return null;
  const start = parts[0]?.trim();
  const end = parts[1]?.trim();
  if (!start || !end) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  return { start, end };
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
  if (preset === "project_to_date") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    return { start: formatYmdUtc(start), end: todayYmd };
  }
  return { start: todayYmd, end: todayYmd };
}

function annualRangeForYear(year: number): { start: string; end: string } {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
}

function monthlyRangeFor(year: number, month1to12: number): { start: string; end: string } {
  const monthIdx = Math.min(12, Math.max(1, month1to12)) - 1;
  const start = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(Date.UTC(year, monthIdx + 1, 0));
  return { start: formatYmdUtc(start), end: formatYmdUtc(end) };
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

function invoiceOutstandingBalance(inv: Pick<InvoiceRecord, "subtotal_amount" | "amount_paid" | "balance_due">): number {
  const storedBalance = Number(inv.balance_due || 0);
  const subtotal = Number(inv.subtotal_amount || 0);
  const paid = Number(inv.amount_paid || 0);
  const derivedBalance = Math.max(0, subtotal - paid);
  return Math.max(storedBalance, derivedBalance);
}

function effectiveInvoiceStatus(inv: Pick<InvoiceRecord, "status" | "subtotal_amount" | "amount_paid" | "balance_due" | "due_date">, todayYmd: string): string {
  const rawStatus = String(inv.status || "").toLowerCase();
  if (rawStatus === "void") return "void";
  const balance = invoiceOutstandingBalance(inv);
  if (balance <= 0.0001) return "paid";
  const paid = Number(inv.amount_paid || 0);
  if (paid > 0.0001) return "partial";
  if (isValidYmd(inv.due_date) && inv.due_date < todayYmd) return "overdue";
  if (rawStatus === "draft") return "draft";
  return "sent";
}

function isFinancialInvoice(inv: Pick<InvoiceRecord, "status" | "subtotal_amount" | "amount_paid" | "balance_due" | "due_date">, todayYmd: string): boolean {
  const status = effectiveInvoiceStatus(inv, todayYmd);
  return status !== "void" && status !== "draft";
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

function normalizeDashboardClientLabel(name: string): string {
  const clean = (name || "").trim();
  const lower = clean.toLowerCase();
  if (!clean) return "Unassigned Client";
  if (lower === "imported client" || lower === "legacy client" || lower === "historical legacy client" || lower === "unmapped imported work") {
    return "Unassigned Client";
  }
  if (lower === "hdr") return "HDR";
  if (lower === "woodard and curran") return "Woodard & Curran";
  if (lower === "nycdep-bepa") return "NYCDEP-BEPA";
  if (lower === "stantecjv") return "Stantec + Brown & Caldwell";
  return clean;
}

function formatWbsSubtaskLabel(subtask: WbsSubtask): string {
  if ((subtask.code || "").trim().toUpperCase() === NO_SUBTASK_CODE) return "No Sub-Task";
  return `${subtask.code} - ${subtask.name}`;
}

function formatSubtaskLabelFromEntry(entry: TimeEntry): string {
  if ((entry.subtask_code || "").trim().toUpperCase() === NO_SUBTASK_CODE) return "No Sub-Task";
  if (entry.subtask_code) return `${entry.subtask_code}${entry.subtask_name ? ` - ${entry.subtask_name}` : ""}`;
  if (entry.subtask_name) return entry.subtask_name;
  return `Subtask ${entry.subtask_id}`;
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

function miniPiePath(cx: number, cy: number, r: number, start: number, end: number): string {
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

function MiniLabeledPie({
  slices,
  size = 112,
  valueMode = "hours",
  showLegend = true,
  showSliceLabels = false,
}: {
  slices: PieSlice[];
  size?: number;
  valueMode?: "hours" | "currency";
  showLegend?: boolean;
  showSliceLabels?: boolean;
}) {
  const filtered = slices.filter((s) => Number(s.value) > 0);
  const total = filtered.reduce((sum, s) => sum + Number(s.value), 0);
  if (total <= 0) return <div style={{ fontSize: 12, color: "#5b6773" }}>No chart data</div>;
  const r = size / 2 - 4;
  let start = -Math.PI / 2;
  const labelPad = showSliceLabels ? 120 : 0;
  const canvas = size + labelPad * 2;
  const center = canvas / 2;
  const pieSvg = (
    <svg width={canvas} height={canvas} viewBox={`0 0 ${canvas} ${canvas}`} role="img" aria-label="Distribution pie chart" style={{ overflow: "visible" }}>
      {filtered.map((s, idx) => {
        const angle = (Number(s.value) / total) * Math.PI * 2;
        const end = start + angle;
        const path = angle >= Math.PI * 2 - 1e-8 ? `M ${center} ${center} m -${r},0 a ${r},${r} 0 1,0 ${2 * r},0 a ${r},${r} 0 1,0 -${2 * r},0` : miniPiePath(center, center, r, start, end);
        const mid = start + angle / 2;
        const pct = total > 0 ? (Number(s.value) / total) * 100 : 0;
        const leaderStartX = center + Math.cos(mid) * (r + 1);
        const leaderStartY = center + Math.sin(mid) * (r + 1);
        const leaderMidX = center + Math.cos(mid) * (r + 16);
        const leaderMidY = center + Math.sin(mid) * (r + 16);
        const leaderEndX = leaderMidX + (Math.cos(mid) >= 0 ? 18 : -18);
        const leaderEndY = leaderMidY;
        const labelAnchor = Math.cos(mid) >= 0 ? "start" : "end";
        const labelText = `${s.label.length > 16 ? `${s.label.slice(0, 16)}...` : s.label} ${pct.toFixed(0)}%`;
        start = end;
        return (
          <g key={`mini-pie-slice-${idx}`}>
            <path d={path} fill={s.color} stroke="#fff" strokeWidth={1.2} />
            {showSliceLabels && pct >= 3 && (
              <>
                <polyline
                  points={`${leaderStartX},${leaderStartY} ${leaderMidX},${leaderMidY} ${leaderEndX},${leaderEndY}`}
                  fill="none"
                  stroke="#5c7288"
                  strokeWidth={1}
                />
                <text
                  x={leaderEndX + (labelAnchor === "start" ? 3 : -3)}
                  y={leaderEndY}
                  textAnchor={labelAnchor}
                  dominantBaseline="middle"
                  style={{ fontSize: 12, fontWeight: 700, fill: "#243b53", letterSpacing: 0.1 }}
                  stroke="#ffffff"
                  strokeWidth={0.8}
                  paintOrder="stroke"
                >
                  {labelText}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );

  if (!showLegend) {
    return <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>{pieSvg}</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: `${size}px 1fr`, gap: 10, alignItems: "center" }}>
      {pieSvg}
      <div style={{ fontSize: 12 }}>
        {filtered.map((s, idx) => {
          const pct = total > 0 ? (Number(s.value) / total) * 100 : 0;
          const valueText = valueMode === "currency" ? formatCurrency(Number(s.value)) : `${Number(s.value).toFixed(1)}h`;
          return (
            <div key={`mini-pie-legend-${idx}`} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 999, background: s.color, display: "inline-block" }} />
              <span style={{ color: "#1f2f3f" }}>
                {s.label}: {pct.toFixed(1)}% ({valueText})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type InvoiceTemplateId = "default" | "stantec_bc" | "hdr";

type InvoiceTemplateMeta = {
  id: InvoiceTemplateId;
  label: string;
  billToLines: string[];
  periodLabel: string;
  references: Array<{ label: string; value: string }>;
};

type AquatechTemplateConfig = {
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

function invoiceTemplateMeta(inv: InvoiceRecord, id: InvoiceTemplateId = "default", aquatechTemplate?: AquatechTemplateConfig): InvoiceTemplateMeta {
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
    label: aquatechTemplate?.label || "Aquatech Generic",
    billToLines: aquatechTemplate?.billToLines?.length ? aquatechTemplate.billToLines : [inv.client_name || "AquatechPM Client"],
    periodLabel: aquatechTemplate?.periodLabel || "Period",
    references: aquatechTemplate?.references || [],
  };
}

function timesheetStatusStyle(status: string): { background: string; color: string; border: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "approved") return { background: "#e8f0fa", color: "#1f3f60", border: "1px solid #c8d7ea" };
  if (normalized === "submitted") return { background: "#fff5e8", color: "#9a5a00", border: "1px solid #f1d2a7" };
  if (normalized === "rejected") return { background: "#fff1eb", color: "#8a3a2a", border: "1px solid #f2c7b8" };
  return { background: "#eef2f7", color: "#2f4860", border: "1px solid #d1dae6" };
}

function invoiceStatusStyle(status: string): { background: string; color: string; border: string } {
  const normalized = (status || "").toLowerCase();
  if (normalized === "paid") return { background: "#e8f0fa", color: "#1f3f60", border: "1px solid #c8d7ea" };
  if (normalized === "partial") return { background: "#fff5e8", color: "#9a5a00", border: "1px solid #f1d2a7" };
  if (normalized === "overdue") return { background: "#fff1eb", color: "#8a3a2a", border: "1px solid #f2c7b8" };
  if (normalized === "sent") return { background: "#ecf1f8", color: "#2f4860", border: "1px solid #d3dced" };
  if (normalized === "void") return { background: "#f1f3f5", color: "#555", border: "1px solid #cfd8e3" };
  if (normalized === "draft") return { background: "#f8f3ec", color: "#8a5a00", border: "1px solid #e4d9a4" };
  return { background: "#eef2f7", color: "#2f4860", border: "1px solid #d1dae6" };
}

function titleCaseWord(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function Home() {
  useAutoSortableTables();
  const [me, setMe] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [adminTimesheets, setAdminTimesheets] = useState<AdminTimesheet[]>([]);
  const [projectPerformance, setProjectPerformance] = useState<ProjectPerformance[]>([]);
  const [contractProjectPerformance, setContractProjectPerformance] = useState<ProjectPerformance[]>([]);
  const [message, setMessage] = useState<string>("");
  const [isMessagePopupOpen, setIsMessagePopupOpen] = useState(false);
  const [isRefreshingWorkspace, setIsRefreshingWorkspace] = useState(false);
  const [isRunningMonthEndCheck, setIsRunningMonthEndCheck] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string>("");

  const [bootstrapEmail, setBootstrapEmail] = useState("admin@aquatechpc.com");
  const [bootstrapName, setBootstrapName] = useState("Aquatech Admin");
  const [loginEmail, setLoginEmail] = useState("admin@aquatechpc.com");

  const [projectName, setProjectName] = useState("Demo Project");
  const [projectClient, setProjectClient] = useState("AquatechPM Client");
  const [projectStartDate, setProjectStartDate] = useState("");
  const [projectEndDate, setProjectEndDate] = useState("");
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
  const [isSavingTimeEntry, setIsSavingTimeEntry] = useState(false);
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
  const [selectedPendingTimesheetId, setSelectedPendingTimesheetId] = useState<number | null>(null);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const todayYmd = new Date().toISOString().slice(0, 10);
  const [reapplyRateStart, setReapplyRateStart] = useState(`${todayYmd.slice(0, 4)}-01-01`);
  const [reapplyRateEnd, setReapplyRateEnd] = useState(`${todayYmd.slice(0, 4)}-12-31`);
  const [reportPreset, setReportPreset] = useState<ReportPreset>("custom");
  const [reportYear, setReportYear] = useState(new Date().getUTCFullYear());
  const [reportMonth, setReportMonth] = useState(new Date().getUTCMonth() + 1);
  const [reportWeekStart, setReportWeekStart] = useState(presetRange("weekly", new Date().toISOString().slice(0, 10)).start);
  const [reportPtdProjectId, setReportPtdProjectId] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>("dashboard");
  const [lockToMyTimesheet, setLockToMyTimesheet] = useState(false);
  const [timesheetOnlyGeneratedCurrentWeek, setTimesheetOnlyGeneratedCurrentWeek] = useState(false);
  const [dashboardSubView, setDashboardSubView] = useState<DashboardSubView>("overview");
  const [timeSubView, setTimeSubView] = useState<TimeSubView>("entry");
  const [timesheetSubView, setTimesheetSubView] = useState<TimesheetSubView>("mine");
  const [timesheetAnalysisDimension, setTimesheetAnalysisDimension] = useState<"employee" | "project" | "task">("employee");
  const [projectSubView, setProjectSubView] = useState<ProjectSubView>("cockpit");
  const [peopleSubView, setPeopleSubView] = useState<PeopleSubView>("profiles");
  const [accountingSubView, setAccountingSubView] = useState<AccountingSubView>("workspace");
  const [settingsSubView, setSettingsSubView] = useState<SettingsSubView>("workspace");
  const [invoiceWorkspaceTab, setInvoiceWorkspaceTab] = useState<InvoiceWorkspaceTab>("studio");
  const [paymentWorkspaceTab, setPaymentWorkspaceTab] = useState<PaymentWorkspaceTab>("status");
  const [expenseWorkspaceTab, setExpenseWorkspaceTab] = useState<ExpenseWorkspaceTab>("costs");
  const [reportsWorkspaceTab, setReportsWorkspaceTab] = useState<ReportsWorkspaceTab>("overview");
  const [dashboardChartScale, setDashboardChartScale] = useState<DashboardChartScale>("amount");
  const [dashboardTrendChartType, setDashboardTrendChartType] = useState<DashboardTrendChartType>("bar");
  const [projectEditorProjectId, setProjectEditorProjectId] = useState<number | null>(null);
  const [peopleEditorUserId, setPeopleEditorUserId] = useState<number | null>(null);
  const [performanceProjectId, setPerformanceProjectId] = useState<number | null>(null);
  const [dashboardDetailTab, setDashboardDetailTab] = useState<DashboardDetailTab>("summary");
  const [performanceExpanded, setPerformanceExpanded] = useState<Record<string, boolean>>({});
  const [performancePieMetric, setPerformancePieMetric] = useState<Record<string, "hours" | "revenue" | "profit">>({});
  const [reportStart, setReportStart] = useState("2000-01-01");
  const [reportEnd, setReportEnd] = useState(todayYmd);
  const [reportRangeInitialized, setReportRangeInitialized] = useState(true);
  const [reconciliationSnapshot, setReconciliationSnapshot] = useState<ReconciliationSnapshot | null>(null);
  const [reconciliationMonthly, setReconciliationMonthly] = useState<ReconciliationMonthlyRow[]>([]);
  const [overallReconciliationMonthly, setOverallReconciliationMonthly] = useState<ReconciliationMonthlyRow[]>([]);
  const [dashboardTrendWindowMonths, setDashboardTrendWindowMonths] = useState<6 | 12>(6);
  const [dashboardAnalysisScope, setDashboardAnalysisScope] = useState<DashboardAnalysisScope>("report_period");
  const [dashboardAnalysisDimension, setDashboardAnalysisDimension] = useState<DashboardAnalysisDimension>("employee");
  const [dashboardAnalysisMetric, setDashboardAnalysisMetric] = useState<DashboardAnalysisMetric>("pay");
  const [dashboardAnalysisProjectId, setDashboardAnalysisProjectId] = useState<number | null>(null);
  const refreshDataInFlightRef = useRef(false);
  const refreshDataQueuedRef = useRef(false);
  const refreshDataRequestIdRef = useRef(0);
  const ensuredTimesheetKeysRef = useRef<Set<string>>(new Set());
  const timesheetOnlyMobileModeSetRef = useRef(false);
  const [dashboardAnalysisLimit, setDashboardAnalysisLimit] = useState<10 | 20 | 50>(10);
  const [invoiceStart, setInvoiceStart] = useState(`${todayYmd.slice(0, 4)}-01-01`);
  const [invoiceEnd, setInvoiceEnd] = useState(todayYmd);
  const [invoicePeriodPreset, setInvoicePeriodPreset] = useState<InvoicePeriodPreset>("custom");
  const [invoiceProjectId, setInvoiceProjectId] = useState<number | null>(null);
  const [invoiceApprovedOnly, setInvoiceApprovedOnly] = useState(true);
  const [invoicePreview, setInvoicePreview] = useState<InvoicePreview | null>(null);
  const [savedInvoices, setSavedInvoices] = useState<InvoiceRecord[]>([]);
  const [unbilledSinceLastInvoice, setUnbilledSinceLastInvoice] = useState<UnbilledSinceLastInvoice>({ as_of: todayYmd, by_client: [] });
  const [invoiceRevenueStatus, setInvoiceRevenueStatus] = useState<InvoiceRevenueStatus | null>(null);
  const [invoiceDetail, setInvoiceDetail] = useState<InvoiceRecord | null>(null);
  const [invoiceRenderContext, setInvoiceRenderContext] = useState<InvoiceRenderContext | null>(null);
  const [invoiceSelectedId, setInvoiceSelectedId] = useState<number | null>(null);
  const [invoiceViewerOpen, setInvoiceViewerOpen] = useState(false);
  const [invoiceTemplateById, setInvoiceTemplateById] = useState<Record<number, InvoiceTemplateId>>({});
  const [invoiceDraftTemplateId, setInvoiceDraftTemplateId] = useState<InvoiceTemplateId>("default");
  const [aquatechTemplateLabel, setAquatechTemplateLabel] = useState("Aquatech Generic");
  const [aquatechTemplateBillToText, setAquatechTemplateBillToText] = useState("AquatechPM Client");
  const [aquatechTemplatePeriodLabel, setAquatechTemplatePeriodLabel] = useState("Professional Services for the Period");
  const [aquatechTemplateReferencesText, setAquatechTemplateReferencesText] = useState("Project: \nPO Number: ");
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
  const [paymentImportFile, setPaymentImportFile] = useState<File | null>(null);
  const [paymentImportApply, setPaymentImportApply] = useState(false);
  const [paymentImportSummary, setPaymentImportSummary] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>("all");
  const [paymentClientFilter, setPaymentClientFilter] = useState<string>("all");
  const [paymentPeriodFilter, setPaymentPeriodFilter] = useState<"all" | "last30" | "this_month" | "this_quarter" | "this_year">("all");
  const [invoiceClientReconcileName, setInvoiceClientReconcileName] = useState("");
  const [paymentImportMappingJson, setPaymentImportMappingJson] = useState(
    '{\n  "payment_invoice_number": ["Number", "Invoice #", "Invoice Number"],\n  "payment_date": ["Date", "Payment Date"],\n  "payment_amount": ["Amount", "Payment Amount"]\n}',
  );
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditEntityFilter, setAuditEntityFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
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
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [bankQueue, setBankQueue] = useState<BankReconciliationQueueRow[]>([]);
  const [bankQueueTotal, setBankQueueTotal] = useState(0);
  const [bankQueueOffset, setBankQueueOffset] = useState(0);
  const [bankQueueLimit, setBankQueueLimit] = useState<40 | 100 | 250>(40);
  const [bankQueueIncludePersonal, setBankQueueIncludePersonal] = useState(false);
  const [bankQueueSearch, setBankQueueSearch] = useState("");
  const [bankQueueSort, setBankQueueSort] = useState<"date_desc" | "date_asc" | "amount_desc" | "amount_asc" | "confidence_desc">("date_desc");
  const [bankQueueConnectionFilter, setBankQueueConnectionFilter] = useState<number | null>(null);
  const [bankQueueGroupFilter, setBankQueueGroupFilter] = useState<string>("all");
  const [bankCategoryGroups, setBankCategoryGroups] = useState<BankCategoryGroup[]>([]);
  const [bankSummaryRows, setBankSummaryRows] = useState<BankExpenseSummaryRow[]>([]);
  const [bankSummaryBreakdown, setBankSummaryBreakdown] = useState<BankSummaryBreakdown>("category");
  const [bankCategoryDrafts, setBankCategoryDrafts] = useState<Record<number, { expense_group: string; category: string; learn_for_merchant: boolean }>>({});
  const [bankExpenseProjectId, setBankExpenseProjectId] = useState<number | null>(null);
  const [isPlaidConnecting, setIsPlaidConnecting] = useState(false);
  const [showEmergencyCsvImport, setShowEmergencyCsvImport] = useState(false);
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
        end_date: string;
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

  const capabilities = useMemo(() => deriveUserCapabilities(me), [me]);
  const {
    canManageUsers,
    canManageProjects,
    canManageRates,
    canApproveTimesheets,
    canViewFinancials,
    canViewOperations,
  } = capabilities;
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
  const selectedDayTotalHours = useMemo(
    () => selectedDayEntries.reduce((sum, e) => sum + Number(e.hours || 0), 0),
    [selectedDayEntries],
  );
  const isOwnTimeEntryContext = useMemo(() => {
    if (!me) return true;
    if (lockToMyTimesheet && canApproveTimesheets && timesheetUserFilter && timesheetUserFilter !== me.id) return false;
    if (!lockToMyTimesheet && timeFilterUserId && timeFilterUserId !== me.id) return false;
    return true;
  }, [me, lockToMyTimesheet, canApproveTimesheets, timesheetUserFilter, timeFilterUserId]);
  const monthTotalHours = useMemo(
    () =>
      visibleDates.reduce((sum, day) => {
        return sum + Number(dailyHours[day] || 0);
      }, 0),
    [visibleDates, dailyHours],
  );
  const monthWeekTotals = useMemo(
    () =>
      monthWeeks.map((week) =>
        week.reduce((sum, day) => (day ? sum + Number(dailyHours[day] || 0) : sum), 0),
      ),
    [monthWeeks, dailyHours],
  );
  const monthWeekdayTotals = useMemo(() => {
    const totals = [0, 0, 0, 0, 0, 0, 0];
    for (const week of monthWeeks) {
      for (let i = 0; i < 7; i += 1) {
        const day = week[i];
        if (!day) continue;
        totals[i] += Number(dailyHours[day] || 0);
      }
    }
    return totals;
  }, [monthWeeks, dailyHours]);
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
          subtaskLabel: formatSubtaskLabelFromEntry(entry),
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
    () => projectPerformance.filter((p) => !isPlaceholderProjectName(p.project_name) && !isHiddenProjectName(p.project_name)),
    [projectPerformance],
  );
  const dashboardKpiContextLabel = useMemo(() => {
    if (reportPreset === "weekly") return `Weekly period (${reportStart} to ${reportEnd})`;
    if (reportPreset === "monthly") return `Monthly period (${reportStart} to ${reportEnd})`;
    if (reportPreset === "annual") return `Annual period (${reportStart} to ${reportEnd})`;
    if (reportPreset === "project_to_date") return `Project-to-date period (${reportStart} to ${reportEnd})`;
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
  const reportYearOptions = useMemo(() => {
    const years = new Set<number>();
    const currentYear = new Date().getUTCFullYear();
    years.add(currentYear);
    years.add(currentYear - 1);
    years.add(currentYear - 2);
    if (isValidYmd(reportStart)) years.add(parseYmdUtc(reportStart).getUTCFullYear());
    if (isValidYmd(reportEnd)) years.add(parseYmdUtc(reportEnd).getUTCFullYear());
    for (const p of projects) {
      if (p.start_date && isValidYmd(p.start_date)) years.add(parseYmdUtc(p.start_date).getUTCFullYear());
      if (p.end_date && isValidYmd(p.end_date)) years.add(parseYmdUtc(p.end_date).getUTCFullYear());
    }
    for (const inv of savedInvoices) {
      if (inv.start_date && isValidYmd(inv.start_date)) years.add(parseYmdUtc(inv.start_date).getUTCFullYear());
      if (inv.end_date && isValidYmd(inv.end_date)) years.add(parseYmdUtc(inv.end_date).getUTCFullYear());
      if (inv.issue_date && isValidYmd(inv.issue_date)) years.add(parseYmdUtc(inv.issue_date).getUTCFullYear());
    }
    for (const row of reconciliationMonthly) {
      if (/^\d{4}-\d{2}$/.test(row.period)) years.add(Number(row.period.slice(0, 4)));
    }
    const arr = Array.from(years).sort((a, b) => b - a);
    if (arr.length === 0) arr.push(currentYear);
    return arr;
  }, [projects, reconciliationMonthly, reportEnd, reportStart, savedInvoices]);
  const reportWeekOptions = useMemo(() => {
    const today = parseYmdUtc(todayYmd);
    const weekday = today.getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const thisMonday = addDaysUtc(today, -mondayOffset);
    const out: { start: string; end: string; label: string }[] = [];
    for (let i = 0; i < 104; i++) {
      const start = addDaysUtc(thisMonday, -7 * i);
      const end = addDaysUtc(start, 6);
      const startYmd = formatYmdUtc(start);
      const endYmd = formatYmdUtc(end);
      out.push({
        start: startYmd,
        end: endYmd,
        label: `${startYmd} to ${endYmd}`,
      });
    }
    return out;
  }, [todayYmd]);
  const reportPtdProjectOptions = useMemo(
    () => projects.filter((p) => !isHiddenProjectName(p.name) && !!p.start_date),
    [projects],
  );
  const paidByProjectId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const inv of savedInvoices) {
      if (!isFinancialInvoice(inv, todayYmd)) continue;
      if (!inv.project_id) continue;
      map[inv.project_id] = (map[inv.project_id] || 0) + Number(inv.amount_paid || 0);
    }
    return map;
  }, [savedInvoices, todayYmd]);
  const billedByProjectId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const inv of savedInvoices) {
      if (!isFinancialInvoice(inv, todayYmd)) continue;
      if (!inv.project_id) continue;
      const status = effectiveInvoiceStatus(inv, todayYmd);
      if (status === "draft" || status === "void") continue;
      map[inv.project_id] = (map[inv.project_id] || 0) + Number(inv.subtotal_amount || 0);
    }
    return map;
  }, [savedInvoices, todayYmd]);
  const contractCostByProjectId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const p of contractProjectPerformance) {
      map[p.project_id] = Number(p.actual_cost || 0);
    }
    return map;
  }, [contractProjectPerformance]);
  const contractRevenueByProjectId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const p of contractProjectPerformance) {
      map[p.project_id] = Number(p.actual_revenue || 0);
    }
    return map;
  }, [contractProjectPerformance]);
  const projectById = useMemo(() => {
    const map: Record<number, Project> = {};
    for (const p of projects) map[p.id] = p;
    return map;
  }, [projects]);
  const dashboardProjectKpis = useMemo(() => {
    const rows = dashboardProjectPerformance.map((p) => {
      const project = projectById[p.project_id];
      const totalBudget = toNumber(p.overall_budget_fee || p.budget_fee || 0);
      const spentToDate = toNumber(p.actual_cost || 0);
      const contractSpentToDate = toNumber(contractCostByProjectId[p.project_id] ?? spentToDate);
      const revenueSelectedPeriod = toNumber(p.actual_revenue || 0);
      const revenueLifeToDate = toNumber(contractRevenueByProjectId[p.project_id] ?? revenueSelectedPeriod);
      const contractBudgetRemaining = totalBudget - contractSpentToDate;
      const unearnedBudgetRemaining = totalBudget - revenueLifeToDate;
      const billedToDate = toNumber(billedByProjectId[p.project_id] || 0);
      const earnedButUnbilled = Math.max(revenueLifeToDate - billedToDate, 0);
      const paidToDate = toNumber(paidByProjectId[p.project_id] || 0);
      const timeBudget = toNumber(p.budget_hours || 0);
      const timeSpent = toNumber(p.actual_hours || 0);
      const { budgetRemaining, pctSpent, pctRemaining, timeRemaining, pctTimeSpent, pctTimeRemaining } = computeBudgetKpis(
        totalBudget,
        spentToDate,
        timeBudget,
        timeSpent,
      );
      const spentToDateHours = timeSpent;
      const pctHoursSpent = pctTimeSpent;
      const pctHoursRemaining = pctTimeRemaining;
      let scheduleElapsedPct = 0;
      let scheduleRemainingPct = 0;
      let plannedHoursToDate = 0;
      if (project?.start_date && project?.end_date && project.end_date >= project.start_date) {
        const s = parseYmdUtc(project.start_date);
        const e = parseYmdUtc(project.end_date);
        const now = parseYmdUtc(todayYmd);
        const totalDays = Math.max(1, Math.floor((e.getTime() - s.getTime()) / 86400000) + 1);
        const elapsedDaysRaw = Math.floor((Math.min(now.getTime(), e.getTime()) - s.getTime()) / 86400000) + 1;
        const elapsedDays = Math.max(0, Math.min(totalDays, elapsedDaysRaw));
        scheduleElapsedPct = (elapsedDays / totalDays) * 100;
        scheduleRemainingPct = 100 - scheduleElapsedPct;
        plannedHoursToDate = timeBudget * (scheduleElapsedPct / 100);
      }
      const scheduleSpi = plannedHoursToDate > 0 ? timeSpent / plannedHoursToDate : null;
      const forecast =
        pctSpent > 100 || pctTimeSpent > 100
          ? "Overshoot risk"
          : pctSpent > pctTimeSpent + 15
            ? "Budget burn high"
            : pctTimeSpent > pctSpent + 20
              ? "Schedule lag / under-burn"
              : "On track";
      const scheduleForecast =
        scheduleElapsedPct <= 0 || timeBudget <= 0
          ? "Insufficient schedule baseline"
          : pctTimeSpent + 10 < scheduleElapsedPct
            ? "Behind schedule risk"
            : pctTimeSpent > scheduleElapsedPct + 15
              ? "Ahead of schedule"
              : "On schedule";
      return {
        ...p,
        project_start_date: project?.start_date || null,
        project_end_date: project?.end_date || null,
        totalBudget,
        spentToDate,
        contractSpentToDate,
        revenueSelectedPeriod,
        revenueLifeToDate,
        unearnedBudgetRemaining,
        billedToDate,
        earnedButUnbilled,
        contractBudgetRemaining,
        paidToDate,
        budgetRemaining,
        pctSpent,
        pctRemaining,
        timeBudget,
        timeSpent,
        timeRemaining,
        pctTimeSpent,
        pctTimeRemaining,
        spentToDateHours,
        pctHoursSpent,
        pctHoursRemaining,
        scheduleElapsedPct,
        scheduleRemainingPct,
        plannedHoursToDate,
        scheduleSpi,
        scheduleForecast,
        forecast,
      };
    });
    const baselineRows = rows.filter((p) => p.timeBudget > 0 && p.plannedHoursToDate > 0);
    const portfolioScheduleSpi =
      baselineRows.length > 0
        ? baselineRows.reduce((sum, p) => sum + p.timeSpent, 0) / baselineRows.reduce((sum, p) => sum + p.plannedHoursToDate, 0)
        : null;
    return rows.map((r) => {
      if (r.timeBudget > 0) return r;
      if (r.scheduleElapsedPct <= 0 || portfolioScheduleSpi === null) return r;
      const estimatedScheduleForecast =
        portfolioScheduleSpi < 0.9
          ? "Behind schedule risk (estimated)"
          : portfolioScheduleSpi > 1.15
            ? "Ahead of schedule (estimated)"
            : "On schedule (estimated)";
      return {
        ...r,
        scheduleForecast: estimatedScheduleForecast,
      };
    });
  }, [billedByProjectId, contractCostByProjectId, contractRevenueByProjectId, dashboardProjectPerformance, paidByProjectId, projectById, todayYmd]);
  const dashboardOverallKpis = useMemo(() => {
    return dashboardProjectKpis.reduce(
      (acc, p) => {
        acc.totalBudget += p.totalBudget;
        acc.spentToDate += p.spentToDate;
        acc.paidToDate += p.paidToDate;
        acc.timeBudget += p.timeBudget;
        acc.timeSpent += p.timeSpent;
        return acc;
      },
      { totalBudget: 0, spentToDate: 0, paidToDate: 0, timeBudget: 0, timeSpent: 0 },
    );
  }, [dashboardProjectKpis]);
  const dashboardOverallDerived = useMemo(() => {
    return computeBudgetKpis(
      dashboardOverallKpis.totalBudget,
      dashboardOverallKpis.spentToDate,
      dashboardOverallKpis.timeBudget,
      dashboardOverallKpis.timeSpent,
    );
  }, [dashboardOverallKpis]);
  const dashboardContractTotals = useMemo(() => {
    return dashboardProjectKpis.reduce(
      (acc, p) => {
        acc.spent += Number(p.contractSpentToDate || 0);
        acc.remaining += Number(p.contractBudgetRemaining || 0);
        acc.revenue += Number(p.actual_revenue || 0);
        return acc;
      },
      { spent: 0, remaining: 0, revenue: 0 },
    );
  }, [dashboardProjectKpis]);
  const dashboardPipeline = useMemo(() => {
    const validStarts = projects
      .filter((p) => !isHiddenProjectName(p.name) && p.start_date && isValidYmd(p.start_date))
      .map((p) => p.start_date as string)
      .sort();
    const inceptionStart = validStarts[0] || todayYmd;
    const daysInRange = Math.max(1, daysBetweenInclusive(inceptionStart, todayYmd));
    const monthsInRange = daysInRange / 30.4375;
    const burnedCost = dashboardContractTotals.spent;
    const burnedRevenue = dashboardContractTotals.revenue;
    const remainingBudget = dashboardContractTotals.remaining;
    const burnRateCostPerMonth = monthsInRange > 0 ? burnedCost / monthsInRange : 0;
    const burnRateRevenuePerMonth = monthsInRange > 0 ? burnedRevenue / monthsInRange : 0;
    const nonCogsPerMonthPlaceholder = 0;
    const monthsRemaining = burnRateCostPerMonth > 0 ? remainingBudget / burnRateCostPerMonth : null;
    const pipelineStatus =
      monthsRemaining === null
        ? "No burn yet in selected range"
        : monthsRemaining < 3
          ? "Short runway"
          : monthsRemaining < 6
            ? "Monitor pipeline"
            : "Healthy runway";
    return {
      inceptionStart,
      daysInRange,
      monthsInRange,
      burnedCost,
      burnedRevenue,
      remainingBudget,
      burnRateCostPerMonth,
      burnRateRevenuePerMonth,
      nonCogsPerMonthPlaceholder,
      monthsRemaining,
      pipelineStatus,
    };
  }, [dashboardContractTotals, projects, todayYmd]);
  const dashboardOverallSchedule = useMemo(() => {
    const baselineRows = dashboardProjectKpis.filter((p) => p.timeBudget > 0 && p.plannedHoursToDate > 0);
    const totalPlannedHoursToDate = baselineRows.reduce((sum, p) => sum + p.plannedHoursToDate, 0);
    const totalTimeSpentToDate = baselineRows.reduce((sum, p) => sum + p.timeSpent, 0);
    const scheduleElapsedPctWeighted =
      baselineRows.length > 0
        ? baselineRows.reduce((sum, p) => sum + p.timeBudget * (p.scheduleElapsedPct / 100), 0) /
          baselineRows.reduce((sum, p) => sum + p.timeBudget, 0) *
          100
        : 0;
    const scheduleSpi = totalPlannedHoursToDate > 0 ? totalTimeSpentToDate / totalPlannedHoursToDate : null;
    return { totalPlannedHoursToDate, totalTimeSpentToDate, scheduleElapsedPctWeighted, scheduleSpi };
  }, [dashboardProjectKpis]);
  const dashboardOverviewRows = useMemo(() => {
    return [...dashboardProjectKpis]
      .sort((a, b) => {
        const aGap = Number(a.target_gross_margin_pct || 0) - Number(a.margin_pct || 0);
        const bGap = Number(b.target_gross_margin_pct || 0) - Number(b.margin_pct || 0);
        return bGap - aGap;
      })
      .slice(0, 6);
  }, [dashboardProjectKpis]);
  const companyContractRows = useMemo(
    () => contractProjectPerformance.filter((p) => !isPlaceholderProjectName(p.project_name) && !isHiddenProjectName(p.project_name)),
    [contractProjectPerformance],
  );
  const companyOverallSummary = useMemo(() => {
    const visibleProjects = projects.filter((p) => !isHiddenProjectName(p.name));
    const totalContractedBudget = visibleProjects.reduce((sum, p) => sum + Number(p.overall_budget_fee || 0), 0);
    const totalSpentToDate = companyContractRows.reduce((sum, p) => sum + Number(p.actual_cost || 0), 0);
    const totalRevenue = companyContractRows.reduce((sum, p) => sum + Number(p.actual_revenue || 0), 0);
    const totalCost = companyContractRows.reduce((sum, p) => sum + Number(p.actual_cost || 0), 0);
    const amountRemaining = totalContractedBudget - totalSpentToDate;
    const overallGrossMargin = marginPct(totalRevenue, totalRevenue - totalCost);
    const completedProjects = visibleProjects.filter((p) => !p.is_active);
    const completedProjectsQty = completedProjects.length;
    const completedProjectsBudget = completedProjects.reduce((sum, p) => sum + Number(p.overall_budget_fee || 0), 0);
    return {
      totalContractedBudget,
      totalSpentToDate,
      amountRemaining,
      overallGrossMargin,
      totalRevenue,
      totalCost,
      completedProjectsQty,
      completedProjectsBudget,
    };
  }, [companyContractRows, projects]);
  const dashboardOverallForecast = useMemo(() => {
    if (dashboardOverallDerived.pctSpent > 100 || dashboardOverallDerived.pctTimeSpent > 100) return "Overshoot risk";
    if (dashboardOverallDerived.pctSpent > dashboardOverallDerived.pctTimeSpent + 15) return "Budget burn high";
    if (dashboardOverallDerived.pctTimeSpent > dashboardOverallDerived.pctSpent + 20) return "Schedule lag / under-burn";
    return "On track";
  }, [dashboardOverallDerived.pctSpent, dashboardOverallDerived.pctTimeSpent]);
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
  const clientRows = useMemo(() => {
    const grouped: Record<string, { client: string; projects: number; active: number; totalBudget: number }> = {};
    for (const p of projects) {
      const client = (p.client_name || "Unassigned Client").trim() || "Unassigned Client";
      if (!grouped[client]) grouped[client] = { client, projects: 0, active: 0, totalBudget: 0 };
      grouped[client].projects += 1;
      if (p.is_active) grouped[client].active += 1;
      grouped[client].totalBudget += Number(p.overall_budget_fee || 0);
    }
    return Object.values(grouped).sort((a, b) => a.client.localeCompare(b.client));
  }, [projects]);
  const invoiceFinanceByProjectId = useMemo(() => {
    const map: Record<
      number,
      { invoiced: number; paid: number; balance: number; openCount: number; overdueCount: number; overdueAmount: number }
    > = {};
    for (const inv of savedInvoices) {
      if (!isFinancialInvoice(inv, todayYmd)) continue;
      if (!inv.project_id) continue;
      const row =
        map[inv.project_id] ||
        (map[inv.project_id] = { invoiced: 0, paid: 0, balance: 0, openCount: 0, overdueCount: 0, overdueAmount: 0 });
      const subtotal = Number(inv.subtotal_amount || 0);
      const paid = Number(inv.amount_paid || 0);
      const balance = Number(inv.balance_due || Math.max(0, subtotal - paid));
      row.invoiced += subtotal;
      row.paid += paid;
      row.balance += balance;
      if (balance > 0.009) {
        row.openCount += 1;
        if (isValidYmd(inv.due_date) && inv.due_date < todayYmd) {
          row.overdueCount += 1;
          row.overdueAmount += balance;
        }
      }
    }
    return map;
  }, [savedInvoices, todayYmd]);
  const projectFinanceBridgeRows = useMemo(() => {
    return projectCockpitRows
      .map((p) => {
        const perf = performanceByProjectId[p.id] || null;
        const invoice = invoiceFinanceByProjectId[p.id] || null;
        const recognizedRevenue = Number(perf?.actual_revenue || 0);
        const invoiceSubtotal = Number(invoice?.invoiced || 0);
        const uninvoicedRevenue = Math.max(0, recognizedRevenue - invoiceSubtotal);
        const paid = Number(invoice?.paid || 0);
        const balance = Number(invoice?.balance || 0);
        const actualCost = Number(perf?.actual_cost || 0);
        const cashFlowGap = Math.max(0, actualCost - paid);
        return {
          ...p,
          recognizedRevenue,
          invoiceSubtotal,
          uninvoicedRevenue,
          paid,
          balance,
          openInvoices: Number(invoice?.openCount || 0),
          overdueInvoices: Number(invoice?.overdueCount || 0),
          overdueAmount: Number(invoice?.overdueAmount || 0),
          cashFlowGap,
        };
      })
      .sort((a, b) => {
        const riskA = a.overdueAmount + a.cashFlowGap + a.uninvoicedRevenue;
        const riskB = b.overdueAmount + b.cashFlowGap + b.uninvoicedRevenue;
        if (riskB !== riskA) return riskB - riskA;
        return a.name.localeCompare(b.name);
      });
  }, [projectCockpitRows, performanceByProjectId, invoiceFinanceByProjectId]);
  const dashboardUnbilledByClient = useMemo(() => {
    const sourceRows = invoiceRevenueStatus?.unbilled_by_client || unbilledSinceLastInvoice.by_client || [];
    const grouped: Record<string, number> = {};
    for (const row of sourceRows) {
      const client = normalizeDashboardClientLabel(row.client_name || "");
      const amount = Number(row.unbilled || 0);
      if (amount <= 0.009) continue;
      grouped[client] = (grouped[client] || 0) + amount;
    }
    const rows = Object.entries(grouped)
      .map(([client, amount]) => ({ client, amount }))
      .sort((a, b) => b.amount - a.amount);
    return {
      total: rows.reduce((sum, row) => sum + row.amount, 0),
      rows,
    };
  }, [invoiceRevenueStatus?.unbilled_by_client, unbilledSinceLastInvoice]);
  const dashboardUnbilledByClientProject = useMemo(() => {
    const sourceRows = invoiceRevenueStatus?.unbilled_by_client_project || unbilledSinceLastInvoice.by_client_project || [];
    const rows = sourceRows
      .map((row) => ({
        client: normalizeDashboardClientLabel(row.client_name || ""),
        project: (row.project_name || "").trim() || `Project ${row.project_id}`,
        hours: Number(row.work_hours || 0),
        amount: Number(row.unbilled || 0),
      }))
      .filter((row) => row.amount > 0.009 || row.hours > 0.009)
      .sort((a, b) => b.amount - a.amount);
    return rows;
  }, [invoiceRevenueStatus?.unbilled_by_client_project, unbilledSinceLastInvoice.by_client_project]);
  const dashboardRevenueStatusTotals = useMemo(() => {
    const earnedRevenueLife = dashboardProjectKpis.reduce((sum, p) => sum + Number(p.revenueLifeToDate || 0), 0);
    const unearnedBudgetRemaining = dashboardProjectKpis.reduce((sum, p) => sum + Number(p.unearnedBudgetRemaining || 0), 0);
    return {
      earnedRevenueLife,
      earnedNotBilled: dashboardUnbilledByClient.total,
      unearnedBudgetRemaining,
    };
  }, [dashboardProjectKpis, dashboardUnbilledByClient.total]);
  const taxPrepReadiness = useMemo(() => {
    const financialInvoices = savedInvoices.filter((inv) => isFinancialInvoice(inv, todayYmd));
    const invoicePaid = financialInvoices.reduce((sum, inv) => sum + Number(inv.amount_paid || 0), 0);
    const invoiceOutstanding = financialInvoices.reduce((sum, inv) => sum + invoiceOutstandingBalance(inv), 0);
    const uncategorizedBankRows = bankQueue.filter((q) => !q.category || String(q.category).trim() === "").length;
    const dataIssues = reconciliationMonthly.reduce(
      (acc, row) => {
        acc.orphanRefs +=
          Number(row.orphan_user_refs || 0) +
          Number(row.orphan_project_refs || 0) +
          Number(row.orphan_task_refs || 0) +
          Number(row.orphan_subtask_refs || 0);
        acc.badRates += Number(row.zero_or_negative_rate_entries || 0);
        return acc;
      },
      { orphanRefs: 0, badRates: 0 },
    );
    return {
      invoicePaid,
      invoiceOutstanding,
      uncategorizedBankRows,
      orphanRefs: dataIssues.orphanRefs,
      badRates: dataIssues.badRates,
    };
  }, [savedInvoices, bankQueue, reconciliationMonthly, todayYmd]);
  const arSummaryFromInvoices = useMemo<ArSummary>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const openInvoices = savedInvoices.filter((inv) => isFinancialInvoice(inv, todayYmd) && invoiceOutstandingBalance(inv) > 0.0001);

    const aging = { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
    const byClient: Record<string, ArClientRow> = {};

    for (const inv of openInvoices) {
      const balance = invoiceOutstandingBalance(inv);
      const due = isValidYmd(inv.due_date) ? new Date(`${inv.due_date}T00:00:00`) : null;
      if (!due) {
        aging.current += balance;
      } else {
        const ageDays = Math.floor((now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000));
        if (ageDays <= 0) aging.current += balance;
        else if (ageDays <= 30) aging["1_30"] += balance;
        else if (ageDays <= 60) aging["31_60"] += balance;
        else if (ageDays <= 90) aging["61_90"] += balance;
        else aging["90_plus"] += balance;
      }

      const clientName = (inv.client_name || "Unknown Client").trim() || "Unknown Client";
      const row = byClient[clientName] || (byClient[clientName] = { client_name: clientName, invoice_count: 0, outstanding: 0, overdue: 0 });
      row.invoice_count += 1;
      row.outstanding += balance;
      if (due && due < now) row.overdue += balance;
    }

    const overdueInvoiceCount = openInvoices.filter((inv) => {
      if (!isValidYmd(inv.due_date)) return false;
      return new Date(`${inv.due_date}T00:00:00`) < now;
    }).length;

    return {
      as_of: todayYmd,
      invoice_count_open: openInvoices.length,
      total_outstanding: openInvoices.reduce((sum, inv) => sum + invoiceOutstandingBalance(inv), 0),
      overdue_invoice_count: overdueInvoiceCount,
      overdue_total: openInvoices.reduce((sum, inv) => {
        if (!isValidYmd(inv.due_date)) return sum;
        const isOverdue = new Date(`${inv.due_date}T00:00:00`) < now;
        return isOverdue ? sum + invoiceOutstandingBalance(inv) : sum;
      }, 0),
      aging,
      top_clients: Object.values(byClient)
        .sort((a, b) => b.outstanding - a.outstanding)
        .slice(0, 10),
    };
  }, [savedInvoices, todayYmd]);
  const effectiveArSummary = arSummary ?? arSummaryFromInvoices;
  const paymentStatusTotals = useMemo(() => {
    const financialInvoices = savedInvoices.filter((inv) => isFinancialInvoice(inv, todayYmd));
    const open = financialInvoices.filter((inv) => invoiceOutstandingBalance(inv) > 0.0001);
    const overdue = open.filter((inv) => isValidYmd(inv.due_date) && inv.due_date < todayYmd);
    return {
      invoiceCount: financialInvoices.length,
      openCount: open.length,
      overdueCount: overdue.length,
      totalInvoiced: financialInvoices.reduce((sum, inv) => sum + Number(inv.subtotal_amount || 0), 0),
      totalPaid: financialInvoices.reduce((sum, inv) => sum + Number(inv.amount_paid || 0), 0),
      totalOutstanding: financialInvoices.reduce((sum, inv) => sum + invoiceOutstandingBalance(inv), 0),
    };
  }, [savedInvoices, todayYmd]);
  const paidToDateDisplay = Number(invoiceRevenueStatus?.total_paid_to_date ?? effectiveArSummary.total_paid_to_date ?? paymentStatusTotals.totalPaid ?? 0);
  const invoiceStatusOverview = useMemo(() => {
    const financialInvoices = savedInvoices.filter((inv) => isFinancialInvoice(inv, todayYmd));
    let sentUnpaidCount = 0;
    let sentUnpaidAmount = 0;
    for (const inv of financialInvoices) {
      const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
      const balance = invoiceOutstandingBalance(inv);
      if (balance <= 0.0001) continue;
      if (effectiveStatus === "draft" || effectiveStatus === "void" || effectiveStatus === "paid") continue;
      sentUnpaidCount += 1;
      sentUnpaidAmount += balance;
    }
    const unbilledAmount = Number(invoiceRevenueStatus?.earned_not_billed_total ?? dashboardUnbilledByClient.total ?? 0);
    return {
      paidToDate: paymentStatusTotals.totalPaid,
      sentUnpaidCount,
      sentUnpaidAmount,
      unbilledAmount,
    };
  }, [savedInvoices, todayYmd, invoiceRevenueStatus?.earned_not_billed_total, dashboardUnbilledByClient.total, paymentStatusTotals.totalPaid]);
  const paymentClientOptions = useMemo(() => {
    return Array.from(
      new Set(
        savedInvoices
          .map((inv) => (inv.client_name || "").trim())
          .filter((name) => name.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [savedInvoices]);
  const suggestedReconcileClient = useMemo(() => {
    const skip = new Set(["imported client", "legacy client"]);
    const tally: Record<string, { label: string; count: number }> = {};
    for (const inv of savedInvoices) {
      const name = (inv.client_name || "").trim();
      if (!name) continue;
      if (skip.has(name.toLowerCase())) continue;
      if (!tally[name]) tally[name] = { label: name, count: 0 };
      tally[name].count += 1;
    }
    return Object.values(tally).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0]?.label || "";
  }, [savedInvoices]);
  const paymentRows = useMemo(() => {
    const now = parseYmdUtc(todayYmd);
    const monthStart = `${todayYmd.slice(0, 7)}-01`;
    const quarter = Math.floor((now.getUTCMonth() + 3) / 3);
    const quarterStartMonth = String((quarter - 1) * 3 + 1).padStart(2, "0");
    const quarterStart = `${now.getUTCFullYear()}-${quarterStartMonth}-01`;
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    const last30Start = formatYmdUtc(addDaysUtc(now, -29));

    return savedInvoices.filter((inv) => {
      const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
      if (paymentStatusFilter === "all" && (effectiveStatus === "draft" || effectiveStatus === "void")) return false;
      if (paymentStatusFilter !== "all" && effectiveStatus !== paymentStatusFilter) return false;
      if (paymentClientFilter !== "all" && (inv.client_name || "").trim() !== paymentClientFilter) return false;
      if (paymentPeriodFilter !== "all") {
        const invoiceDate = isValidYmd(inv.issue_date) ? inv.issue_date : inv.start_date;
        if (!isValidYmd(invoiceDate)) return false;
        if (paymentPeriodFilter === "last30" && invoiceDate < last30Start) return false;
        if (paymentPeriodFilter === "this_month" && invoiceDate < monthStart) return false;
        if (paymentPeriodFilter === "this_quarter" && invoiceDate < quarterStart) return false;
        if (paymentPeriodFilter === "this_year" && invoiceDate < yearStart) return false;
      }
      return true;
    });
  }, [savedInvoices, todayYmd, paymentStatusFilter, paymentClientFilter, paymentPeriodFilter]);
  const paymentFilteredTotals = useMemo(() => {
    const rows = paymentRows;
    const counts = { paid: 0, partial: 0, overdue: 0, sent: 0, draft: 0, void: 0 };
    let outstanding = 0;
    let invoiced = 0;
    let paidAmount = 0;
    for (const inv of rows) {
      const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
      if (effectiveStatus in counts) {
        counts[effectiveStatus as keyof typeof counts] += 1;
      }
      outstanding += invoiceOutstandingBalance(inv);
      invoiced += Number(inv.subtotal_amount || 0);
      paidAmount += Number(inv.amount_paid || 0);
    }
    return {
      rows: rows.length,
      paidCount: counts.paid,
      partialCount: counts.partial,
      overdueCount: counts.overdue,
      sentCount: counts.sent,
      draftCount: counts.draft,
      voidCount: counts.void,
      invoiced,
      paidAmount,
      outstanding,
    };
  }, [paymentRows, todayYmd]);
  const taxYearReconciliationRows = useMemo(() => {
    const prefix = `${reportYear}-`;
    const rows = reconciliationMonthly.filter((r) => r.period.startsWith(prefix));
    return rows.length > 0 ? rows : reconciliationMonthly;
  }, [reconciliationMonthly, reportYear]);
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
  const selectedInvoiceTemplateId = useMemo<InvoiceTemplateId>(
    () => (selectedInvoice ? (invoiceTemplateById[selectedInvoice.id] || "default") : "default"),
    [invoiceTemplateById, selectedInvoice],
  );
  const aquatechTemplateConfig = useMemo<AquatechTemplateConfig>(() => {
    const billToLines = aquatechTemplateBillToText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const references = aquatechTemplateReferencesText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(":"))
      .map((line) => {
        const [label, ...rest] = line.split(":");
        return { label: label.trim(), value: rest.join(":").trim() };
      })
      .filter((ref) => ref.label.length > 0);
    return {
      label: aquatechTemplateLabel.trim() || "Aquatech Generic",
      billToLines: billToLines.length > 0 ? billToLines : ["AquatechPM Client"],
      periodLabel: aquatechTemplatePeriodLabel.trim() || "Professional Services for the Period",
      references,
    };
  }, [aquatechTemplateBillToText, aquatechTemplateLabel, aquatechTemplatePeriodLabel, aquatechTemplateReferencesText]);
  const invoiceDraftTemplateLabel = useMemo(() => {
    if (invoiceDraftTemplateId === "hdr") return "HDR";
    if (invoiceDraftTemplateId === "stantec_bc") return "Stantec + Brown & Caldwell";
    return aquatechTemplateConfig.label;
  }, [aquatechTemplateConfig.label, invoiceDraftTemplateId]);
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
  const dashboardSelectedProject = useMemo(() => {
    if (performanceProjectId) {
      const selected = dashboardProjectKpis.find((p) => p.project_id === performanceProjectId);
      if (selected) return selected;
    }
    return dashboardProjectKpis[0] || null;
  }, [dashboardProjectKpis, performanceProjectId]);
  const dashboardPtdSelectedProject = useMemo(() => {
    if (!reportPtdProjectId) return null;
    return dashboardProjectKpis.find((p) => p.project_id === reportPtdProjectId) || null;
  }, [dashboardProjectKpis, reportPtdProjectId]);
  const dashboardMissingTimesheets = useMemo(() => {
    if (!canApproveTimesheets) return [];
    const present = new Set(adminTimesheets.map((t) => t.user_id));
    return activeUsers.filter((u) => !present.has(u.id));
  }, [activeUsers, adminTimesheets, canApproveTimesheets]);
  const dashboardDataQuality = useMemo(() => {
    const issues = [
      { label: "Users missing rates", value: dashboardUsersWithoutRates.length, high: 0 },
      { label: "Missing timesheets", value: dashboardMissingTimesheets.length, high: 0 },
      { label: "Uncategorized bank rows", value: taxPrepReadiness.uncategorizedBankRows, high: 0 },
      { label: "Orphan references", value: taxPrepReadiness.orphanRefs, high: 0 },
      { label: "Bad rate entries", value: taxPrepReadiness.badRates, high: 0 },
    ];
    const openCount = issues.filter((i) => i.value > i.high).length;
    return {
      issues,
      openCount,
      healthLabel: openCount === 0 ? "Healthy" : `${openCount} open issue${openCount === 1 ? "" : "s"}`,
    };
  }, [dashboardMissingTimesheets.length, dashboardUsersWithoutRates.length, taxPrepReadiness.badRates, taxPrepReadiness.orphanRefs, taxPrepReadiness.uncategorizedBankRows]);
  const isClientView = activeView === "clients";
  const isPeopleView = activeView === "people";
  const isAccountingView =
    activeView === "accounting" || activeView === "invoices" || activeView === "payments" || activeView === "expenses";
  const showInvoiceStudio = activeView === "invoices" && invoiceWorkspaceTab === "studio";
  const showSavedInvoices =
    (activeView === "invoices" && invoiceWorkspaceTab === "saved") ||
    (activeView === "payments" && paymentWorkspaceTab === "status");
  const showPaymentsImport = activeView !== "invoices" && paymentWorkspaceTab === "status";
  const showPaymentStatusWorkspace = activeView === "payments" && paymentWorkspaceTab === "status";
  const showRecurringSchedules = activeView === "invoices" && invoiceWorkspaceTab === "recurring";
  const showLegacyImport = activeView === "invoices" && invoiceWorkspaceTab === "legacy";
  const showInvoiceTemplates = activeView === "invoices" && invoiceWorkspaceTab === "templates";
  const showArDashboard =
    (activeView === "invoices" && invoiceWorkspaceTab === "ar") ||
    (activeView === "payments" && paymentWorkspaceTab === "ar");
  const showExpenseCostControls = activeView === "expenses" && expenseWorkspaceTab === "costs";
  const showReconciliation =
    (activeView === "expenses" && expenseWorkspaceTab === "reconciliation") ||
    (activeView === "reports" && reportsWorkspaceTab === "financial");
  const shouldLoadFinancialKpis =
    canViewFinancials &&
    (activeView === "dashboard" || activeView === "projects" || activeView === "estimates" || activeView === "reports" || isAccountingView);
  const shouldLoadBillingData = canViewFinancials && (activeView === "dashboard" || isAccountingView || activeView === "reports");
  const shouldLoadBankData = canViewFinancials && (activeView === "dashboard" || isAccountingView || activeView === "reports" || activeView === "settings");
  const messageIsError = /(error|failed|exception|invalid|not found|unauthorized|forbidden|expired|denied)/i.test(message);
  const workspaceTitle = useMemo(() => {
    if (activeView === "dashboard") return dashboardSubView === "controls" ? "Dashboard | Project Control Board" : "Dashboard";
    return WORKSPACE_TITLES[activeView] || "Workspace";
  }, [activeView, dashboardSubView]);
  const workspaceHint = useMemo(() => {
    if (activeView === "dashboard" && dashboardSubView === "controls") return "Detailed project controls, diagnostics, and drilldowns.";
    return WORKSPACE_HINTS[activeView] || "Operational control panel.";
  }, [activeView, dashboardSubView]);
  const showTopbarImportButtons = !lockToMyTimesheet && canViewFinancials && !(activeView === "dashboard" && dashboardSubView === "overview");
  const primaryActionLabel = useMemo(() => PRIMARY_ACTION_LABELS[activeView] || "Open Dashboard", [activeView]);
  function handlePrimaryAction() {
    if (activeView === "dashboard" || activeView === "people") {
      setActiveView("people");
      setPeopleSubView("profiles");
      return;
    }
    if (activeView === "invoices") {
      setInvoiceWorkspaceTab("saved");
      return;
    }
    if (activeView === "projects") {
      setActiveView("projects");
      setProjectSubView("setup");
      return;
    }
    if (activeView === "time") {
      setActiveView("time");
      setTimeSubView("entry");
      return;
    }
    if (activeView === "reports") {
      setReportsWorkspaceTab("financial");
      return;
    }
    if (activeView === "settings") {
      setActiveView("dashboard");
      setDashboardSubView("overview");
      return;
    }
    setActiveView("dashboard");
    setDashboardSubView("overview");
  }
  function openTeamSettings() {
    setActiveView("people");
    setPeopleSubView("profiles");
  }

  function openProjectSetup() {
    setActiveView("projects");
    setProjectSubView("setup");
  }

  function openProjectPerformance() {
    setActiveView("projects");
    setProjectSubView("performance");
  }

  function openProjectEditor() {
    setActiveView("projects");
    setProjectSubView("editor");
  }

  function openTimesheetWorkspace() {
    setActiveView("timesheets");
    setTimesheetSubView(canApproveTimesheets ? "team" : "mine");
  }

  function openInvoices() {
    setActiveView("invoices");
  }

  function openExpenses() {
    setActiveView("expenses");
  }

  function openEstimates() {
    setActiveView("estimates");
  }

  function openPayroll() {
    setActiveView("payroll");
  }

  function openAccountingWorkspace() {
    setActiveView("accounting");
    setAccountingSubView("workspace");
  }

  function openSettings() {
    setActiveView("settings");
    setSettingsSubView("workspace");
  }

  function openSettingsBankConnections() {
    setActiveView("settings");
    setSettingsSubView("bank_connections");
  }

  function openSettingsBankTransactions() {
    setActiveView("settings");
    setSettingsSubView("bank_transactions");
  }

  function openSettingsExpenseMix() {
    setActiveView("settings");
    setSettingsSubView("expense_mix");
  }

  function openDashboardHome() {
    setActiveView("dashboard");
    setDashboardSubView("overview");
  }
  function openDataQualityIssue(issueLabel: string) {
    if (issueLabel === "Users missing rates") {
      openPayroll();
      return;
    }
    if (issueLabel === "Missing timesheets") {
      openTimesheetWorkspace();
      return;
    }
    if (issueLabel === "Uncategorized bank rows") {
      openSettingsBankTransactions();
      return;
    }
    if (issueLabel === "Orphan references" || issueLabel === "Bad rate entries") {
      setActiveView("reports");
      setReportsWorkspaceTab("financial");
      return;
    }
  }

  const dashboardMonthlyTrend = useMemo(() => {
    const rows = (overallReconciliationMonthly || []).slice(-dashboardTrendWindowMonths);
    const mapped = rows.map((r) => ({
      period: r.period,
      revenue: Number(r.bill_amount || 0),
      cost: Number(r.cost_amount || 0),
      revenuePctBudget:
        companyOverallSummary.totalContractedBudget > 0
          ? (Number(r.bill_amount || 0) / companyOverallSummary.totalContractedBudget) * 100
          : 0,
      costPctBudget:
        companyOverallSummary.totalContractedBudget > 0
          ? (Number(r.cost_amount || 0) / companyOverallSummary.totalContractedBudget) * 100
          : 0,
    }));
    const maxValue =
      dashboardChartScale === "amount"
        ? mapped.reduce((m, r) => Math.max(m, r.revenue, r.cost), 0)
        : mapped.reduce((m, r) => Math.max(m, r.revenuePctBudget, r.costPctBudget), 0);
    return { rows: mapped, maxValue: maxValue > 0 ? maxValue : 1 };
  }, [companyOverallSummary.totalContractedBudget, dashboardChartScale, dashboardTrendWindowMonths, overallReconciliationMonthly]);
  const dashboardAnalysisSourceRows = useMemo(
    () => (dashboardAnalysisScope === "inception" ? contractProjectPerformance : dashboardProjectPerformance),
    [contractProjectPerformance, dashboardAnalysisScope, dashboardProjectPerformance],
  );
  const dashboardAnalysisRows = useMemo(() => {
    const grouped: Record<string, DashboardAnalysisRow> = {};
    const track = (key: string, label: string, projectId: number, hours: number, revenue: number, cost: number, profit: number) => {
      if (!grouped[key]) {
        grouped[key] = {
          key,
          label,
          projects: 0,
          hours: 0,
          pay: 0,
          revenue: 0,
          cost: 0,
          profit: 0,
          margin_pct: 0,
        };
      }
      const row = grouped[key];
      row.hours += Number(hours || 0);
      row.pay += Number(cost || 0);
      row.revenue += Number(revenue || 0);
      row.cost += Number(cost || 0);
      row.profit += Number(profit || 0);
      if (!Number.isNaN(projectId)) row.projects += 1;
    };

    for (const p of dashboardAnalysisSourceRows) {
      if (dashboardAnalysisProjectId && p.project_id !== dashboardAnalysisProjectId) continue;
      if (dashboardAnalysisDimension === "project") {
        track(
          `project-${p.project_id}`,
          p.project_name || `Project ${p.project_id}`,
          p.project_id,
          Number(p.actual_hours || 0),
          Number(p.actual_revenue || 0),
          Number(p.actual_cost || 0),
          Number(p.actual_profit || 0),
        );
        continue;
      }
      if (dashboardAnalysisDimension === "employee") {
        for (const row of p.by_employee || []) {
          const label = row.name || row.email || `User ${row.user_id}`;
          track(`employee-${row.user_id}`, label, p.project_id, row.hours, row.revenue, row.cost, row.profit);
        }
        continue;
      }
      if (dashboardAnalysisDimension === "task") {
        for (const row of p.by_task || []) {
          const label = row.task_name || `Task ${row.task_id}`;
          track(`task-${row.task_id}`, label, p.project_id, row.hours, row.revenue, row.cost, row.profit);
        }
        continue;
      }
      for (const row of p.by_subtask || []) {
        const label = `${row.subtask_code || ""} ${row.subtask_name || ""}`.trim() || `Subtask ${row.subtask_id}`;
        track(`subtask-${row.subtask_id}`, label, p.project_id, row.hours, row.revenue, row.cost, row.profit);
      }
    }

    const metricValue = (r: DashboardAnalysisRow) => {
      if (dashboardAnalysisMetric === "margin_pct") return r.margin_pct;
      if (dashboardAnalysisMetric === "hours") return r.hours;
      if (dashboardAnalysisMetric === "pay") return r.pay;
      if (dashboardAnalysisMetric === "revenue") return r.revenue;
      if (dashboardAnalysisMetric === "cost") return r.cost;
      return r.profit;
    };
    const rows = Object.values(grouped).map((r) => ({
      ...r,
      margin_pct: marginPct(r.revenue, r.profit),
    }));
    rows.sort((a, b) => metricValue(b) - metricValue(a));
    return rows.slice(0, dashboardAnalysisLimit);
  }, [
    dashboardAnalysisDimension,
    dashboardAnalysisLimit,
    dashboardAnalysisMetric,
    dashboardAnalysisProjectId,
    dashboardAnalysisSourceRows,
  ]);
  const dashboardAnalysisTotals = useMemo(() => {
    return dashboardAnalysisRows.reduce(
      (acc, row) => {
        acc.hours += row.hours;
        acc.pay += row.pay;
        acc.revenue += row.revenue;
        acc.cost += row.cost;
        acc.profit += row.profit;
        return acc;
      },
      { hours: 0, pay: 0, revenue: 0, cost: 0, profit: 0 },
    );
  }, [dashboardAnalysisRows]);
  const bankCategoryPieSlices = useMemo(() => {
    const palette = ["#2f4f73", "#f3a35f", "#8db68b", "#6a8caf", "#d36f6f", "#6d9f9f", "#b88a3b"];
    return (bankSummaryRows || [])
      .slice(0, 7)
      .map((r, idx) => ({
        label: r.label,
        value: Number(r.amount_abs || 0),
        color: palette[idx % palette.length],
      }))
      .filter((s) => s.value > 0);
  }, [bankSummaryRows]);
  const bankCategorySummaryTotals = useMemo(() => {
    return (bankSummaryRows || []).reduce(
      (acc, row) => {
        acc.amount += Number(row.amount_abs || 0);
        acc.count += Number(row.transaction_count || 0);
        return acc;
      },
      { amount: 0, count: 0 },
    );
  }, [bankSummaryRows]);
  const bankConnectionById = useMemo(() => {
    const out: Record<number, BankConnection> = {};
    for (const conn of bankConnections) out[conn.id] = conn;
    return out;
  }, [bankConnections]);
  const hasPlaidConnection = useMemo(
    () => bankConnections.some((c) => c.provider === "plaid"),
    [bankConnections],
  );
  const visibleBankQueue = useMemo(() => {
    const needle = bankQueueSearch.trim().toLowerCase();
    const filtered = (bankQueue || []).filter((row) => {
      if (bankQueueConnectionFilter && row.connection_id !== bankQueueConnectionFilter) return false;
      if (bankQueueGroupFilter !== "all" && (row.expense_group || "Unassigned") !== bankQueueGroupFilter) return false;
      if (!needle) return true;
      const connectionLabel = bankConnectionById[row.connection_id]?.institution_name || "";
      const haystack = `${row.description || ""} ${row.merchant_name || ""} ${row.account_name || row.account_id || ""} ${row.expense_group || ""} ${row.category || ""} ${connectionLabel}`.toLowerCase();
      return haystack.includes(needle);
    });
    filtered.sort((a, b) => {
      if (bankQueueSort === "amount_desc") return Math.abs(b.amount || 0) - Math.abs(a.amount || 0);
      if (bankQueueSort === "amount_asc") return Math.abs(a.amount || 0) - Math.abs(b.amount || 0);
      if (bankQueueSort === "date_asc") return String(a.posted_date || "").localeCompare(String(b.posted_date || ""));
      if (bankQueueSort === "confidence_desc") return Number(b.suggested_confidence || 0) - Number(a.suggested_confidence || 0);
      return String(b.posted_date || "").localeCompare(String(a.posted_date || ""));
    });
    return filtered;
  }, [bankConnectionById, bankQueue, bankQueueConnectionFilter, bankQueueGroupFilter, bankQueueSearch, bankQueueSort]);
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
    if (activeUsers.length > 0) {
      return [...activeUsers].sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
    }
    const fallback = new Map<number, User>();
    for (const t of adminTimesheets) {
      if (fallback.has(t.user_id)) continue;
      fallback.set(t.user_id, {
        id: t.user_id,
        email: t.user_email || "",
        full_name: t.user_full_name || t.user_email || `User ${t.user_id}`,
        role: "employee",
        is_active: true,
        start_date: null,
        permissions: [],
      });
    }
    return Array.from(fallback.values()).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  }, [activeUsers, adminTimesheets, allUsers]);
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
  const pendingAdminTimesheets = useMemo(
    () => adminTimesheets.filter((t) => t.status === "submitted"),
    [adminTimesheets],
  );
  const selectedPendingTimesheet = useMemo(() => {
    if (pendingAdminTimesheets.length === 0) return null;
    if (selectedPendingTimesheetId) {
      const found = pendingAdminTimesheets.find((t) => t.id === selectedPendingTimesheetId);
      if (found) return found;
    }
    return pendingAdminTimesheets[0] || null;
  }, [pendingAdminTimesheets, selectedPendingTimesheetId]);
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
  const userNameById = useMemo(() => {
    const map: Record<number, string> = {};
    for (const u of allUsers) {
      map[u.id] = u.full_name || u.email || `User ${u.id}`;
    }
    return map;
  }, [allUsers]);
  const selectedReviewTimesheet = useMemo(() => {
    if (timesheetSubView === "team") return selectedAdminTimesheets[0] || null;
    if (timesheetSubView === "pending") return selectedPendingTimesheet;
    return selectedMyTimesheets[0] || null;
  }, [timesheetSubView, selectedAdminTimesheets, selectedMyTimesheets, selectedPendingTimesheet]);
  const selectedReviewUserLabel = useMemo(() => {
    if (timesheetSubView === "team") {
      if (!timesheetUserFilter) return "Select employee";
      const found = availableTimesheetUsers.find((u) => u.id === timesheetUserFilter);
      return found?.full_name || found?.email || `User ${timesheetUserFilter}`;
    }
    if (timesheetSubView === "pending") {
      if (!selectedPendingTimesheet) return "Select submitted timesheet";
      return selectedPendingTimesheet.user_full_name || selectedPendingTimesheet.user_email || `User ${selectedPendingTimesheet.user_id}`;
    }
    return me?.full_name || me?.email || "My timesheet";
  }, [timesheetSubView, timesheetUserFilter, availableTimesheetUsers, me, selectedPendingTimesheet]);
  const timesheetAnalysisRows = useMemo(() => {
    const grouped: Record<string, { label: string; hours: number; entries: number }> = {};
    for (const entry of timeEntries) {
      const employeeLabel =
        entry.user_full_name ||
        entry.user_email ||
        userNameById[entry.user_id] ||
        `User ${entry.user_id}`;
      const projectLabel = entry.project_name || `Project ${entry.project_id}`;
      const taskLabel = entry.task_name || `Task ${entry.task_id}`;
      const key =
        timesheetAnalysisDimension === "employee"
          ? `employee|${entry.user_id}`
          : timesheetAnalysisDimension === "project"
            ? `project|${entry.project_id}`
            : `task|${entry.project_id}|${entry.task_id}`;
      const label =
        timesheetAnalysisDimension === "employee"
          ? employeeLabel
          : timesheetAnalysisDimension === "project"
            ? projectLabel
            : `${projectLabel} / ${taskLabel}`;
      if (!grouped[key]) grouped[key] = { label, hours: 0, entries: 0 };
      grouped[key].hours += Number(entry.hours || 0);
      grouped[key].entries += 1;
    }
    return Object.values(grouped).sort((a, b) => b.hours - a.hours || a.label.localeCompare(b.label));
  }, [timeEntries, timesheetAnalysisDimension, userNameById]);

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

  function markSyncNow() {
    const t = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLastSyncAt(t);
  }

  async function refreshBankWorkspaceData() {
    await Promise.all([refreshBankConnections(), refreshBankAccounts(), refreshBankQueue(), refreshBankSummary()]);
  }

  async function refreshFinancialWorkspaceData() {
    await Promise.all([refreshProjectPerformance(), refreshReconciliationReport(), refreshOverallReconciliationTrend()]);
  }

  async function refreshBillingWorkspaceData() {
    await Promise.all([refreshInvoicePreview(), refreshInvoices(), refreshArSummary(), refreshInvoiceRevenueStatus(), refreshRecurringSchedules()]);
  }

  async function refreshCurrentWorkspace() {
    if (isRefreshingWorkspace) return;
    setIsRefreshingWorkspace(true);
    try {
      if (activeView === "dashboard") {
        await Promise.all([refreshFinancialWorkspaceData(), refreshAdminTimesheets(), refreshBankWorkspaceData()]);
      } else if (activeView === "time" || activeView === "timesheets" || activeView === "projects" || isClientView || isPeopleView || activeView === "payroll") {
        await refreshData();
        if (activeView === "timesheets") await refreshAdminTimesheets();
        if (activeView === "projects" && canViewFinancials) await refreshProjectPerformance();
      } else if (activeView === "settings") {
        await Promise.all([refreshData(), refreshBankWorkspaceData(), refreshAuditEvents()]);
      } else if (isAccountingView || activeView === "reports" || activeView === "estimates") {
        await Promise.all([refreshFinancialWorkspaceData(), refreshBillingWorkspaceData(), refreshBankWorkspaceData()]);
      } else {
        await refreshData();
      }
      markSyncNow();
      setMessage("Workspace refreshed.");
    } catch (err) {
      handleApiError(err);
    } finally {
      setIsRefreshingWorkspace(false);
    }
  }

  async function refreshData() {
    if (!me) return;
    if (refreshDataInFlightRef.current) {
      refreshDataQueuedRef.current = true;
      return;
    }
    refreshDataInFlightRef.current = true;
    const requestId = refreshDataRequestIdRef.current + 1;
    refreshDataRequestIdRef.current = requestId;
    try {
      const selectedWeekPeriod =
        lockToMyTimesheet && timeViewMode === "week"
          ? parseTimesheetPeriodLabel(canApproveTimesheets ? timesheetPeriodFilter : myTimesheetPeriodFilter)
          : null;
      const rangeStart = selectedWeekPeriod?.start || currentRange.start;
      const rangeEnd = selectedWeekPeriod?.end || currentRange.end;
      const params = new URLSearchParams({ start: rangeStart, end: rangeEnd });
      const effectiveUserId = lockToMyTimesheet ? (canApproveTimesheets ? timesheetUserFilter : me.id) : timeFilterUserId;
      if (effectiveUserId) params.set("user_id", String(effectiveUserId));
      if (!lockToMyTimesheet) {
        if (timeFilterProjectId) params.set("project_id", String(timeFilterProjectId));
        if (timeFilterTaskId) params.set("task_id", String(timeFilterTaskId));
        if (timeFilterSubtaskId) params.set("subtask_id", String(timeFilterSubtaskId));
      }

      const [allProjects, entries, mine] = await Promise.all([
        apiGet<Project[]>("/projects"),
        apiGet<TimeEntry[]>(`/time-entries?${params.toString()}`),
        apiGet<Timesheet[]>("/timesheets/mine"),
      ]);
      if (requestId !== refreshDataRequestIdRef.current) return;
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
              end_date: proj.end_date || "",
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
      setTimeEntries(entries);
      setTimesheets(mine);
      if (canManageUsers || canApproveTimesheets) {
        const [pending, users, latest] = await Promise.all([
          canManageUsers ? apiGet<User[]>("/users/pending") : Promise.resolve<User[]>([]),
          apiGet<User[]>("/users").catch(() => [] as User[]),
          canManageUsers && canManageRates ? apiGet<LatestRate[]>("/rates/latest") : Promise.resolve<LatestRate[] | null>(null),
        ]);
        if (requestId !== refreshDataRequestIdRef.current) return;
        setPendingUsers(pending);
        setAllUsers(users);
        setAdminEntryUserId((prev) => {
          const active = users.filter((u) => u.is_active);
          if (active.length === 0) return null;
          if (prev && active.some((u) => u.id === prev)) return prev;
          return active[0].id;
        });
        if (canManageUsers) {
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
          setPeopleEditorUserId((prev) => {
            const active = users.filter((u) => u.is_active);
            if (active.length === 0) return null;
            if (prev && active.some((u) => u.id === prev)) return prev;
            return active[0].id;
          });
          await refreshAuditEvents();
        } else {
          setPeopleEditorUserId(null);
        }
        if (latest) {
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
      markSyncNow();
    } catch (e) {
      handleApiError(e);
    } finally {
      refreshDataInFlightRef.current = false;
      if (refreshDataQueuedRef.current) {
        refreshDataQueuedRef.current = false;
        void refreshData();
      }
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
      markSyncNow();
    } catch (err) {
      handleApiError(err);
    }
  }

  async function refreshAdminTimesheets() {
    if (!canApproveTimesheets) {
      setAdminTimesheets([]);
      return;
    }
    const currentWeek = rangeFor("week", todayYmd);
    const start = lockToMyTimesheet ? "2000-01-01" : reportStart;
    const end = lockToMyTimesheet ? currentWeek.end : reportEnd;
    if (!isValidYmd(start) || !isValidYmd(end)) return;
    const params = new URLSearchParams({ start, end });
    if (timesheetSubView === "pending") {
      params.set("status_filter", "submitted");
    } else if (!lockToMyTimesheet && timesheetStatusFilter) {
      params.set("status_filter", timesheetStatusFilter);
    }
    if (timesheetSubView !== "pending" && timesheetUserFilter) params.set("user_id", String(timesheetUserFilter));
    try {
      const rows = await apiGet<AdminTimesheet[]>(`/timesheets/all?${params.toString()}`);
      setAdminTimesheets(rows);
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshProjectPerformance() {
    if (!canViewFinancials) {
      setProjectPerformance([]);
      setContractProjectPerformance([]);
      return;
    }
    if (!isValidYmd(reportStart) || !isValidYmd(reportEnd)) return;
    const params = new URLSearchParams({ start: reportStart, end: reportEnd });
    const contractParams = new URLSearchParams({ start: "2000-01-01", end: todayYmd });
    try {
      const [payload, contractPayload] = await Promise.all([
        apiGet<{ projects: ProjectPerformance[] }>(`/reports/project-performance?${params.toString()}`),
        apiGet<{ projects: ProjectPerformance[] }>(`/reports/project-performance?${contractParams.toString()}`),
      ]);
      const rows = payload.projects || [];
      const contractRows = contractPayload.projects || [];
      setProjectPerformance(rows);
      setContractProjectPerformance(contractRows);
      setPerformanceProjectId((prev) => {
        if (rows.length === 0) return null;
        if (prev && rows.some((r) => r.project_id === prev)) return prev;
        return rows[0].project_id;
      });
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function runMonthEndCloseCheck() {
    if (!canViewFinancials) {
      setMessage("You do not have permission to run month-end checks.");
      return;
    }
    if (isRunningMonthEndCheck) return;
    try {
      setIsRunningMonthEndCheck(true);
      await Promise.all([
        refreshProjectPerformance(),
        refreshInvoices(),
        refreshArSummary(),
        refreshBankQueue(),
        refreshBankSummary(),
        refreshReconciliationReport(),
      ]);
      setMessage("Month-end check complete. Review Tax Prep KPIs and clear remaining alerts.");
    } catch (err) {
      setMessage(String(err));
    } finally {
      setIsRunningMonthEndCheck(false);
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
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshOverallReconciliationTrend() {
    if (!canViewFinancials) {
      setOverallReconciliationMonthly([]);
      return;
    }
    const end = todayYmd;
    const startDate = new Date(`${todayYmd}T00:00:00Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 370);
    const start = startDate.toISOString().slice(0, 10);
    try {
      const params = new URLSearchParams({ start, end });
      const payload = await apiGet<ReconciliationReport>(`/reports/reconciliation?${params.toString()}`);
      setOverallReconciliationMonthly(payload.monthly || []);
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
    if (!invoiceProjectId) {
      setInvoicePreview(null);
      return;
    }
    try {
      const params = new URLSearchParams({
        start: invoiceStart,
        end: invoiceEnd,
        approved_only: invoiceApprovedOnly ? "true" : "false",
      });
      params.set("project_id", String(invoiceProjectId));
      const payload = await apiGet<InvoicePreview>(`/invoices/preview?${params.toString()}`);
      setInvoicePreview(payload);
      markSyncNow();
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
      await refreshUnbilledSinceLastInvoice();
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshUnbilledSinceLastInvoice() {
    if (!canViewFinancials) {
      setUnbilledSinceLastInvoice({ as_of: todayYmd, by_client: [] });
      return;
    }
    try {
      const payload = await apiGet<UnbilledSinceLastInvoice>("/reports/unbilled-since-last-invoice");
      setUnbilledSinceLastInvoice(payload);
      markSyncNow();
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
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshInvoiceRevenueStatus() {
    if (!canViewFinancials) {
      setInvoiceRevenueStatus(null);
      return;
    }
    try {
      const payload = await apiGet<InvoiceRevenueStatus>("/reports/invoice-revenue-status");
      setInvoiceRevenueStatus(payload);
      markSyncNow();
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
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  const refreshAuditEvents = useCallback(async () => {
    if (!canManageUsers) {
      setAuditEvents([]);
      return;
    }
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (auditEntityFilter.trim()) params.set("entity_type", auditEntityFilter.trim());
      if (auditActionFilter.trim()) params.set("action", auditActionFilter.trim());
      const rows = await apiGet<AuditEvent[]>(`/audit/events?${params.toString()}`);
      setAuditEvents(rows);
    } catch (err) {
      setMessage(String(err));
    }
  }, [canManageUsers, auditActionFilter, auditEntityFilter]);

  async function refreshBankConnections() {
    if (!canViewFinancials) {
      setBankConnections([]);
      return;
    }
    try {
      const rows = await apiGet<BankConnection[]>("/bank/connections");
      setBankConnections(rows);
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshBankAccounts() {
    if (!canViewFinancials) {
      setBankAccounts([]);
      return;
    }
    try {
      const rows = await apiGet<BankAccount[]>("/bank/accounts");
      setBankAccounts(rows);
      markSyncNow();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshBankCategories() {
    if (!canViewFinancials) {
      setBankCategoryGroups([]);
      return;
    }
    try {
      const rows = await apiGet<BankCategoryGroup[]>("/bank/categories");
      setBankCategoryGroups(rows || []);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshBankSummary() {
    if (!canViewFinancials) {
      setBankSummaryRows([]);
      return;
    }
    try {
      const params = new URLSearchParams({
        group_by: bankSummaryBreakdown,
        include_personal: bankQueueIncludePersonal ? "true" : "false",
        unmatched_only: "true",
        limit: "20",
      });
      const rows = await apiGet<BankExpenseSummaryRow[]>(`/bank/summary?${params.toString()}`);
      setBankSummaryRows(rows || []);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function refreshBankQueue() {
    if (!canViewFinancials) {
      setBankQueue([]);
      setBankQueueTotal(0);
      return;
    }
    try {
      const params = new URLSearchParams({
        limit: String(bankQueueLimit),
        offset: String(bankQueueOffset),
        include_personal: bankQueueIncludePersonal ? "true" : "false",
      });
      const payload = await apiGet<BankReconciliationQueueResult>(`/bank/reconciliation/queue-page?${params.toString()}`);
      setBankQueue(payload.rows || []);
      setBankQueueTotal(Number(payload.total || 0));
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function classifyBankAccount(bankAccountId: number, isBusiness: boolean) {
    try {
      await apiPost(`/bank/accounts/${bankAccountId}/classification`, { is_business: isBusiness });
      setMessage(`Bank account marked as ${isBusiness ? "business" : "personal"}.`);
      await Promise.all([refreshBankAccounts(), refreshBankQueue()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function classifyBankTransaction(bankTransactionId: number, isBusiness: boolean) {
    try {
      await apiPost(`/bank/transactions/${bankTransactionId}/classification`, { is_business: isBusiness });
      setMessage(`Transaction marked as ${isBusiness ? "business" : "personal"}.`);
      await Promise.all([refreshBankQueue(), refreshBankSummary()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  function bankCategoryDraftFor(row: BankReconciliationQueueRow) {
    const existing = bankCategoryDrafts[row.bank_transaction_id];
    if (existing) return existing;
    const fallbackGroup = row.expense_group || "OH";
    const fallbackCategory = row.category || "Uncategorized";
    return {
      expense_group: fallbackGroup,
      category: fallbackCategory,
      learn_for_merchant: true,
    };
  }

  async function categorizeBankTransaction(bankTransactionId: number) {
    const row = bankQueue.find((q) => q.bank_transaction_id === bankTransactionId);
    if (!row) return;
    const draft = bankCategoryDraftFor(row);
    try {
      await apiPost(`/bank/transactions/${bankTransactionId}/categorize`, {
        expense_group: draft.expense_group,
        category: draft.category,
        learn_for_merchant: draft.learn_for_merchant,
      });
      setMessage(`Categorized transaction as ${draft.expense_group} / ${draft.category}.`);
      await Promise.all([refreshBankQueue(), refreshBankSummary()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function postBankTransactionToProjectExpense(bankTransactionId: number) {
    if (!bankExpenseProjectId) {
      setMessage("Select a project before posting transactions to project expenses.");
      return;
    }
    try {
      await apiPost(`/bank/transactions/${bankTransactionId}/post-expense`, {
        project_id: bankExpenseProjectId,
        category: "Bank Import",
      });
      setMessage("Transaction posted to project expenses.");
      await Promise.all([refreshBankQueue(), refreshBankSummary(), refreshProjectExpenses(bankExpenseProjectId), refreshProjectPerformance()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function importExpenseCatCategorizedCsv(file: File, defaultIsBusiness = true) {
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("connection_name", "Expense_CAT Import");
      form.append("default_is_business", defaultIsBusiness ? "true" : "false");
      const res = await fetch(`${API_BASE}/bank/import/expense-cat-categorized`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as BankImportExpenseCatResult;
      setMessage(
        `Expense_CAT import complete. Rows: ${payload.rows_total}, skipped: ${payload.rows_skipped}, created: ${payload.transactions_created}, updated: ${payload.transactions_updated}.`,
      );
      await refreshBankWorkspaceData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  function selectExpenseCatCategorizedCsv(defaultIsBusiness = true) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".csv,text/csv";
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) return;
      importExpenseCatCategorizedCsv(file, defaultIsBusiness);
    };
    picker.click();
  }

  async function ensurePlaidScriptLoaded(): Promise<void> {
    if (typeof window === "undefined") return;
    if (window.Plaid) return;
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Plaid script.")), { once: true });
        return;
      }
      const s = document.createElement("script");
      s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Plaid script."));
      document.head.appendChild(s);
    });
  }

  async function connectPlaidLink(connectionId?: number) {
    if (!canViewFinancials) {
      setMessage("You do not have permission to connect bank feeds.");
      return;
    }
    if (isPlaidConnecting) return;
    setIsPlaidConnecting(true);
    try {
      await ensurePlaidScriptLoaded();
      const tokenPayload = await apiPost<{ link_token: string; expiration: string }>("/bank/plaid/link-token", {
        connection_id: connectionId ?? null,
      });
      if (!window.Plaid) throw new Error("Plaid script did not initialize.");
      const handler = window.Plaid.create({
        token: tokenPayload.link_token,
        onSuccess: async (public_token) => {
          try {
            const res = await apiPost<{ ok: boolean; institution_name: string; accounts: number }>(
              "/bank/plaid/exchange-public-token",
              { public_token },
            );
            setMessage(
              connectionId
                ? `Plaid re-authentication complete (${res.institution_name}). Accounts discovered: ${res.accounts}.`
                : `Plaid bank connected (${res.institution_name}). Accounts discovered: ${res.accounts}.`,
            );
            await refreshBankWorkspaceData();
          } catch (err) {
            setMessage(String(err));
          } finally {
            setIsPlaidConnecting(false);
          }
        },
        onExit: (err) => {
          if (err) setMessage("Plaid link closed with an error.");
          setIsPlaidConnecting(false);
        },
      });
      handler.open();
    } catch (err) {
      setMessage(String(err));
      setIsPlaidConnecting(false);
    }
  }

  async function connectPlaidSandbox() {
    if (!canViewFinancials) {
      setMessage("You do not have permission to connect bank feeds.");
      return;
    }
    try {
      const res = await apiPost<{ ok: boolean; connection_id: number; institution_name: string; accounts: number }>(
        "/bank/plaid/sandbox/connect",
        {},
      );
      setMessage(`Bank connected (${res.institution_name}). Accounts discovered: ${res.accounts}.`);
      await refreshBankWorkspaceData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function syncBankConnection(connectionId: number) {
    if (!canViewFinancials) {
      setMessage("You do not have permission to sync bank feeds.");
      return;
    }
    try {
      const res = await apiPost<{
        ok: boolean;
        added: number;
        modified: number;
        removed: number;
        reauth_required?: boolean;
        reauth_detail?: string | null;
      }>(
        `/bank/connections/${connectionId}/sync`,
        {},
      );
      if (res.reauth_required) {
        setMessage(res.reauth_detail || "Bank requires a one-time re-authentication. Opening Plaid now...");
        await refreshBankWorkspaceData();
        await connectPlaidLink(connectionId);
        return;
      }
      setMessage(`Bank sync complete. Added: ${res.added}, modified: ${res.modified}, removed: ${res.removed}.`);
      await refreshBankWorkspaceData();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function reconcileImportedBankTransactions() {
    if (!canViewFinancials) {
      setMessage("You do not have permission to reconcile bank feeds.");
      return;
    }
    try {
      const res = await apiPost<BankImportedPlaidReconcileResult>("/bank/reconciliation/reconcile-imported", {});
      setMessage(
        `Duplicate reconciliation complete. Matched ${res.matched_duplicates} imported rows to Plaid. Remaining imported unmatched: ${res.remaining_unmatched_imported}.`,
      );
      await Promise.all([refreshBankQueue(), refreshBankSummary()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function applyBankCategoryRecommendations() {
    if (!canViewFinancials) {
      setMessage("You do not have permission to categorize bank feeds.");
      return;
    }
    try {
      const res = await apiPost<BankCategoryRecommendationResult>(
        "/bank/reconciliation/apply-category-recommendations?min_confidence=0.8",
        {},
      );
      setMessage(
        `Smart categorization complete. Updated ${res.updated} of ${res.reviewed} reviewed transactions. Skipped no-match: ${res.skipped_no_match}.`,
      );
      await Promise.all([refreshBankQueue(), refreshBankSummary()]);
    } catch (err) {
      setMessage(String(err));
    }
  }

  function resetBankQueueFilters() {
    setBankQueueSearch("");
    setBankQueueConnectionFilter(null);
    setBankQueueGroupFilter("all");
    setBankQueueSort("date_desc");
  }

  async function confirmBankMatch(bankTransactionId: number, invoiceId: number) {
    try {
      await apiPost("/bank/reconciliation/match", {
        bank_transaction_id: bankTransactionId,
        match_type: "invoice",
        match_entity_id: invoiceId,
        status: "confirmed",
        confidence: 0.95,
      });
      setMessage("Bank transaction matched to invoice.");
      await refreshBankQueue();
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
    try {
      const raw = window.localStorage.getItem("aq_invoice_template_default_v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<AquatechTemplateConfig>;
      if (typeof parsed.label === "string") setAquatechTemplateLabel(parsed.label);
      if (typeof parsed.periodLabel === "string") setAquatechTemplatePeriodLabel(parsed.periodLabel);
      if (Array.isArray(parsed.billToLines)) setAquatechTemplateBillToText(parsed.billToLines.join("\n"));
      if (Array.isArray(parsed.references)) {
        const lines = parsed.references
          .filter((r) => r && typeof r.label === "string")
          .map((r) => `${r.label}: ${String(r.value || "")}`);
        setAquatechTemplateReferencesText(lines.join("\n"));
      }
    } catch {
      // Ignore invalid local template config and continue with defaults.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("aq_invoice_template_default_v1", JSON.stringify(aquatechTemplateConfig));
    } catch {
      // Non-blocking: template edits still work in-memory.
    }
  }, [aquatechTemplateConfig]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = ["1", "true", "yes"].includes((params.get("timesheet_only") || "").toLowerCase());
    const fromStorage = window.sessionStorage.getItem("aq_timesheet_only") === "1";
    if (fromQuery || fromStorage) {
      setLockToMyTimesheet(true);
      if (fromQuery) {
        // Keep this only long enough to survive the OAuth redirect.
        window.sessionStorage.setItem("aq_timesheet_only", "1");
      } else {
        // Consume one-time flag so normal root loads do not stay in timesheet mode.
        window.sessionStorage.removeItem("aq_timesheet_only");
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateViewport = () => setIsNarrowViewport(window.innerWidth <= 768);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => {
    if (!lockToMyTimesheet) return;
    if (activeView !== "time") setActiveView("time");
    if (timeSubView !== "entry") setTimeSubView("entry");
    if (!canApproveTimesheets && timeAnchorDate !== todayYmd) setTimeAnchorDate(todayYmd);
    if (timesheetSubView !== "mine") setTimesheetSubView("mine");
  }, [lockToMyTimesheet, activeView, timeSubView, timeAnchorDate, todayYmd, timesheetSubView, canApproveTimesheets]);

  useEffect(() => {
    if (!lockToMyTimesheet) {
      timesheetOnlyMobileModeSetRef.current = false;
      return;
    }
    if (!isNarrowViewport) return;
    if (timesheetOnlyMobileModeSetRef.current) return;
    timesheetOnlyMobileModeSetRef.current = true;
    setTimeViewMode("day");
  }, [lockToMyTimesheet, isNarrowViewport]);

  useEffect(() => {
    if (!lockToMyTimesheet || !isNarrowViewport) return;
    if (timeViewMode !== "day") setTimeViewMode("day");
  }, [lockToMyTimesheet, isNarrowViewport, timeViewMode]);

  useEffect(() => {
    if (!lockToMyTimesheet) return;
    const current = timesheets.find((t) => t.week_start <= todayYmd && t.week_end >= todayYmd);
    if (current) {
      const label = `${current.week_start} to ${current.week_end}`;
      if (myTimesheetPeriodFilter !== label) setMyTimesheetPeriodFilter(label);
      return;
    }
    if (!timesheetOnlyGeneratedCurrentWeek && me) {
      setTimesheetOnlyGeneratedCurrentWeek(true);
      generateTimesheet();
    }
  }, [lockToMyTimesheet, timesheets, todayYmd, myTimesheetPeriodFilter, timesheetOnlyGeneratedCurrentWeek, me]);

  useEffect(() => {
    if (!lockToMyTimesheet || !myTimesheetPeriodFilter || timeViewMode !== "week") return;
    if (canApproveTimesheets) return;
    const parsed = parseTimesheetPeriodLabel(myTimesheetPeriodFilter);
    if (!parsed) return;
    if (timeAnchorDate !== parsed.start) setTimeAnchorDate(parsed.start);
  }, [lockToMyTimesheet, myTimesheetPeriodFilter, timeViewMode, timeAnchorDate, canApproveTimesheets]);

  useEffect(() => {
    if (!lockToMyTimesheet || timeViewMode !== "week") return;
    if (canApproveTimesheets) return;
    const currentWeekLabel = `${currentRange.start} to ${currentRange.end}`;
    if (myTimesheetPeriodFilter === currentWeekLabel) return;
    if (availableMyTimesheetPeriods.includes(currentWeekLabel)) {
      setMyTimesheetPeriodFilter(currentWeekLabel);
    }
  }, [lockToMyTimesheet, timeViewMode, currentRange.start, currentRange.end, myTimesheetPeriodFilter, availableMyTimesheetPeriods, canApproveTimesheets]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("auth_status");
    const detail = params.get("auth_detail");
    if (!status) return;
    if (status === "ok") {
      setMessage("Signed in with Google.");
      refreshAuth();
      if (window.sessionStorage.getItem("aq_timesheet_only") === "1") {
        setLockToMyTimesheet(true);
        window.sessionStorage.removeItem("aq_timesheet_only");
      }
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
    canApproveTimesheets,
    lockToMyTimesheet,
    timesheetUserFilter,
    timesheetPeriodFilter,
    myTimesheetPeriodFilter,
    timeViewMode,
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
  }, [me?.id, canApproveTimesheets, lockToMyTimesheet, todayYmd, reportStart, reportEnd, timesheetStatusFilter, timesheetUserFilter, timesheetSubView]);

  useEffect(() => {
    if (!shouldLoadFinancialKpis) return;
    refreshProjectPerformance();
  }, [me?.id, shouldLoadFinancialKpis, reportStart, reportEnd]);

  useEffect(() => {
    if (!shouldLoadFinancialKpis) return;
    refreshReconciliationReport();
  }, [me?.id, shouldLoadFinancialKpis, reportStart, reportEnd]);

  useEffect(() => {
    if (!shouldLoadFinancialKpis) return;
    refreshOverallReconciliationTrend();
  }, [me?.id, shouldLoadFinancialKpis, todayYmd]);

  useEffect(() => {
    if (projectPerformance.length === 0) return;
    if (performanceProjectId && projectPerformance.some((p) => p.project_id === performanceProjectId)) return;
    setPerformanceProjectId(projectPerformance[0].project_id);
  }, [projectPerformance, performanceProjectId]);

  useEffect(() => {
    if (!shouldLoadBillingData) return;
    refreshInvoicePreview();
  }, [me?.id, shouldLoadBillingData, invoiceStart, invoiceEnd, invoiceProjectId, invoiceApprovedOnly]);

  useEffect(() => {
    if (!shouldLoadBillingData) return;
    refreshInvoices();
  }, [me?.id, shouldLoadBillingData]);

  useEffect(() => {
    if (!shouldLoadFinancialKpis) return;
    refreshUnbilledSinceLastInvoice();
  }, [me?.id, shouldLoadFinancialKpis]);

  useEffect(() => {
    if (!shouldLoadBillingData) return;
    refreshArSummary();
  }, [me?.id, shouldLoadBillingData]);

  useEffect(() => {
    if (!shouldLoadBillingData) return;
    refreshInvoiceRevenueStatus();
  }, [me?.id, shouldLoadBillingData]);

  useEffect(() => {
    if (!shouldLoadBillingData) return;
    refreshRecurringSchedules();
  }, [me?.id, shouldLoadBillingData]);

  useEffect(() => {
    if (!shouldLoadBankData) return;
    refreshBankConnections();
  }, [me?.id, shouldLoadBankData]);

  useEffect(() => {
    if (!shouldLoadBankData) return;
    refreshBankAccounts();
  }, [me?.id, shouldLoadBankData]);

  useEffect(() => {
    if (!shouldLoadBankData) return;
    refreshBankCategories();
  }, [me?.id, shouldLoadBankData]);

  useEffect(() => {
    if (!shouldLoadBankData) return;
    refreshBankSummary();
  }, [me?.id, shouldLoadBankData, bankQueueIncludePersonal, bankQueueOffset, bankQueueLimit, bankSummaryBreakdown]);

  useEffect(() => {
    if (!shouldLoadBankData) return;
    refreshBankQueue();
  }, [me?.id, shouldLoadBankData, bankQueueIncludePersonal, bankQueueOffset, bankQueueLimit]);

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
    if (activeView === "people" && peopleSubView !== "profiles" && peopleSubView !== "pending") {
      setPeopleSubView("profiles");
    }
    if (activeView === "invoices" && !["studio", "saved", "recurring", "legacy", "templates", "ar"].includes(invoiceWorkspaceTab)) {
      setInvoiceWorkspaceTab("saved");
    }
    if (activeView === "payments" && !["status", "ar"].includes(paymentWorkspaceTab)) {
      setPaymentWorkspaceTab("status");
    }
    if (activeView === "expenses" && !["costs", "reconciliation"].includes(expenseWorkspaceTab)) {
      setExpenseWorkspaceTab("costs");
    }
    if (isAccountingView && accountingSubView !== "workspace") {
      setAccountingSubView("workspace");
    }
  }, [activeView, accountingSubView, expenseWorkspaceTab, invoiceWorkspaceTab, isAccountingView, paymentWorkspaceTab, peopleSubView]);

  useEffect(() => {
    if (activeView !== "settings" || !canManageUsers) return;
    refreshAuditEvents();
  }, [activeView, canManageUsers, refreshAuditEvents]);

  useEffect(() => {
    if (!canApproveTimesheets && (timesheetSubView === "team" || timesheetSubView === "pending")) {
      setTimesheetSubView("mine");
    }
  }, [canApproveTimesheets, timesheetSubView]);

  useEffect(() => {
    if (timesheetSubView !== "pending") return;
    if (pendingAdminTimesheets.length === 0) {
      setSelectedPendingTimesheetId(null);
      return;
    }
    if (!selectedPendingTimesheetId || !pendingAdminTimesheets.some((t) => t.id === selectedPendingTimesheetId)) {
      setSelectedPendingTimesheetId(pendingAdminTimesheets[0].id);
    }
  }, [timesheetSubView, pendingAdminTimesheets, selectedPendingTimesheetId]);

  useEffect(() => {
    if (!canViewFinancials && reportsWorkspaceTab === "tax") {
      setReportsWorkspaceTab("overview");
    }
  }, [canViewFinancials, reportsWorkspaceTab]);

  useEffect(() => {
    if (reportPtdProjectOptions.length === 0) {
      setReportPtdProjectId(null);
      return;
    }
    if (reportPtdProjectId && reportPtdProjectOptions.some((p) => p.id === reportPtdProjectId)) return;
    setReportPtdProjectId(reportPtdProjectOptions[0].id);
  }, [reportPtdProjectId, reportPtdProjectOptions]);

  useEffect(() => {
    if (projects.length === 0) {
      setBankExpenseProjectId(null);
      return;
    }
    if (bankExpenseProjectId && projects.some((p) => p.id === bankExpenseProjectId)) return;
    setBankExpenseProjectId(projects[0].id);
  }, [bankExpenseProjectId, projects]);

  useEffect(() => {
    if (!message.includes("date_from_datetime_parsing")) return;
    if (isValidYmd(reportStart) && isValidYmd(reportEnd) && isValidYmd(adminEntryStart) && isValidYmd(adminEntryEnd)) {
      setMessage("");
    }
  }, [reportStart, reportEnd, adminEntryStart, adminEntryEnd, message]);

  useEffect(() => {
    if (!message) {
      setIsMessagePopupOpen(false);
      return;
    }
    setIsMessagePopupOpen(true);
  }, [message]);

  useEffect(() => {
    if (reportPreset !== "annual") return;
    const range = annualRangeForYear(reportYear);
    setReportStart(range.start);
    setReportEnd(range.end);
  }, [reportPreset, reportYear]);

  useEffect(() => {
    if (reportPreset !== "monthly") return;
    const range = monthlyRangeFor(reportYear, reportMonth);
    setReportStart(range.start);
    setReportEnd(range.end);
  }, [reportPreset, reportYear, reportMonth]);

  useEffect(() => {
    if (reportPreset !== "weekly") return;
    if (!isValidYmd(reportWeekStart)) return;
    const start = parseYmdUtc(reportWeekStart);
    const end = addDaysUtc(start, 6);
    setReportStart(formatYmdUtc(start));
    setReportEnd(formatYmdUtc(end));
  }, [reportPreset, reportWeekStart]);

  useEffect(() => {
    if (reportPreset !== "project_to_date") return;
    if (!reportPtdProjectId) return;
    const selected = projects.find((p) => p.id === reportPtdProjectId);
    if (!selected?.start_date) return;
    const endCandidate = selected.end_date && selected.end_date < todayYmd ? selected.end_date : todayYmd;
    const end = endCandidate < selected.start_date ? selected.start_date : endCandidate;
    setReportStart(selected.start_date);
    setReportEnd(end);
  }, [projects, reportPreset, reportPtdProjectId, todayYmd]);

  useEffect(() => {
    if (reportPreset !== "project_to_date") return;
    if (!reportPtdProjectId) return;
    setPerformanceProjectId(reportPtdProjectId);
  }, [reportPreset, reportPtdProjectId]);

  useEffect(() => {
    refreshProjectPerformanceRange();
  }, [me?.id, canViewFinancials, reportRangeInitialized]);

  useEffect(() => {
    refreshAdminEntryRows();
  }, [me?.id, canApproveTimesheets, adminEntryUserId, adminEntryStart, adminEntryEnd, adminEntryProjectId, adminEntryTaskId, adminEntrySubtaskId]);

  useEffect(() => {
    if (!canApproveTimesheets || !me) return;
    if (timesheetUserFilter) return;
    const hasMe = availableTimesheetUsers.some((u) => u.id === me.id);
    if (hasMe) {
      setTimesheetUserFilter(me.id);
      return;
    }
    if (availableTimesheetUsers.length > 0) {
      setTimesheetUserFilter(availableTimesheetUsers[0].id);
    }
  }, [canApproveTimesheets, me, timesheetUserFilter, availableTimesheetUsers]);

  useEffect(() => {
    if (!timesheetUserFilter) return;
    const currentWeekLabel = rangeFor("week", todayYmd).label;
    if (timesheetPeriodFilter) return;
    setTimesheetPeriodFilter(currentWeekLabel);
  }, [timesheetUserFilter, timesheetPeriodFilter, todayYmd]);

  useEffect(() => {
    if (activeView !== "timesheets" || timesheetSubView !== "mine") return;
    if (myTimesheetPeriodFilter) return;
    const currentWeekLabel = rangeFor("week", todayYmd).label;
    if (availableMyTimesheetPeriods.includes(currentWeekLabel)) {
      setMyTimesheetPeriodFilter(currentWeekLabel);
      return;
    }
    if (availableMyTimesheetPeriods.length > 0) {
      setMyTimesheetPeriodFilter(availableMyTimesheetPeriods[0]);
    }
  }, [activeView, timesheetSubView, myTimesheetPeriodFilter, availableMyTimesheetPeriods, todayYmd]);

  useEffect(() => {
    if (activeView !== "timesheets") return;
    if (timesheetSubView === "analysis") return;
    if (timeViewMode !== "week") setTimeViewMode("week");
    if (timeFilterProjectId !== null) setTimeFilterProjectId(null);
    if (timeFilterTaskId !== null) setTimeFilterTaskId(null);
    if (timeFilterSubtaskId !== null) setTimeFilterSubtaskId(null);
    const targetUserId = timesheetSubView === "team" ? timesheetUserFilter : me?.id ?? null;
    if ((targetUserId || null) !== (timeFilterUserId || null)) setTimeFilterUserId(targetUserId);
    const periodLabel = timesheetSubView === "team" ? timesheetPeriodFilter : myTimesheetPeriodFilter;
    const parsed = parseTimesheetPeriodLabel(periodLabel);
    if (parsed && timeAnchorDate !== parsed.start) setTimeAnchorDate(parsed.start);
  }, [
    activeView,
    timesheetSubView,
    timeViewMode,
    timeFilterProjectId,
    timeFilterTaskId,
    timeFilterSubtaskId,
    timeFilterUserId,
    timesheetUserFilter,
    timesheetPeriodFilter,
    myTimesheetPeriodFilter,
    me?.id,
    timeAnchorDate,
  ]);

  useEffect(() => {
    if (!lockToMyTimesheet || !canApproveTimesheets) return;
    if (!timesheetUserFilter) return;
    if (timeFilterUserId === timesheetUserFilter) return;
    setTimeFilterUserId(timesheetUserFilter);
  }, [lockToMyTimesheet, canApproveTimesheets, timesheetUserFilter, timeFilterUserId]);

  useEffect(() => {
    if (!lockToMyTimesheet) return;
    if (timeFilterProjectId !== null) setTimeFilterProjectId(null);
    if (timeFilterTaskId !== null) setTimeFilterTaskId(null);
    if (timeFilterSubtaskId !== null) setTimeFilterSubtaskId(null);
  }, [lockToMyTimesheet, timeFilterProjectId, timeFilterTaskId, timeFilterSubtaskId]);

  useEffect(() => {
    if (!lockToMyTimesheet || !canApproveTimesheets || timeViewMode !== "week") return;
    if (!timesheetPeriodFilter) return;
    const parsed = parseTimesheetPeriodLabel(timesheetPeriodFilter);
    if (!parsed) return;
    if (timeAnchorDate !== parsed.start) setTimeAnchorDate(parsed.start);
  }, [lockToMyTimesheet, canApproveTimesheets, timeViewMode, timesheetPeriodFilter, timeAnchorDate]);

  useEffect(() => {
    if (!canApproveTimesheets || !timesheetUserFilter || !timesheetPeriodFilter) return;
    if (selectedAdminTimesheets.length > 0) return;
    const parsed = parseTimesheetPeriodLabel(timesheetPeriodFilter);
    if (!parsed) return;
    const key = `${timesheetUserFilter}|${parsed.start}`;
    if (ensuredTimesheetKeysRef.current.has(key)) return;
    ensuredTimesheetKeysRef.current.add(key);
    (async () => {
      try {
        await apiPost(`/timesheets/ensure?user_id=${timesheetUserFilter}&week_start=${parsed.start}`, {});
        await Promise.all([refreshAdminTimesheets(), refreshData()]);
      } catch (err) {
        ensuredTimesheetKeysRef.current.delete(key);
        setMessage(String(err));
      }
    })();
  }, [canApproveTimesheets, timesheetUserFilter, timesheetPeriodFilter, selectedAdminTimesheets.length]);

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
    if (lockToMyTimesheet && typeof window !== "undefined") {
      window.sessionStorage.setItem("aq_timesheet_only", "1");
    }
    window.location.href = `${API_BASE}/auth/google/login`;
  }

  async function handleLogout() {
    await apiPost<{ ok: boolean }>("/auth/logout");
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("aq_timesheet_only");
    }
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
      if (!projectStartDate || !projectEndDate) {
        setMessage("Project start date and target end date are required.");
        return;
      }
      if (projectStartDate && projectEndDate && projectEndDate < projectStartDate) {
        setMessage("Project target end date cannot be before start date.");
        return;
      }
      if (overallBudget <= 0) {
        setMessage("Overall budget must be greater than 0 for new active projects.");
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
        end_date: projectEndDate || null,
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
      end_date: string;
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
        end_date: prev[projectId]?.end_date || "",
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
      if (d.is_active && (!d.start_date || !d.end_date)) {
        setMessage("Active projects require both start date and target end date.");
        return;
      }
      if (d.is_active && overallBudget <= 0) {
        setMessage("Active projects require overall budget greater than 0.");
        return;
      }
      if (overallBudget < subtaskBudgetSum) {
        setMessage(`Overall budget fee cannot be lower than WBS subtotal (${subtaskBudgetSum.toFixed(2)}).`);
        return;
      }
      if (d.start_date && d.end_date && d.end_date < d.start_date) {
        setMessage("Project target end date cannot be before start date.");
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
        end_date: d.end_date || null,
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
    if (isSavingTimeEntry) return;
    if (!isOwnTimeEntryContext) {
      setMessage("You can only save entries in your own timesheet context. Switch to My Timesheet and try again.");
      return;
    }
    const missing: string[] = [];
    if (!entryDate) missing.push("date");
    if (!entryProjectId) missing.push("project");
    if (!entryTaskId) missing.push("task");
    if (!entrySubtaskId) missing.push("sub-task (or choose 'No Sub-Task')");
    if (Number(entryHours) <= 0) missing.push("hours greater than 0");
    if (missing.length > 0) {
      setMessage(
        `Cannot save timesheet entry yet.\nPlease provide: ${missing.join(", ")}.\nTip: choose 'No Sub-Task' when your entry has no specific sub-task.`,
      );
      return;
    }
    try {
      setIsSavingTimeEntry(true);
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
    } finally {
      setIsSavingTimeEntry(false);
    }
  }

  function fillEntryToEightHours() {
    if (editingEntryId) return;
    const remaining = Math.max(0, 8 - Number(selectedDayTotalHours || 0));
    setEntryHours(remaining > 0 ? remaining.toFixed(2) : "0");
  }

  async function copyPreviousDayEntries() {
    if (!entryDate) return;
    if (!isOwnTimeEntryContext) {
      setMessage("Switch to your own timesheet context to copy entries.");
      return;
    }
    const prevDay = formatYmdUtc(addDaysUtc(parseYmdUtc(entryDate), -1));
    const sourceRows = timeEntries.filter((t) => t.work_date === prevDay);
    if (sourceRows.length === 0) {
      setMessage(`No entries found on ${prevDay} to copy.`);
      return;
    }
    try {
      for (const row of sourceRows) {
        await apiPost("/time-entries", {
          project_id: row.project_id,
          task_id: row.task_id,
          subtask_id: row.subtask_id,
          work_date: entryDate,
          hours: Number(row.hours || 0),
          note: row.note || "Copied from previous day",
        });
      }
      setMessage(`Copied ${sourceRows.length} entr${sourceRows.length === 1 ? "y" : "ies"} from ${prevDay} to ${entryDate}.`);
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

  async function submitTimesheetForEmployee(id: number) {
    try {
      await apiPost(`/timesheets/${id}/submit-admin`);
      setMessage("Timesheet submitted for employee.");
      refreshData();
      refreshAdminTimesheets();
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

  async function returnTimesheet(id: number) {
    try {
      await apiPost(`/timesheets/${id}/return`);
      setMessage("Timesheet returned.");
      refreshData();
      refreshAdminTimesheets();
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
    if (preset === "project_to_date") {
      const selected = projects.find((p) => p.id === reportPtdProjectId) || projects.find((p) => !!p.start_date) || null;
      if (!selected?.start_date) {
        setMessage("Select a project with a start date to use Project-to-Date metrics.");
        return;
      }
      setReportPtdProjectId(selected.id);
      const endCandidate = selected.end_date && selected.end_date < todayYmd ? selected.end_date : todayYmd;
      const end = endCandidate < selected.start_date ? selected.start_date : endCandidate;
      setReportStart(selected.start_date);
      setReportEnd(end);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const range = presetRange(preset, today);
    if (preset === "annual") setReportYear(parseYmdUtc(range.start).getUTCFullYear());
    if (preset === "monthly") {
      const d = parseYmdUtc(range.start);
      setReportYear(d.getUTCFullYear());
      setReportMonth(d.getUTCMonth() + 1);
    }
    if (preset === "weekly") setReportWeekStart(range.start);
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

  function selectFreshbooksTimeCsvFromTopbar() {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".csv,text/csv";
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) return;
      setImportFile(file);
      setImportApply(false);
      setActiveView("expenses");
      setAccountingSubView("workspace");
      setExpenseWorkspaceTab("reconciliation");
      setMessage(`Timesheet CSV selected: ${file.name}. Review settings and run FreshBooks preview/apply.`);
    };
    picker.click();
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
    if (!invoiceProjectId) {
      setMessage("Select a single project before creating an invoice.");
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
      setInvoiceTemplateById((prev) => ({ ...prev, [payload.id]: invoiceDraftTemplateId }));
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

  async function downloadInvoicePdf(inv: InvoiceRecord, templateId: InvoiceTemplateId = "default") {
    const win = window.open("", "_blank");
    if (!win) {
      setMessage("Pop-up blocked. Allow pop-ups to download PDF.");
      return;
    }
    const template = invoiceTemplateMeta(inv, templateId, aquatechTemplateConfig);
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
    const displayStatus = titleCaseWord(effectiveInvoiceStatus(inv, todayYmd));
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
.hl td{border:2px solid #c97c3d;background:#fff2e8}
.sig{margin-top:10px;font-size:12px}
</style></head><body>
<div class="meta">Place Company Letterhead Here</div>
<div class="meta"><strong>Aquatech Engineering P.C.</strong><br/>15 Bonita Vista Road<br/>Mount Vernon, NY 10552</div>
<div class="top">
  <div><img src="/Aqt_Logo.png" style="width:170px" /></div>
  <div><h1>Invoice</h1><div class="meta">No: ${escapeHtml(inv.invoice_number)}<br/>Issued: ${escapeHtml(inv.issue_date)}<br/>Status: ${escapeHtml(displayStatus)}<br/>Template: ${escapeHtml(template.label)}</div></div>
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
  Balance: ${formatCurrency(invoiceOutstandingBalance(inv))}
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

  async function runFreshbooksInvoiceLikeImport(params: {
    file: File;
    apply: boolean;
    mappingJson: string;
    successMessage: string;
    previewMessage: string;
    setSummary: (summary: string) => void;
  }) {
    try {
      const form = new FormData();
      form.append("file", params.file);
      form.append("mapping_overrides", params.mappingJson);
      const res = await fetch(`${API_BASE}/invoices/import/freshbooks?apply=${params.apply ? "true" : "false"}`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as LegacyInvoiceImportResult;
      const extras: string[] = [];
      if (payload.line_item_mode) extras.push("line-item aggregation detected");
      if ((payload.payment_rows || 0) > 0) extras.push(`payment rows: ${payload.payment_rows}`);
      if ((payload.payments_matched_invoices || 0) > 0) extras.push(`payments matched invoices: ${payload.payments_matched_invoices}`);
      params.setSummary(
        `Rows: ${payload.count} | Imported: ${payload.imported} | Updated: ${payload.updated} | Errors: ${payload.errors}${extras.length ? ` | ${extras.join(" | ")}` : ""}`,
      );
      setMessage(params.apply ? params.successMessage : params.previewMessage);
      if (params.apply) {
        refreshInvoices();
        refreshArSummary();
      }
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function runLegacyInvoiceImport() {
    if (!legacyInvoiceFile) {
      setMessage("Select a FreshBooks invoice CSV file first.");
      return;
    }
    await runFreshbooksInvoiceLikeImport({
      file: legacyInvoiceFile,
      apply: legacyInvoiceApply,
      mappingJson: legacyInvoiceMappingJson,
      successMessage: "Legacy invoices imported.",
      previewMessage: "Legacy invoice import preview ready.",
      setSummary: setLegacyInvoiceSummary,
    });
  }

  async function reconcileLegacyImportedClients() {
    if (!canManageProjects) {
      setMessage("You do not have permission to reconcile client labels.");
      return;
    }
    const canonical = (invoiceClientReconcileName || suggestedReconcileClient || "").trim();
    if (!canonical) {
      setMessage("Enter the real client name to reconcile Imported/Legacy clients.");
      return;
    }
    try {
      const res = await apiPost<InvoiceClientReconcileResult>("/invoices/reconcile-client-labels", {
        canonical_client_name: canonical,
        aliases: ["Imported Client", "Legacy Client"],
      });
      setInvoiceClientReconcileName(res.canonical_client_name);
      setMessage(
        `Reconciled to \"${res.canonical_client_name}\". Invoices updated: ${res.invoices_updated}, projects updated: ${res.projects_updated}.`,
      );
      refreshInvoices();
      refreshData();
      refreshUnbilledSinceLastInvoice();
      refreshArSummary();
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function runFreshbooksPaymentImport() {
    if (!paymentImportFile) {
      setMessage("Select a FreshBooks payments CSV file first.");
      return;
    }
    try {
      const form = new FormData();
      form.append("file", paymentImportFile);
      form.append("mapping_overrides", paymentImportMappingJson);
      const res = await fetch(`${API_BASE}/invoices/import/freshbooks-payments?apply=${paymentImportApply ? "true" : "false"}`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as LegacyPaymentImportResult;
      setPaymentImportSummary(
        `Rows: ${payload.count} | Matched: ${payload.matched} | Updated: ${payload.updated} | Unmatched: ${payload.unmatched} | Errors: ${payload.errors}`,
      );
      setMessage(paymentImportApply ? "FreshBooks payments imported." : "FreshBooks payments preview ready.");
      if (paymentImportApply) {
        refreshInvoices();
        refreshArSummary();
        refreshInvoiceRevenueStatus();
      }
    } catch (err) {
      setMessage(String(err));
    }
  }

  function selectFreshbooksInvoiceCsvFromTopbar() {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".csv,text/csv";
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) return;
      setLegacyInvoiceFile(file);
      setLegacyInvoiceApply(false);
      setActiveView("invoices");
      setAccountingSubView("workspace");
      setInvoiceWorkspaceTab("legacy");
      setMessage(`Invoice CSV selected: ${file.name}. Review mapping and run legacy preview/apply.`);
    };
    picker.click();
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
    <main style={{ margin: 0, maxWidth: "none", padding: 0 }}>
      {!me && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, margin: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img src="/Aqt_Logo.png" alt="Aquatech Engineering P.C." style={{ width: 240, height: "auto" }} />
            <div>
              <h1 style={{ margin: 0, fontSize: 34, lineHeight: 1.05, letterSpacing: "0.3px" }}>Project Controls Dashboard</h1>
              <p style={{ margin: "4px 0 0 0", color: "#2f4860" }}>Projects, staffing, time, and margin intelligence</p>
            </div>
          </div>
        </div>
      )}
      {message && isMessagePopupOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 3000,
            padding: 16,
          }}
        >
          <div
            role="alertdialog"
            aria-live="assertive"
            style={{
              width: "min(680px, 96vw)",
              background: "#fff",
              borderRadius: 10,
              border: `1px solid ${messageIsError ? "#e2b8ae" : "#c8d7ea"}`,
              boxShadow: "0 12px 36px rgba(0,0,0,0.28)",
              padding: 16,
            }}
          >
            <h3 style={{ margin: "0 0 8px 0", color: messageIsError ? "#8a3a2a" : "#1d4064" }}>
              {messageIsError ? "Action Needed" : "Notice"}
            </h3>
            <div style={{ whiteSpace: "pre-wrap", color: "#23384e", marginBottom: 12 }}>{message}</div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setIsMessagePopupOpen(false);
                  setMessage("");
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

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
              <p style={{ marginTop: 0, color: "#2f4860" }}>
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
        <div className={`aq-shell ${lockToMyTimesheet ? "aq-shell-timesheet-only" : ""}`}>
          {!lockToMyTimesheet && <aside className="aq-nav-shell">
            <div className="aq-org-head">
              <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>Aquatech Engineering P.C.</div>
              <div style={{ fontSize: 12, opacity: 0.9 }}>{me.role}</div>
            </div>
            <div className="aq-nav-group-title">Overview</div>
            <div className="aq-nav-group">
              <button
                className={`aq-nav-item ${activeView === "dashboard" ? "active" : ""}`}
                onClick={() => {
                  setActiveView("dashboard");
                  setDashboardSubView("overview");
                }}
              >
                Dashboard
              </button>
              {activeView === "dashboard" && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${dashboardSubView === "overview" ? "active" : ""}`} onClick={() => setDashboardSubView("overview")}>Overview</button>
                  <button className={`aq-sub-item ${dashboardSubView === "controls" ? "active" : ""}`} onClick={() => setDashboardSubView("controls")}>Project Control Board</button>
                </div>
              )}
            </div>
            <div className="aq-nav-group-title">People</div>
            <div className="aq-nav-group">
              <button
                className={`aq-nav-item ${activeView === "clients" ? "active" : ""}`}
                onClick={() => {
                  setActiveView("clients");
                }}
              >
                Clients
              </button>
              <button
                className={`aq-nav-item ${activeView === "people" ? "active" : ""}`}
                onClick={() => {
                  setActiveView("people");
                  setPeopleSubView("profiles");
                }}
              >
                Employees
              </button>
              {activeView === "people" && canManageUsers && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${peopleSubView === "profiles" ? "active" : ""}`} onClick={() => setPeopleSubView("profiles")}>Employee Profiles</button>
                  <button className={`aq-sub-item ${peopleSubView === "pending" ? "active" : ""}`} onClick={() => setPeopleSubView("pending")}>Pending Activation</button>
                </div>
              )}
            </div>
            {canViewFinancials && (
              <>
                <div className="aq-nav-group-title">Financials</div>
                <div className="aq-nav-group">
                  <button
                    className={`aq-nav-item ${activeView === "estimates" ? "active" : ""}`}
                    onClick={openEstimates}
                  >
                    Estimates
                  </button>
                  <button
                    className={`aq-nav-item ${activeView === "invoices" ? "active" : ""}`}
                    onClick={() => {
                      setActiveView("invoices");
                      setAccountingSubView("workspace");
                      setInvoiceWorkspaceTab("saved");
                    }}
                  >
                    Invoices
                  </button>
                  {activeView === "invoices" && (
                    <div className="aq-submenu">
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "studio" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("studio")}>Invoice Studio</button>
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "templates" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("templates")}>Invoice Templates</button>
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "legacy" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("legacy")}>Legacy FreshBooks</button>
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "ar" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("ar")}>Accounts Receivable</button>
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "saved" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("saved")}>Saved Invoices</button>
                      <button className={`aq-sub-item ${invoiceWorkspaceTab === "recurring" ? "active" : ""}`} onClick={() => setInvoiceWorkspaceTab("recurring")}>Recurring</button>
                    </div>
                  )}
                  <button
                    className={`aq-nav-item ${activeView === "payments" ? "active" : ""}`}
                    onClick={() => {
                      setActiveView("payments");
                      setAccountingSubView("workspace");
                      setPaymentWorkspaceTab("status");
                    }}
                  >
                    Payments
                  </button>
                  {activeView === "payments" && (
                    <div className="aq-submenu">
                      <button className={`aq-sub-item ${paymentWorkspaceTab === "status" ? "active" : ""}`} onClick={() => setPaymentWorkspaceTab("status")}>Payment Status</button>
                      <button className={`aq-sub-item ${paymentWorkspaceTab === "ar" ? "active" : ""}`} onClick={() => setPaymentWorkspaceTab("ar")}>A/R Aging</button>
                    </div>
                  )}
                  <button
                    className={`aq-nav-item ${activeView === "expenses" ? "active" : ""}`}
                    onClick={() => {
                      setActiveView("expenses");
                      setAccountingSubView("workspace");
                      setExpenseWorkspaceTab("costs");
                    }}
                  >
                    Expenses
                  </button>
                  {activeView === "expenses" && (
                    <div className="aq-submenu">
                      <button className={`aq-sub-item ${expenseWorkspaceTab === "costs" ? "active" : ""}`} onClick={() => setExpenseWorkspaceTab("costs")}>Cost Controls</button>
                      <button className={`aq-sub-item ${expenseWorkspaceTab === "reconciliation" ? "active" : ""}`} onClick={() => setExpenseWorkspaceTab("reconciliation")}>Reconciliation</button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="aq-nav-group-title">Execution</div>
            <div className="aq-nav-group">
              <button
                className={`aq-nav-item ${activeView === "projects" ? "active" : ""}`}
                onClick={() => {
                  setActiveView("projects");
                  setProjectSubView("cockpit");
                }}
              >
                Projects
              </button>
              {activeView === "projects" && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${projectSubView === "cockpit" ? "active" : ""}`} onClick={() => setProjectSubView("cockpit")}>Project Cockpit</button>
                  <button className={`aq-sub-item ${projectSubView === "editor" ? "active" : ""}`} onClick={() => setProjectSubView("editor")}>Project Editor</button>
                  {canManageProjects && <button className={`aq-sub-item ${projectSubView === "setup" ? "active" : ""}`} onClick={() => setProjectSubView("setup")}>Create Project</button>}
                  {canViewFinancials && <button className={`aq-sub-item ${projectSubView === "performance" ? "active" : ""}`} onClick={() => setProjectSubView("performance")}>Performance</button>}
                </div>
              )}
              <button
                className={`aq-nav-item ${activeView === "time" ? "active" : ""}`}
                onClick={() => {
                  setEntryDate(null);
                  setEditingEntryId(null);
                  setActiveView("time");
                  setTimeSubView("entry");
                }}
              >
                Time Tracking
              </button>
              {activeView === "time" && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${timeSubView === "entry" ? "active" : ""}`} onClick={() => setTimeSubView("entry")}>Log Time</button>
                </div>
              )}
              <button
                className={`aq-nav-item ${activeView === "timesheets" ? "active" : ""}`}
                onClick={() => {
                  setActiveView("timesheets");
                  setTimesheetSubView("mine");
                }}
              >
                Timesheets
              </button>
              {activeView === "timesheets" && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${timesheetSubView === "mine" ? "active" : ""}`} onClick={() => setTimesheetSubView("mine")}>My Timesheet</button>
                  {canApproveTimesheets && <button className={`aq-sub-item ${timesheetSubView === "team" ? "active" : ""}`} onClick={() => setTimesheetSubView("team")}>Team Review</button>}
                  {canApproveTimesheets && <button className={`aq-sub-item ${timesheetSubView === "pending" ? "active" : ""}`} onClick={() => setTimesheetSubView("pending")}>Pending Queue</button>}
                  <button className={`aq-sub-item ${timesheetSubView === "analysis" ? "active" : ""}`} onClick={() => setTimesheetSubView("analysis")}>Analysis</button>
                </div>
              )}
            </div>
            {canViewOperations && (
              <>
                <div className="aq-nav-group-title">Operations</div>
                <div className="aq-nav-group">
                  <button
                    className={`aq-nav-item ${activeView === "payroll" ? "active" : ""}`}
                    onClick={openPayroll}
                  >
                    Payroll
                  </button>
                  {canViewFinancials && (
                    <>
                      <button
                        className={`aq-nav-item ${activeView === "accounting" ? "active" : ""}`}
                        onClick={openAccountingWorkspace}
                      >
                        Accounting
                      </button>
                      {activeView === "accounting" && (
                        <div className="aq-submenu">
                          <button className={`aq-sub-item ${accountingSubView === "workspace" ? "active" : ""}`} onClick={() => setAccountingSubView("workspace")}>Workspace</button>
                        </div>
                      )}
                      <button
                        className={`aq-nav-item ${activeView === "reports" ? "active" : ""}`}
                        onClick={() => {
                          setActiveView("reports");
                          setReportsWorkspaceTab("overview");
                        }}
                      >
                        Reports
                      </button>
                      {activeView === "reports" && (
                        <div className="aq-submenu">
                          <button className={`aq-sub-item ${reportsWorkspaceTab === "overview" ? "active" : ""}`} onClick={() => setReportsWorkspaceTab("overview")}>Overview</button>
                          <button className={`aq-sub-item ${reportsWorkspaceTab === "project" ? "active" : ""}`} onClick={() => setReportsWorkspaceTab("project")}>Project</button>
                          <button className={`aq-sub-item ${reportsWorkspaceTab === "timesheets" ? "active" : ""}`} onClick={() => setReportsWorkspaceTab("timesheets")}>Timesheets</button>
                          <button className={`aq-sub-item ${reportsWorkspaceTab === "financial" ? "active" : ""}`} onClick={() => setReportsWorkspaceTab("financial")}>Financial</button>
                          <button className={`aq-sub-item ${reportsWorkspaceTab === "tax" ? "active" : ""}`} onClick={() => setReportsWorkspaceTab("tax")}>Tax Prep</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
            <div className="aq-nav-footer">
              <button className="aq-sub-item" onClick={openSettings}>Settings</button>
              {activeView === "settings" && (
                <div className="aq-submenu">
                  <button className={`aq-sub-item ${settingsSubView === "workspace" ? "active" : ""}`} onClick={openSettings}>Workspace</button>
                  <button className={`aq-sub-item ${settingsSubView === "bank_connections" ? "active" : ""}`} onClick={openSettingsBankConnections}>Bank Connections</button>
                  <button className={`aq-sub-item ${settingsSubView === "bank_transactions" ? "active" : ""}`} onClick={openSettingsBankTransactions}>Bank Transactions</button>
                  {canViewFinancials && <button className={`aq-sub-item ${settingsSubView === "expense_mix" ? "active" : ""}`} onClick={openSettingsExpenseMix}>Expense Mix</button>}
                </div>
              )}
              <button className="aq-sub-item" onClick={openDashboardHome}>Home</button>
            </div>
          </aside>}
          <div className="aq-main-pane">
          <div className="aq-topbar">
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#a86735", lineHeight: 1.1 }}>{workspaceTitle}</div>
              <div style={{ fontSize: 12, color: "#4a6076" }}>
                {workspaceHint} | Last sync: <strong>{lastSyncAt || "-"}</strong>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={refreshCurrentWorkspace} disabled={isRefreshingWorkspace}>
                {isRefreshingWorkspace ? "Refreshing..." : "Refresh Current View"}
              </button>
              {showTopbarImportButtons && (
                <>
                  <button onClick={selectFreshbooksTimeCsvFromTopbar}>Upload Timesheet CSV</button>
                  <button onClick={selectFreshbooksInvoiceCsvFromTopbar}>Upload Invoice CSV</button>
                  {showEmergencyCsvImport && (
                    <button onClick={() => selectExpenseCatCategorizedCsv(true)}>Import Expense_CAT CSV</button>
                  )}
                </>
              )}
              {!lockToMyTimesheet && <button onClick={handlePrimaryAction}>{primaryActionLabel}</button>}
              <button onClick={handleLogout}>Logout</button>
            </div>
          </div>
          {activeView === "dashboard" && dashboardSubView === "overview" && (
            <section style={{ border: "1px solid #d1dbe6", borderRadius: 10, padding: 16, marginBottom: 16, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.1, color: "#a86735" }}>Executive Overview</h2>
              </div>
              <p style={{ marginTop: 8, color: "#4a4a4a", fontSize: 13 }}>
                Reporting context: <strong>{dashboardKpiContextLabel}</strong>
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
                <div style={{ display: "grid", gap: 12 }}>
                  <div className="aq-dashboard-section" style={{ marginTop: 8 }}>
                    <h3 className="aq-dashboard-section-title">Company Overall Status</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(120px, 1fr))", gap: 8, fontSize: 12 }}>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Total Contracted Budget<br />
                        <strong><Currency value={companyOverallSummary.totalContractedBudget} digits={0} /></strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Spent to Date<br />
                        <strong><Currency value={companyOverallSummary.totalSpentToDate} digits={0} /></strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Amount Remaining<br />
                        <strong><Currency value={companyOverallSummary.amountRemaining} digits={0} /></strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Gross Margin<br />
                        <strong>
                          {`${companyOverallSummary.overallGrossMargin.toFixed(1)}%`}
                        </strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Total Revenue<br />
                        <strong><Currency value={companyOverallSummary.totalRevenue} digits={0} /></strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Total Cost<br />
                        <strong><Currency value={companyOverallSummary.totalCost} digits={0} /></strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Completed Projects<br />
                        <strong>{companyOverallSummary.completedProjectsQty}</strong>
                      </div>
                      <div style={{ border: "1px solid #eee", padding: 8, borderRadius: 8 }}>
                        Completed Projects Budget<br />
                        <strong><Currency value={companyOverallSummary.completedProjectsBudget} digits={0} /></strong>
                      </div>
                    </div>
                  </div>
                  <DashboardDataQualityPanel
                    healthLabel={dashboardDataQuality.healthLabel}
                    openCount={dashboardDataQuality.openCount}
                    issues={dashboardDataQuality.issues}
                    onIssueClick={openDataQualityIssue}
                  />
                  <div className="aq-dashboard-section">
                    <h3 className="aq-dashboard-section-title">Project KPI Status</h3>
                    <ReportPeriodControls
                      keyPrefix="overview"
                      reportPreset={reportPreset}
                      applyReportPreset={applyReportPreset}
                      reportYear={reportYear}
                      setReportYear={setReportYear}
                      reportYearOptions={reportYearOptions}
                      reportMonth={reportMonth}
                      setReportMonth={setReportMonth}
                      reportWeekStart={reportWeekStart}
                      setReportWeekStart={setReportWeekStart}
                      reportWeekOptions={reportWeekOptions}
                      reportPtdProjectId={reportPtdProjectId}
                      setReportPtdProjectId={setReportPtdProjectId}
                      reportPtdProjectOptions={reportPtdProjectOptions}
                      reportStart={reportStart}
                      setReportStart={setReportStart}
                      reportEnd={reportEnd}
                      setReportEnd={setReportEnd}
                      showNativeDatePicker={showNativeDatePicker}
                      containerStyle={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px 0" }}
                    />
                    <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: "#4a6076" }}>
                      Click any project row to open full control-board detail.
                    </p>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                      <button onClick={() => setDashboardSubView("controls")}>Open Project Control Board</button>
                    </div>
                    <div style={{ overflowX: "auto", border: "1px solid #d8e2ed", borderRadius: 10, background: "#ffffff", boxShadow: "0 6px 20px rgba(17, 32, 24, 0.06)" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                        <thead style={{ background: "#f3f7fb" }}>
                          <tr>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8, fontWeight: 600 }}>Project</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Total Budget (Fixed)</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Earned Revenue (Selected)</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Earned Revenue (Life)</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Earned Not Billed</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Unearned Budget Remaining</th>
                            <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8, fontWeight: 600 }}>Gross Margin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dashboardOverviewRows.map((p) => {
                            const meetsMargin = Number(p.margin_pct || 0) >= Number(p.target_gross_margin_pct || 0);
                            return (
                              <tr
                                key={`dash-overview-${p.project_id}`}
                                onClick={() => {
                                  setPerformanceProjectId(p.project_id);
                                  setDashboardSubView("controls");
                                }}
                                style={{ cursor: "pointer", background: meetsMargin ? "#edf9f1" : "#fdeeee" }}
                              >
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, fontWeight: 600 }}>{p.project_name}</td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.totalBudget} digits={0} /></td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.revenueSelectedPeriod} digits={0} /></td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.revenueLifeToDate} digits={0} /></td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.earnedButUnbilled} digits={0} /></td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.unearnedBudgetRemaining} digits={0} /></td>
                                <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right", fontWeight: 700 }}>
                                  {p.margin_pct.toFixed(1)}% / {p.target_gross_margin_pct.toFixed(1)}%
                                </td>
                              </tr>
                            );
                          })}
                          {dashboardOverviewRows.length === 0 && (
                            <tr><td colSpan={7} style={{ padding: 10, color: "#4a6076" }}>No project KPI rows in this period.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 12 }}>
                  <div className="aq-dashboard-section" style={{ marginTop: 8 }}>
                    <h3 className="aq-dashboard-section-title">Invoice & Revenue Status</h3>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
                      <div style={{ border: "1px solid #d6e3f1", borderRadius: 8, padding: 10, background: "#f3f8fe" }}>
                        <div style={{ fontSize: 12, color: "#4a6076" }}>Earned Revenue (Life)</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#1f3f60" }}>
                          <Currency value={dashboardRevenueStatusTotals.earnedRevenueLife} digits={0} />
                        </div>
                      </div>
                      <div style={{ border: "1px solid #f1dcc2", borderRadius: 8, padding: 10, background: "#fff8ef" }}>
                        <div style={{ fontSize: 12, color: "#4a6076" }}>Earned Not Billed</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#7a4a1f" }}>
                          <Currency value={dashboardRevenueStatusTotals.earnedNotBilled} digits={0} />
                        </div>
                      </div>
                      <div style={{ border: "1px solid #dbe6d5", borderRadius: 8, padding: 10, background: "#f6fbf4" }}>
                        <div style={{ fontSize: 12, color: "#4a6076" }}>Unearned Budget Remaining</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: "#2f5b2f" }}>
                          <Currency value={dashboardRevenueStatusTotals.unearnedBudgetRemaining} digits={0} />
                        </div>
                      </div>
                    </div>
                    <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: "#4a6076" }}>Invoice Paid To Date</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: "#1f3f60" }}>
                        <Currency value={paidToDateDisplay} digits={0} />
                      </div>
                    </div>
                    <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 12, color: "#4a6076", marginBottom: 6 }}>Invoices Outstanding By Age</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(80px, 1fr))", gap: 6, fontSize: 12 }}>
                        <div style={{ border: "1px solid #edf2f7", borderRadius: 8, padding: 6 }}>Current<br /><strong><Currency value={effectiveArSummary.aging.current} /></strong></div>
                        <div style={{ border: "1px solid #edf2f7", borderRadius: 8, padding: 6 }}>1-30<br /><strong><Currency value={effectiveArSummary.aging["1_30"]} /></strong></div>
                        <div style={{ border: "1px solid #edf2f7", borderRadius: 8, padding: 6 }}>31-60<br /><strong><Currency value={effectiveArSummary.aging["31_60"]} /></strong></div>
                        <div style={{ border: "1px solid #edf2f7", borderRadius: 8, padding: 6 }}>61-90<br /><strong><Currency value={effectiveArSummary.aging["61_90"]} /></strong></div>
                        <div style={{ border: "1px solid #edf2f7", borderRadius: 8, padding: 6 }}>90+<br /><strong><Currency value={effectiveArSummary.aging["90_plus"]} /></strong></div>
                      </div>
                    </div>
                    <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 10 }}>
                      <div style={{ fontSize: 12, color: "#4a6076", marginBottom: 6 }}>
                        Work Performed & Unbilled (Client / Project) <strong style={{ color: "#1f3f60" }}>(Total: <Currency value={dashboardUnbilledByClient.total} />)</strong>
                      </div>
                      <div style={{ fontSize: 11, color: "#607689", marginBottom: 6 }}>
                        Billable work since each project's last invoice date, shown by client and project.
                      </div>
                      <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #edf2f7", borderRadius: 8 }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                          <thead style={{ background: "#f7fafc" }}>
                            <tr>
                              <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #edf2f7" }}>Client</th>
                              <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #edf2f7" }}>Project</th>
                              <th style={{ textAlign: "right", padding: 6, borderBottom: "1px solid #edf2f7" }}>Work Hours</th>
                              <th style={{ textAlign: "right", padding: 6, borderBottom: "1px solid #edf2f7" }}>Unbilled</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dashboardUnbilledByClientProject.slice(0, 14).map((row) => (
                              <tr key={`dash-unbilled-project-${row.client}-${row.project}`}>
                                <td style={{ borderBottom: "1px solid #edf2f7", padding: 6 }}>{row.client}</td>
                                <td style={{ borderBottom: "1px solid #edf2f7", padding: 6 }}>{row.project}</td>
                                <td style={{ borderBottom: "1px solid #edf2f7", padding: 6, textAlign: "right" }}>{row.hours.toFixed(2)}</td>
                                <td style={{ borderBottom: "1px solid #edf2f7", padding: 6, textAlign: "right" }}><Currency value={row.amount} /></td>
                              </tr>
                            ))}
                            {dashboardUnbilledByClientProject.length === 0 && (
                              <tr><td colSpan={4} style={{ padding: 8, color: "#4a6076" }}>No unbilled project rows in current data.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                  <div className="aq-dashboard-section" style={{ marginTop: 8 }}>
                    <h3 className="aq-dashboard-section-title">Revenue And Cost Trend</h3>
                    <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <button onClick={() => setDashboardChartScale("amount")} disabled={dashboardChartScale === "amount"}>
                        $ Amount
                      </button>
                      <button onClick={() => setDashboardChartScale("pct_budget")} disabled={dashboardChartScale === "pct_budget"}>
                        % Budget
                      </button>
                      <button onClick={() => setDashboardTrendChartType("bar")} disabled={dashboardTrendChartType === "bar"}>
                        Bar
                      </button>
                      <button onClick={() => setDashboardTrendChartType("line")} disabled={dashboardTrendChartType === "line"}>
                        Line
                      </button>
                      <button onClick={() => setDashboardTrendWindowMonths(6)} disabled={dashboardTrendWindowMonths === 6}>
                        6 Months
                      </button>
                      <button onClick={() => setDashboardTrendWindowMonths(12)} disabled={dashboardTrendWindowMonths === 12}>
                        1 Year
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "56px 1fr", gap: 8, alignItems: "end" }}>
                      <div style={{ display: "grid", height: 170, alignItems: "stretch", fontSize: 11, fontWeight: 700, color: "#445b72", textAlign: "right" }}>
                        {[1, 0.75, 0.5, 0.25, 0].map((ratio) => {
                          const value = dashboardMonthlyTrend.maxValue * ratio;
                          const label = dashboardChartScale === "amount" ? `$${Math.round(value / 1000)}K` : `${value.toFixed(0)}%`;
                          return <div key={`dash-over-y-${ratio}`}>{label}</div>;
                        })}
                      </div>
                      {dashboardTrendChartType === "bar" ? (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(52px, 1fr))", gap: 8, alignItems: "end", minHeight: 170 }}>
                          {dashboardMonthlyTrend.rows.map((row) => {
                            const revenueValue = dashboardChartScale === "amount" ? row.revenue : row.revenuePctBudget;
                            const costValue = dashboardChartScale === "amount" ? row.cost : row.costPctBudget;
                            const periodYear = Number(row.period.slice(0, 4));
                            const periodMonth = Number(row.period.slice(5, 7));
                            const monthLabel = new Date(Date.UTC(periodYear, periodMonth - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
                            return (
                              <div key={`dash-over-month-${row.period}`} style={{ display: "grid", gap: 4, justifyItems: "center" }}>
                                <div style={{ display: "flex", alignItems: "end", gap: 3, height: 128 }}>
                                  <div title={`Revenue ${row.period}`} style={{ width: 13, height: `${Math.max(6, (revenueValue / dashboardMonthlyTrend.maxValue) * 120)}px`, borderRadius: 4, background: "#2f4f73" }} />
                                  <div title={`Cost ${row.period}`} style={{ width: 13, height: `${Math.max(6, (costValue / dashboardMonthlyTrend.maxValue) * 120)}px`, borderRadius: 4, background: "#f3a35f" }} />
                                </div>
                                <div style={{ fontSize: 11, color: "#607689" }}>{monthLabel}</div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ minHeight: 170, border: "1px solid #e3ebf4", borderRadius: 8, background: "#fbfdff", padding: "6px 8px" }}>
                          {(() => {
                            const rows = dashboardMonthlyTrend.rows;
                            const chartWidth = Math.max(280, rows.length * 52);
                            const chartHeight = 140;
                            const max = Math.max(1, dashboardMonthlyTrend.maxValue);
                            const pointsFor = (kind: "revenue" | "cost") =>
                              rows
                                .map((row, idx) => {
                                  const value =
                                    dashboardChartScale === "amount"
                                      ? kind === "revenue"
                                        ? row.revenue
                                        : row.cost
                                      : kind === "revenue"
                                        ? row.revenuePctBudget
                                        : row.costPctBudget;
                                  const x = rows.length === 1 ? chartWidth / 2 : (idx * (chartWidth - 20)) / Math.max(1, rows.length - 1) + 10;
                                  const y = chartHeight - (Math.max(0, value) / max) * (chartHeight - 16) - 8;
                                  return `${x},${y}`;
                                })
                                .join(" ");
                            const revenuePoints = pointsFor("revenue");
                            const costPoints = pointsFor("cost");
                            return (
                              <>
                                <svg width="100%" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Revenue and cost line trend">
                                  <polyline fill="none" stroke="#2f4f73" strokeWidth="2.5" points={revenuePoints} />
                                  <polyline fill="none" stroke="#f3a35f" strokeWidth="2.5" points={costPoints} />
                                </svg>
                                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, rows.length)}, minmax(30px, 1fr))`, gap: 6, marginTop: 2 }}>
                                  {rows.map((row) => {
                                    const periodYear = Number(row.period.slice(0, 4));
                                    const periodMonth = Number(row.period.slice(5, 7));
                                    const monthLabel = new Date(Date.UTC(periodYear, periodMonth - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
                                    return (
                                      <div key={`dash-line-label-${row.period}`} style={{ fontSize: 11, color: "#607689", textAlign: "center" }}>
                                        {monthLabel}
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 12, color: "#4a6076" }}>
                      <span><strong style={{ color: "#2f4f73" }}>Revenue</strong>: <Currency value={dashboardStats.revenue} /></span>
                      <span><strong style={{ color: "#f3a35f" }}>Cost</strong>: <Currency value={dashboardStats.cost} /></span>
                    </div>
                  </div>
                  <div className="aq-dashboard-section">
                    <h3 className="aq-dashboard-section-title">Custom Analysis</h3>
                    <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: "#4a6076" }}>
                      Build ad-hoc analysis from app data (employee pay, profitability, and more).
                    </p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                      <button
                        onClick={() => {
                          setDashboardAnalysisDimension("employee");
                          setDashboardAnalysisMetric("pay");
                        }}
                      >
                        Employee Pay
                      </button>
                      <button
                        onClick={() => {
                          setDashboardAnalysisDimension("employee");
                          setDashboardAnalysisMetric("profit");
                        }}
                      >
                        Employee Profitability
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(160px, 1fr))", gap: 8, marginBottom: 10 }}>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span>Scope</span>
                        <select value={dashboardAnalysisScope} onChange={(e) => setDashboardAnalysisScope(e.target.value as DashboardAnalysisScope)}>
                          <option value="report_period">Selected Period</option>
                          <option value="inception">Inception To Date</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span>Dimension</span>
                        <select value={dashboardAnalysisDimension} onChange={(e) => setDashboardAnalysisDimension(e.target.value as DashboardAnalysisDimension)}>
                          <option value="employee">Employee</option>
                          <option value="project">Project</option>
                          <option value="task">Task</option>
                          <option value="subtask">Subtask</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span>Metric</span>
                        <select value={dashboardAnalysisMetric} onChange={(e) => setDashboardAnalysisMetric(e.target.value as DashboardAnalysisMetric)}>
                          <option value="pay">Employee Pay (Cost)</option>
                          <option value="profit">Profit</option>
                          <option value="revenue">Revenue</option>
                          <option value="cost">Cost</option>
                          <option value="hours">Hours</option>
                          <option value="margin_pct">Margin %</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                        <span>Rows</span>
                        <select value={dashboardAnalysisLimit} onChange={(e) => setDashboardAnalysisLimit(Number(e.target.value) as 10 | 20 | 50)}>
                          <option value={10}>Top 10</option>
                          <option value={20}>Top 20</option>
                          <option value={50}>Top 50</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: 12, gridColumn: "1 / -1" }}>
                        <span>Project Filter</span>
                        <select value={dashboardAnalysisProjectId ?? ""} onChange={(e) => setDashboardAnalysisProjectId(e.target.value ? Number(e.target.value) : null)}>
                          <option value="">All Projects</option>
                          {dashboardAnalysisSourceRows.map((p) => (
                            <option key={`dash-analysis-project-${p.project_id}`} value={p.project_id}>
                              {p.project_name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(96px, 1fr))", gap: 8, marginBottom: 8, fontSize: 12 }}>
                      <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 8 }}>Hours<br /><strong>{dashboardAnalysisTotals.hours.toFixed(1)}</strong></div>
                      <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 8 }}>Pay<br /><strong><Currency value={dashboardAnalysisTotals.pay} /></strong></div>
                      <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 8 }}>Revenue<br /><strong><Currency value={dashboardAnalysisTotals.revenue} /></strong></div>
                      <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 8 }}>Cost<br /><strong><Currency value={dashboardAnalysisTotals.cost} /></strong></div>
                      <div style={{ border: "1px solid #e3ebf4", borderRadius: 8, padding: 8 }}>Profit<br /><strong><Currency value={dashboardAnalysisTotals.profit} /></strong></div>
                    </div>
                    <div style={{ maxHeight: 250, overflow: "auto", border: "1px solid #d8e2ed", borderRadius: 8 }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                        <thead style={{ background: "#f3f7fb" }}>
                          <tr>
                            <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Item</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Hours</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Pay</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Revenue</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Cost</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Profit</th>
                            <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #d8e2ed" }}>Margin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dashboardAnalysisRows.length === 0 && (
                            <tr>
                              <td colSpan={7} style={{ padding: 10, color: "#4a6076" }}>
                                No rows for this analysis setup.
                              </td>
                            </tr>
                          )}
                          {dashboardAnalysisRows.map((row) => (
                            <tr key={`dash-analysis-row-${row.key}`}>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, fontWeight: 600 }}>{row.label}</td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}>{row.hours.toFixed(2)}</td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={row.pay} /></td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={row.revenue} /></td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={row.cost} /></td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={row.profit} /></td>
                              <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right", color: row.margin_pct < 0 ? "#b00020" : "#1f3f60" }}>
                                {row.margin_pct.toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
              {dashboardProjectKpis.length > dashboardOverviewRows.length && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#4a6076" }}>
                  Showing top {dashboardOverviewRows.length} projects. Open Project Control Board for full list.
                </div>
              )}
            </section>
          )}
          {activeView === "dashboard" && dashboardSubView === "controls" && (
            <section className="aq-performance-compact" style={{ border: "1px solid #d1dbe6", borderRadius: 10, padding: 16, marginBottom: 16, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 34, lineHeight: 1.1, color: "#a86735" }}>Project Control Board</h2>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setDashboardSubView("overview")}>Back To Overview</button>
                </div>
              </div>
              <p style={{ marginTop: 8, color: "#4a4a4a", fontSize: 13 }}>
                Reporting context: <strong>{dashboardKpiContextLabel}</strong>
              </p>
              <ReportPeriodControls
                keyPrefix="controls"
                reportPreset={reportPreset}
                applyReportPreset={applyReportPreset}
                reportYear={reportYear}
                setReportYear={setReportYear}
                reportYearOptions={reportYearOptions}
                reportMonth={reportMonth}
                setReportMonth={setReportMonth}
                reportWeekStart={reportWeekStart}
                setReportWeekStart={setReportWeekStart}
                reportWeekOptions={reportWeekOptions}
                reportPtdProjectId={reportPtdProjectId}
                setReportPtdProjectId={setReportPtdProjectId}
                reportPtdProjectOptions={reportPtdProjectOptions}
                reportStart={reportStart}
                setReportStart={setReportStart}
                reportEnd={reportEnd}
                setReportEnd={setReportEnd}
                showNativeDatePicker={showNativeDatePicker}
                containerStyle={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "8px 0 10px 0" }}
              />
              {canViewFinancials && (
                <div className="aq-dashboard-section">
                  <h3 className="aq-dashboard-section-title">Project KPI Status</h3>
                  <p style={{ marginTop: 0, color: "#3e5368", fontSize: 12 }}>
                    Live project table for the selected period. Click any row to inspect details.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(360px, 1.1fr) minmax(320px, 0.9fr)", gap: 12, alignItems: "start" }}>
                    <div style={{ border: "1px solid #cfd9e4", borderRadius: 12, background: "#ffffff", boxShadow: "0 6px 20px rgba(17, 32, 24, 0.06)" }}>
                      <div style={{ padding: "10px 12px", borderBottom: "1px solid #eef3f8", fontWeight: 600 }}>Project Financial Summary</div>
                      <div style={{ overflowX: "auto", maxHeight: 460 }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                          <thead style={{ position: "sticky", top: 0, background: "#f3f7fb", zIndex: 1 }}>
                            <tr>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>Project</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Total Budget</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Earned Revenue (Selected)</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Earned Revenue (Life)</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Earned Not Billed</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Unearned Budget Remaining</th>
                              <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Gross Margin</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dashboardProjectKpis.map((p) => {
                              const selected = dashboardSelectedProject?.project_id === p.project_id;
                              const meetsMargin = Number(p.margin_pct || 0) >= Number(p.target_gross_margin_pct || 0);
                              return (
                                <tr
                                  key={`dash-table-${p.project_id}`}
                                  onClick={() => setPerformanceProjectId(p.project_id)}
                                  style={{ background: selected ? "#fdf1e6" : meetsMargin ? "#edf9f1" : "#fdeeee", cursor: "pointer" }}
                                >
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, fontWeight: selected ? 700 : 500 }}>{p.project_name}</td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.totalBudget} digits={0} /></td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.revenueSelectedPeriod} digits={0} /></td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.revenueLifeToDate} digits={0} /></td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.earnedButUnbilled} digits={0} /></td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={p.unearnedBudgetRemaining} digits={0} /></td>
                                  <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}>
                                    {p.margin_pct.toFixed(1)}% / {p.target_gross_margin_pct.toFixed(1)}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div style={{ border: "1px solid #cfd9e4", borderRadius: 12, background: "#ffffff", boxShadow: "0 6px 20px rgba(17, 32, 24, 0.06)" }}>
                      <div style={{ padding: "10px 12px", borderBottom: "1px solid #eef3f8", fontWeight: 600 }}>
                        {dashboardSelectedProject ? `Project Detail: ${dashboardSelectedProject.project_name}` : "Project Detail"}
                      </div>
                      {!dashboardSelectedProject && (
                        <div style={{ padding: 12, fontSize: 12, color: "#3e5368" }}>Select a project row to view its derivation detail.</div>
                      )}
                      {dashboardSelectedProject && (
                        <div style={{ padding: 12 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(140px, 1fr))", gap: 8, marginBottom: 10, fontSize: 12 }}>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Target Margin<br /><strong>{dashboardSelectedProject.target_gross_margin_pct.toFixed(1)}%</strong></div>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Actual Margin<br /><strong>{dashboardSelectedProject.margin_pct.toFixed(1)}%</strong></div>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Earned Revenue (Selected)<br /><strong><Currency value={dashboardSelectedProject.revenueSelectedPeriod} digits={0} /></strong></div>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Earned Revenue (Life)<br /><strong><Currency value={dashboardSelectedProject.revenueLifeToDate} digits={0} /></strong></div>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Earned Not Billed<br /><strong><Currency value={dashboardSelectedProject.earnedButUnbilled} digits={0} /></strong></div>
                            <div style={{ border: "1px solid #eef3f8", padding: 8, borderRadius: 8 }}>Unearned Budget Remaining<br /><strong><Currency value={dashboardSelectedProject.unearnedBudgetRemaining} digits={0} /></strong></div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeView === "estimates" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Estimates</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Pre-billing planning view for active projects and target margin assumptions.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Active Projects<br /><strong>{projects.filter((p) => p.is_active).length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Budget (PTD)<br /><strong><Currency value={dashboardStats.budget} digits={0} /></strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Target Profit (sum)<br /><strong><Currency value={projectPerformance.reduce((s, p) => s + (p.target_profit || 0), 0)} digits={0} /></strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>At Risk<br /><strong>{dashboardAtRiskProjects.length}</strong></div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Budget</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Target Margin</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Target Profit</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Actual Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projectPerformance.map((p) => (
                      <tr key={`est-${p.project_id}`}>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{p.project_name}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.overall_budget_fee} /></td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{p.target_gross_margin_pct.toFixed(1)}%</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.target_profit} /></td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_profit} /></td>
                      </tr>
                    ))}
                    {projectPerformance.length === 0 && (
                      <tr><td colSpan={5} style={{ padding: 8, color: "#666" }}>No estimate baseline rows for this reporting period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button onClick={openProjectSetup}>Create Project</button>
                <button onClick={openProjectPerformance}>Open Performance</button>
              </div>
            </section>
          )}

          {activeView === "reports" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Reports</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Run management reports and drill into financial and operational detail by module.</p>
              {reportsWorkspaceTab === "overview" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 10 }}>
                <div style={{ border: "1px solid #eee", padding: 10 }}>
                  <strong>Project Performance</strong>
                  <p style={{ fontSize: 12, color: "#4a4a4a" }}>Margins, target gap, profitability by project.</p>
                  <button onClick={openProjectPerformance}>Open</button>
                </div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>
                  <strong>Timesheet Review</strong>
                  <p style={{ fontSize: 12, color: "#4a4a4a" }}>Submitted/approved status and labor summaries.</p>
                  <button onClick={openTimesheetWorkspace}>Open</button>
                </div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>
                  <strong>A/R and Invoices</strong>
                  <p style={{ fontSize: 12, color: "#4a4a4a" }}>Outstanding balances, aging, invoice continuity.</p>
                  <button onClick={openInvoices}>Open</button>
                </div>
                {canViewFinancials && (
                  <div style={{ border: "1px solid #eee", padding: 10 }}>
                    <strong>Tax Prep Workspace</strong>
                    <p style={{ fontSize: 12, color: "#4a4a4a" }}>Monthly tax-ready checks across invoices, reconciliation, and bank categorization.</p>
                    <button onClick={() => setReportsWorkspaceTab("tax")}>Open</button>
                  </div>
                )}
              </div>
              )}
              {reportsWorkspaceTab === "project" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>Project Profitability Snapshot</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Revenue</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectPerformance.map((p) => (
                          <tr key={`rep-proj-${p.project_id}`}>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{p.project_name}</td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_revenue} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_cost} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_profit} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{p.margin_pct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {reportsWorkspaceTab === "timesheets" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>Timesheet Status Summary</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(130px, 1fr))", gap: 10 }}>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Draft<br /><strong>{adminTimesheets.filter((t) => t.status === "draft").length}</strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Submitted<br /><strong>{adminTimesheets.filter((t) => t.status === "submitted").length}</strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Approved<br /><strong>{adminTimesheets.filter((t) => t.status === "approved").length}</strong></div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button onClick={openTimesheetWorkspace}>Open Team Timesheets</button>
                  </div>
                </div>
              )}
              {reportsWorkspaceTab === "financial" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>Financial Controls</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: 10 }}>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Budget<br /><strong><Currency value={dashboardStats.budget} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Revenue<br /><strong><Currency value={dashboardStats.revenue} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Cost<br /><strong><Currency value={dashboardStats.cost} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Profit<br /><strong><Currency value={dashboardStats.profit} digits={0} /></strong></div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button onClick={openExpenses}>Open Expense/Reconciliation</button>
                  </div>
                </div>
              )}
              {canViewFinancials && reportsWorkspaceTab === "tax" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>Tax Preparation Workspace</div>
                  <p style={{ marginTop: 0, color: "#4a4a4a", fontSize: 12 }}>
                    Keep books tax-ready by clearing uncategorized bank transactions, resolving reconciliation issues, and validating revenue/cost by month.
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                    <span style={{ fontSize: 12, color: "#4a6076" }}>Tax year:</span>
                    <select value={reportYear} onChange={(e) => setReportYear(Number(e.target.value))}>
                      {reportYearOptions.map((y) => (
                        <option key={`tax-year-${y}`} value={y}>
                          {y}
                        </option>
                      ))}
                    </select>
                    <button onClick={runMonthEndCloseCheck} disabled={isRunningMonthEndCheck}>
                      {isRunningMonthEndCheck ? "Running Month-End Check..." : "Run Month-End Check"}
                    </button>
                    <button onClick={() => setReportsWorkspaceTab("financial")}>Open Financial Controls</button>
                    <button onClick={openExpenses}>Open Reconciliation</button>
                    <button onClick={openSettingsBankTransactions}>Open Bank Transactions</button>
                    <button onClick={exportReconciliationCsv}>Export Reconciliation CSV</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Revenue (report)<br /><strong><Currency value={dashboardStats.revenue} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Cost (report)<br /><strong><Currency value={dashboardStats.cost} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Cash Collected<br /><strong><Currency value={taxPrepReadiness.invoicePaid} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>A/R Outstanding<br /><strong><Currency value={taxPrepReadiness.invoiceOutstanding} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 10 }}>Overdue A/R<br /><strong><Currency value={arSummary?.overdue_total || 0} digits={0} /></strong></div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: 10, marginBottom: 10 }}>
                    <div style={{ border: "1px solid #ecd8ab", background: "#fff8e8", padding: 10 }}>
                      Uncategorized Bank Rows<br />
                      <strong>{taxPrepReadiness.uncategorizedBankRows}</strong>
                    </div>
                    <div style={{ border: "1px solid #f2d1c8", background: "#fff2ef", padding: 10 }}>
                      Reconciliation Orphan Refs<br />
                      <strong>{taxPrepReadiness.orphanRefs}</strong>
                    </div>
                    <div style={{ border: "1px solid #f2d1c8", background: "#fff2ef", padding: 10 }}>
                      Bad/Zero Rate Entries<br />
                      <strong>{taxPrepReadiness.badRates}</strong>
                    </div>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Month</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Entries</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Revenue</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Data Issues</th>
                        </tr>
                      </thead>
                      <tbody>
                        {taxYearReconciliationRows.map((r) => (
                          <tr key={`tax-recon-${r.period}`}>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{r.period}</td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.entry_count}</td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{r.total_hours.toFixed(2)}</td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.bill_amount} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.cost_amount} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={r.profit_amount} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>
                              {Number(r.orphan_user_refs || 0) + Number(r.orphan_project_refs || 0) + Number(r.orphan_task_refs || 0) + Number(r.orphan_subtask_refs || 0) + Number(r.zero_or_negative_rate_entries || 0)}
                            </td>
                          </tr>
                        ))}
                        {taxYearReconciliationRows.length === 0 && (
                          <tr>
                            <td colSpan={7} style={{ padding: 8, color: "#666" }}>No reconciliation records available for this period.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {activeView === "payroll" && (
            <PayrollSection
              activeUsers={activeUsers}
              usersWithRatesCount={activeUsers.length - dashboardUsersWithoutRates.length}
              usersMissingRatesCount={dashboardUsersWithoutRates.length}
              laborCostText={formatCurrency(dashboardStats.cost, 0)}
              latestRates={latestRates}
              formatCurrency={formatCurrency}
              onManageRates={openTeamSettings}
            />
          )}

          {activeView === "settings" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Settings</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Workspace-level controls and shortcuts to configuration modules.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <button onClick={() => setSettingsSubView("workspace")} disabled={settingsSubView === "workspace"}>Workspace</button>
                <button onClick={() => setSettingsSubView("bank_connections")} disabled={settingsSubView === "bank_connections"}>Bank Connections</button>
                <button onClick={() => setSettingsSubView("bank_transactions")} disabled={settingsSubView === "bank_transactions"}>Bank Transactions</button>
                {canViewFinancials && <button onClick={() => setSettingsSubView("expense_mix")} disabled={settingsSubView === "expense_mix"}>Expense Mix</button>}
              </div>
              {settingsSubView === "workspace" && (
                <SettingsWorkspaceHome
                  canViewFinancials={canViewFinancials}
                  canManageUsers={canManageUsers}
                  bankConnectionsCount={bankConnections.length}
                  businessAccountsCount={bankAccounts.filter((a) => a.is_business).length}
                  bankQueueVisibleCount={bankQueue.length}
                  bankQueueTotal={bankQueueTotal}
                  openTeamSettings={openTeamSettings}
                  openProjectEditor={openProjectEditor}
                  openAccountingWorkspace={openAccountingWorkspace}
                  openSettingsBankConnections={openSettingsBankConnections}
                  openSettingsBankTransactions={openSettingsBankTransactions}
                  openSettingsExpenseMix={openSettingsExpenseMix}
                  auditEntityFilter={auditEntityFilter}
                  setAuditEntityFilter={setAuditEntityFilter}
                  auditActionFilter={auditActionFilter}
                  setAuditActionFilter={setAuditActionFilter}
                  refreshAuditEvents={refreshAuditEvents}
                  auditEvents={auditEvents}
                />
              )}
              {canViewFinancials && settingsSubView === "bank_connections" && (
                <div style={{ border: "1px solid #dbe4ee", padding: 10, background: "#f7fafd" }}>
                  <strong>Bank Connections</strong>
                  <p style={{ fontSize: 12, color: "#4a4a4a" }}>
                    Connect and sync live bank transactions.
                  </p>
                  <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 12, color: "#4a6076" }}>
                    <input
                      type="checkbox"
                      checked={showEmergencyCsvImport}
                      onChange={(e) => setShowEmergencyCsvImport(e.target.checked)}
                    />
                    Enable emergency CSV import tools (use only if Plaid is unavailable)
                  </label>
                  <BankFeedQuickActions
                    isPlaidConnecting={isPlaidConnecting}
                    onConnectPlaidLink={connectPlaidLink}
                    onConnectPlaidSandbox={connectPlaidSandbox}
                    onImportExpenseCatBusiness={() => selectExpenseCatCategorizedCsv(true)}
                    showImportExpenseCat={showEmergencyCsvImport}
                    onRefreshBankFeed={refreshBankWorkspaceData}
                    includePersonal={bankQueueIncludePersonal}
                    onToggleIncludePersonal={(checked) => {
                      setBankQueueOffset(0);
                      setBankQueueIncludePersonal(checked);
                    }}
                  />
                  <div style={{ marginTop: 8, fontSize: 12, color: "#4a6076" }}>
                    Connections: <strong>{bankConnections.length}</strong> | Business Accounts: <strong>{bankAccounts.filter((a) => a.is_business).length}</strong>
                  </div>
                  <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
                    {bankConnections.slice(0, 8).map((c) => (
                      <div key={`bank-conn-${c.id}`} style={{ border: "1px solid #e3ebf3", borderRadius: 8, padding: 6, background: "#fff" }}>
                        <div style={{ fontWeight: 600 }}>{c.institution_name || "Plaid Institution"}</div>
                        <div style={{ fontSize: 11, color: "#5c7288" }}>
                          Provider: {c.provider} | Status: {c.status} | Accounts: {c.account_count} | Transactions: {c.transaction_count} | Last sync: {c.last_synced_at ? new Date(c.last_synced_at).toLocaleString() : "-"}
                        </div>
                        {c.provider === "plaid" ? (
                          <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button onClick={() => syncBankConnection(c.id)}>Sync Now</button>
                            {c.status === "reauth_required" && (
                              <button onClick={() => connectPlaidLink(c.id)}>Re-authenticate</button>
                            )}
                          </div>
                        ) : (
                          <div style={{ marginTop: 4, fontSize: 11, color: "#5c7288" }}>
                            Imported connection (no live sync).
                          </div>
                        )}
                        <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                          {bankAccounts.filter((a) => a.connection_id === c.id).map((a) => (
                            <div key={`bank-acct-${a.id}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 11, border: "1px solid #eef3f8", borderRadius: 6, padding: "4px 6px" }}>
                              <span>
                                {a.name || "Account"} {a.mask ? `••${a.mask}` : ""} | {a.type || "-"} {a.subtype ? `/ ${a.subtype}` : ""}
                              </span>
                              <button
                                style={{ padding: "3px 8px", fontSize: 11 }}
                                onClick={() => classifyBankAccount(a.id, !a.is_business)}
                              >
                                {a.is_business ? "Mark Personal" : "Mark Business"}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {bankConnections.length === 0 && <div style={{ fontSize: 11, color: "#5c7288" }}>No bank connections yet.</div>}
                  </div>
                </div>
              )}
              {canViewFinancials && settingsSubView === "bank_transactions" && (
                <div style={{ border: "1px solid #dbe4ee", padding: 10, background: "#f7fafd" }}>
                  <strong>Bank Transactions & Reconciliation</strong>
                  <div style={{ marginTop: 6, fontSize: 12, color: "#4a6076" }}>
                    Total queue rows: <strong>{bankQueueTotal}</strong> | Visible after filters: <strong>{visibleBankQueue.length}</strong> | Plaid connected: <strong>{hasPlaidConnection ? "Yes" : "No"}</strong>
                  </div>
                  {!hasPlaidConnection && (
                    <div style={{ marginTop: 6, fontSize: 12, color: "#8a5a00", background: "#fff8e8", border: "1px solid #ecd8ab", borderRadius: 8, padding: "6px 8px" }}>
                      Plaid is not connected yet. Duplicate reconciliation works best after at least one Plaid account is connected and synced.
                    </div>
                  )}
                  <div style={{ marginTop: 8, borderTop: "1px solid #e3ebf3", paddingTop: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#2f4860", marginBottom: 6 }}>Reconciliation Queue (Business Only By Default)</div>
                      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, color: "#4a6076", marginBottom: 6 }}>
                        <input
                          type="checkbox"
                          checked={bankQueueIncludePersonal}
                          onChange={(e) => {
                            setBankQueueOffset(0);
                            setBankQueueIncludePersonal(e.target.checked);
                          }}
                        />
                        Include personal transactions
                      </label>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6, fontSize: 11 }}>
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          Project for posting:
                          <select value={bankExpenseProjectId ?? ""} onChange={(e) => setBankExpenseProjectId(e.target.value ? Number(e.target.value) : null)}>
                            <option value="">Select project</option>
                            {projects.map((p) => (
                              <option key={`bank-exp-post-proj-${p.id}`} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          Rows:
                          <select
                            value={bankQueueLimit}
                            onChange={(e) => {
                              setBankQueueOffset(0);
                              setBankQueueLimit(Number(e.target.value) as 40 | 100 | 250);
                            }}
                          >
                            <option value={40}>40</option>
                            <option value={100}>100</option>
                            <option value={250}>250</option>
                          </select>
                        </label>
                        <button onClick={() => setBankQueueOffset((prev) => Math.max(0, prev - bankQueueLimit))} disabled={bankQueueOffset <= 0}>
                          Prev
                        </button>
                        <button
                          onClick={() => setBankQueueOffset((prev) => (prev + bankQueueLimit < bankQueueTotal ? prev + bankQueueLimit : prev))}
                          disabled={bankQueueOffset + bankQueueLimit >= bankQueueTotal}
                        >
                          Next
                        </button>
                        <span>
                          Showing {bankQueueTotal === 0 ? 0 : bankQueueOffset + 1}-
                          {Math.min(bankQueueOffset + bankQueue.length, bankQueueTotal)} of {bankQueueTotal}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8, fontSize: 11 }}>
                        <input
                          value={bankQueueSearch}
                          onChange={(e) => setBankQueueSearch(e.target.value)}
                          placeholder="Search description, merchant, account..."
                          style={{ minWidth: 260 }}
                        />
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          Connection:
                          <select
                            value={bankQueueConnectionFilter ?? ""}
                            onChange={(e) => setBankQueueConnectionFilter(e.target.value ? Number(e.target.value) : null)}
                          >
                            <option value="">All</option>
                            {bankConnections.map((c) => (
                              <option key={`bank-q-conn-filter-${c.id}`} value={c.id}>
                                {c.institution_name || `Connection ${c.id}`}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          Group:
                          <select value={bankQueueGroupFilter} onChange={(e) => setBankQueueGroupFilter(e.target.value)}>
                            <option value="all">All</option>
                            {bankCategoryGroups.map((g) => (
                              <option key={`bank-q-group-filter-${g.group}`} value={g.group}>
                                {g.group}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          Sort:
                          <select
                            value={bankQueueSort}
                            onChange={(e) =>
                              setBankQueueSort(
                                e.target.value as "date_desc" | "date_asc" | "amount_desc" | "amount_asc" | "confidence_desc",
                              )
                            }
                          >
                            <option value="date_desc">Newest Date</option>
                            <option value="date_asc">Oldest Date</option>
                            <option value="amount_desc">Largest Amount</option>
                            <option value="amount_asc">Smallest Amount</option>
                            <option value="confidence_desc">Best Invoice Match</option>
                          </select>
                        </label>
                        <button onClick={reconcileImportedBankTransactions} disabled={!hasPlaidConnection}>Reconcile CSV vs Plaid Duplicates</button>
                        <button onClick={resetBankQueueFilters}>Reset Filters</button>
                        <button onClick={applyBankCategoryRecommendations}>Apply Smart Category Recommendations</button>
                        <span style={{ color: "#4a6076" }}>Visible on this page: {visibleBankQueue.length}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, alignItems: "start" }}>
                        <div style={{ display: "grid", gap: 6 }}>
                          {visibleBankQueue.map((q) => (
                            <div key={`bank-queue-${q.bank_transaction_id}`} style={{ border: "1px solid #e3ebf3", borderRadius: 8, padding: 6, background: "#fff" }}>
                              {(() => {
                                const draft = bankCategoryDraftFor(q);
                                const categoriesForGroup =
                                  bankCategoryGroups.find((g) => g.group === draft.expense_group)?.categories ||
                                  bankCategoryGroups.find((g) => g.group === "OH")?.categories ||
                                  ["Uncategorized"];
                                return (
                                  <>
                              <div style={{ fontWeight: 600, fontSize: 12, lineHeight: 1.3, color: "#1f2f3f" }}>
                                {q.posted_date || "-"} | {q.description}
                              </div>
                              <div style={{ fontSize: 12, lineHeight: 1.3, color: "#3f556b", marginTop: 2 }}>
                                Amount: <Currency value={q.amount} /> | Account: {q.account_name || q.account_id} | Merchant: {q.merchant_name || "-"} | Class: {draft.expense_group} / {draft.category} {q.pending ? "| Pending" : ""}
                              </div>
                              <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 11 }}>
                                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                  Group
                                  <select
                                    value={draft.expense_group}
                                    onChange={(e) => {
                                      const nextGroup = e.target.value;
                                      const defaultCategory =
                                        bankCategoryGroups.find((g) => g.group === nextGroup)?.categories?.[0] || "Uncategorized";
                                      setBankCategoryDrafts((prev) => ({
                                        ...prev,
                                        [q.bank_transaction_id]: {
                                          ...draft,
                                          expense_group: nextGroup,
                                          category: defaultCategory,
                                        },
                                      }));
                                    }}
                                  >
                                    {bankCategoryGroups.map((g) => (
                                      <option key={`bank-cat-group-${q.bank_transaction_id}-${g.group}`} value={g.group}>
                                        {g.group}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                  Category
                                  <select
                                    value={draft.category}
                                    onChange={(e) =>
                                      setBankCategoryDrafts((prev) => ({
                                        ...prev,
                                        [q.bank_transaction_id]: { ...draft, category: e.target.value },
                                      }))
                                    }
                                  >
                                    {categoriesForGroup.map((cat) => (
                                      <option key={`bank-cat-item-${q.bank_transaction_id}-${cat}`} value={cat}>
                                        {cat}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                  <input
                                    type="checkbox"
                                    checked={draft.learn_for_merchant}
                                    onChange={(e) =>
                                      setBankCategoryDrafts((prev) => ({
                                        ...prev,
                                        [q.bank_transaction_id]: { ...draft, learn_for_merchant: e.target.checked },
                                      }))
                                    }
                                  />
                                  Learn merchant rule
                                </label>
                                <button onClick={() => categorizeBankTransaction(q.bank_transaction_id)}>Apply Category</button>
                              </div>
                              <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                <button
                                  style={{ padding: "3px 8px", fontSize: 11 }}
                                  onClick={() => classifyBankTransaction(q.bank_transaction_id, !q.is_business)}
                                >
                                  {q.is_business ? "Mark Personal" : "Mark Business"}
                                </button>
                                {q.suggested_invoice_id && (
                                  <span style={{ fontSize: 11, color: "#4a6076" }}>
                                    Suggested: {q.suggested_invoice_number} ({q.suggested_invoice_client || "Client"}) conf {((q.suggested_confidence || 0) * 100).toFixed(0)}%
                                  </span>
                                )}
                                {q.suggested_invoice_id && <button onClick={() => confirmBankMatch(q.bank_transaction_id, q.suggested_invoice_id!)}>Confirm Match</button>}
                                <button onClick={() => postBankTransactionToProjectExpense(q.bank_transaction_id)} disabled={!bankExpenseProjectId}>
                                  Post To Project Expense
                                </button>
                              </div>
                                  </>
                                );
                              })()}
                            </div>
                          ))}
                          {visibleBankQueue.length === 0 && <div style={{ fontSize: 11, color: "#5c7288" }}>No unmatched transactions for the current filters.</div>}
                        </div>
                      </div>
                    </div>
                  </div>
              )}
              {canViewFinancials && settingsSubView === "expense_mix" && (
                <div style={{ border: "1px solid #dbe4ee", borderRadius: 8, padding: 10, background: "#fbfdff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#1f3650", lineHeight: 1.1 }}>Expense Mix</div>
                    <select value={bankSummaryBreakdown} onChange={(e) => setBankSummaryBreakdown(e.target.value as BankSummaryBreakdown)} style={{ fontSize: 11 }}>
                      <option value="category">By Category</option>
                      <option value="merchant">By Merchant</option>
                      <option value="expense_group">By Expense Group</option>
                    </select>
                  </div>
                  {bankCategoryPieSlices.length > 0 ? (
                    <div style={{ display: "flex", justifyContent: "center", padding: "6px 0 4px 0" }}>
                      <MiniLabeledPie slices={bankCategoryPieSlices} size={420} valueMode="currency" showLegend={false} showSliceLabels />
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "#5c7288" }}>No summary data for current filter.</div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 11, color: "#4a6076" }}>
                    Transactions: <strong>{bankCategorySummaryTotals.count}</strong> | Absolute Amount: <strong>{formatCurrency(bankCategorySummaryTotals.amount)}</strong>
                  </div>
                  <div style={{ marginTop: 8, borderTop: "1px solid #e3ebf3", paddingTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#2f4860", marginBottom: 4 }}>Legend</div>
                    {(bankSummaryRows || []).slice(0, 12).map((r) => (
                      <div key={`bank-summary-${r.dimension}-${r.label}`} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, fontSize: 11, padding: "4px 0", borderBottom: "1px solid #eef3f8" }}>
                        <span style={{ color: "#1f2f3f", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 999,
                              display: "inline-block",
                              background:
                                bankCategoryPieSlices.find((s) => s.label === r.label)?.color || "#9aa8b7",
                            }}
                          />
                          {r.label}
                        </span>
                        <span style={{ color: "#2f4860", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(r.amount_abs)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {activeView === "clients" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Clients</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>Client list from project records.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Clients<br /><strong>{clientRows.length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Projects<br /><strong>{projects.length}</strong></div>
                <div style={{ border: "1px solid #eee", padding: 10 }}>Active Projects<br /><strong>{projects.filter((p) => p.is_active).length}</strong></div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Projects</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Active</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Total Budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clientRows.map((row) => (
                      <tr key={`client-row-${row.client}`}>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{row.client}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{row.projects}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{row.active}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={row.totalBudget} digits={0} /></td>
                      </tr>
                    ))}
                    {clientRows.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ padding: 8, color: "#666" }}>No client records yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
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
            <section style={{ border: "1px solid #cfd9e4", borderRadius: 12, padding: 16, marginBottom: 16, background: "#fff", boxShadow: "0 8px 24px rgba(17, 32, 24, 0.06)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <h2 style={{ margin: 0 }}>Project Cockpit</h2>
                  <p style={{ marginTop: 4, color: "#3e5368" }}>Portfolio status and financial signal. Click any project row to open dashboard detail.</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={openDashboardHome}>Open Dashboard</button>
                  <button onClick={openProjectEditor}>Open Project Editor</button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(140px, 1fr))", gap: 10, marginBottom: 14 }}>
                <div style={{ border: "1px solid #dbe4ee", borderRadius: 10, padding: 10, background: "#f7fafd" }}>Active Projects<br /><strong>{projectCockpitRows.length}</strong></div>
                <div style={{ border: "1px solid #efcdbf", borderRadius: 10, padding: 10, background: "#fff5ef" }}>At Risk<br /><strong>{projectCockpitRows.filter((r) => r.status === "At Risk").length}</strong></div>
                <div style={{ border: "1px solid #d1deeb", borderRadius: 10, padding: 10, background: "#f4f8fc" }}>On Target<br /><strong>{projectCockpitRows.filter((r) => r.status === "On Target").length}</strong></div>
                <div style={{ border: "1px solid #e9e2d0", borderRadius: 10, padding: 10, background: "#fffaf0" }}>Non-billable<br /><strong>{projectCockpitRows.filter((r) => r.status === "Non-billable (cost only)").length}</strong></div>
                <div style={{ border: "1px solid #e6e6e6", borderRadius: 10, padding: 10, background: "#fafafa" }}>No Data<br /><strong>{projectCockpitRows.filter((r) => r.status === "No financial data yet").length}</strong></div>
              </div>
              {projectCockpitRows.length === 0 && <p>No active projects found.</p>}
              {projectCockpitRows.length > 0 && (
                <div style={{ overflowX: "auto", border: "1px solid #cfd9e4", borderRadius: 10 }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead style={{ background: "#f3f7fb" }}>
                      <tr>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>Project</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>Client</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>PM</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>Status</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Budget</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Revenue</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Cost</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Profit</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 8 }}>Margin</th>
                        <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 8 }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projectCockpitRows.map((r) => {
                        const statusColor = r.status === "At Risk" ? "#b00020" : r.status === "On Target" ? "#1f3f60" : "#4c6175";
                        return (
                          <tr
                            key={`cockpit-proj-${r.id}`}
                            onClick={() => {
                              setPerformanceProjectId(r.id);
                              setDashboardDetailTab("summary");
                              setActiveView("dashboard");
                              setDashboardSubView("overview");
                            }}
                            style={{ cursor: "pointer" }}
                          >
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, fontWeight: 600 }}>{r.name}</td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8 }}>{r.client}</td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8 }}>{r.pm}</td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8 }}>
                              <span style={{ color: statusColor }}>{r.status}</span>
                            </td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={r.budget} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={r.revenue} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}><Currency value={r.cost} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}>{r.profit === null ? "-" : <Currency value={r.profit} />}</td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8, textAlign: "right" }}>{r.margin === null ? "-" : `${r.margin.toFixed(1)}%`}</td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 8 }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPerformanceProjectId(r.id);
                                  setDashboardDetailTab("summary");
                                  setActiveView("dashboard");
                                  setDashboardSubView("overview");
                                }}
                              >
                                Open Detail
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {projectFinanceBridgeRows.length > 0 && (
                <div style={{ marginTop: 14, border: "1px solid #dbe4ee", borderRadius: 10, padding: 10, background: "#f9fbfe" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <strong>Project Finance Bridge</strong>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={openInvoices}>Open Invoices</button>
                      <button onClick={openExpenses}>Open Expenses</button>
                      <button onClick={openSettingsBankTransactions}>Open Bank Transactions</button>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "#4a6076", marginBottom: 8 }}>
                    Links project delivery to accounting: recognized revenue vs invoiced, open A/R, overdue exposure, and cash flow gap.
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 6 }}>Project</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Recognized Rev</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Invoiced</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Uninvoiced</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Open A/R</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Overdue A/R</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "right", padding: 6 }}>Cash Flow Gap</th>
                          <th style={{ borderBottom: "1px solid #d8e2ed", textAlign: "left", padding: 6 }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectFinanceBridgeRows.map((r) => (
                          <tr key={`proj-fin-bridge-${r.id}`}>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6 }}>
                              <div style={{ fontWeight: 600 }}>{r.name}</div>
                              <div style={{ fontSize: 11, color: "#5c7288" }}>{r.client}</div>
                            </td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}><Currency value={r.recognizedRevenue} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}><Currency value={r.invoiceSubtotal} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}><Currency value={r.uninvoicedRevenue} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}>
                              <Currency value={r.balance} />
                              {r.openInvoices > 0 ? <div style={{ fontSize: 10, color: "#5c7288" }}>{r.openInvoices} open</div> : null}
                            </td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}>
                              <Currency value={r.overdueAmount} />
                              {r.overdueInvoices > 0 ? <div style={{ fontSize: 10, color: "#8a2d2d" }}>{r.overdueInvoices} overdue</div> : null}
                            </td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6, textAlign: "right" }}><Currency value={r.cashFlowGap} /></td>
                            <td style={{ borderBottom: "1px solid #eef3f8", padding: 6 }}>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button
                                  onClick={() => {
                                    setInvoiceProjectId(r.id);
                                    setActiveView("invoices");
                                    setInvoiceWorkspaceTab("studio");
                                  }}
                                >
                                  Invoice Now
                                </button>
                                <button
                                  onClick={() => {
                                    setBankExpenseProjectId(r.id);
                                    setActiveView("settings");
                                    setSettingsSubView("bank_transactions");
                                  }}
                                >
                                  Match Expenses
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {canManageProjects && activeView === "projects" && projectSubView === "setup" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2>Project Setup</h2>
              <p className="aq-form-hint">
                Complete all project fields before creating. Required fields: project start, target end, overall budget, PM.
              </p>
              <form onSubmit={createProject} style={{ marginBottom: 8 }}>
                <div className="aq-form-grid">
                <label>
                  <span>Project Name</span>
                  <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name" />
                </label>
                <label>
                  <span>Client Name</span>
                  <input value={projectClient} onChange={(e) => setProjectClient(e.target.value)} placeholder="Client" />
                </label>
                <label>
                  <span>Project Start Date</span>
                  <input
                    type="date"
                    value={projectStartDate}
                    onChange={(e) => setProjectStartDate(e.target.value)}
                    required
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  />
                </label>
                <label>
                  <span>Project Target End Date</span>
                  <input
                    type="date"
                    value={projectEndDate}
                    onChange={(e) => setProjectEndDate(e.target.value)}
                    required
                    onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                    onClick={(e) => showNativeDatePicker(e.currentTarget)}
                  />
                </label>
                <label>
                  <span>Overall Budget Fee</span>
                  <input type="number" min="0.01" step="0.01" value={projectOverallBudget} onChange={(e) => setProjectOverallBudget(e.target.value)} placeholder="Overall budget fee" required />
                </label>
                <label>
                  <span>Target Gross Margin %</span>
                  <input value={projectTargetMargin} onChange={(e) => setProjectTargetMargin(e.target.value)} placeholder="Target gross margin %" />
                </label>
                <label>
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
                <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 22 }}>
                  <input type="checkbox" checked={projectIsBillable} onChange={(e) => setProjectIsBillable(e.target.checked)} />
                  Billable Project
                </label>
                </div>
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
            {lockToMyTimesheet && (
              <div style={{ marginTop: 8, marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>Timesheet Period:</strong>
                {canApproveTimesheets ? (
                  <select value={timesheetPeriodFilter} onChange={(e) => setTimesheetPeriodFilter(e.target.value)}>
                    <option value="">{timesheetUserFilter ? "Select period" : "Select employee first"}</option>
                    {availableTimesheetPeriods.map((p) => (
                      <option key={`entry-team-ts-period-${p}`} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select value={myTimesheetPeriodFilter} onChange={(e) => setMyTimesheetPeriodFilter(e.target.value)}>
                    <option value="">Current Week</option>
                    {availableMyTimesheetPeriods.map((p) => (
                      <option key={`entry-my-ts-period-${p}`} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                )}
                <span style={{ color: "#666", fontSize: 12 }}>
                  Pick a period and view mode (week or month). Add time, save entries, then submit at week end.
                </span>
                {selectedReviewTimesheet &&
                  (selectedReviewTimesheet.status === "draft" || selectedReviewTimesheet.status === "rejected") && (
                    <button
                      onClick={() => {
                        if (canApproveTimesheets && selectedReviewTimesheet.user_id !== me?.id) {
                          submitTimesheetForEmployee(selectedReviewTimesheet.id);
                        } else {
                          submitTimesheet(selectedReviewTimesheet.id);
                        }
                      }}
                    >
                      {canApproveTimesheets && selectedReviewTimesheet.user_id !== me?.id
                        ? "Submit for Employee"
                        : "Submit Timesheet"}
                    </button>
                  )}
                {canApproveTimesheets && (
                  <div style={{ marginLeft: isNarrowViewport ? 0 : "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>Employee:</strong>
                    <select
                      value={timesheetUserFilter ?? ""}
                      onChange={(e) => {
                        const next = e.target.value ? Number(e.target.value) : null;
                        setTimesheetUserFilter(next);
                      }}
                    >
                      <option value="">Select employee</option>
                      {availableTimesheetUsers.map((u) => (
                        <option key={`entry-team-user-${u.id}`} value={u.id}>
                          {u.full_name || u.email}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            {canManageRates && !lockToMyTimesheet && (
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
              {!lockToMyTimesheet && timeViewMode === "month" && monthWeekRanges.length > 1 && (
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
            {!lockToMyTimesheet && <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
                    {formatWbsSubtaskLabel(s)}
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
            </div>}
            <div style={{ marginTop: 12 }}>
              <h3 style={{ margin: "8px 0" }}>Timesheet Grid</h3>
              {lockToMyTimesheet && timeViewMode === "month" ? (
                <div style={{ overflowX: "auto", border: "1px solid #c4cfdb", borderRadius: 6 }}>
                  <table data-disable-table-sort="true" style={{ borderCollapse: "collapse", width: "100%", tableLayout: "fixed" }}>
                    <thead>
                      <tr style={{ background: "#f7f9fb" }}>
                        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
                          <th key={`month-head-${label}`} style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "center", padding: 8 }}>
                            {label}
                          </th>
                        ))}
                        <th style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "right", padding: 8 }}>Week Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthWeeks.map((week, weekIdx) => (
                        <tr key={`month-week-row-${weekIdx}`}>
                          {week.map((day, dayIdx) => (
                            <td
                              key={`month-cell-${weekIdx}-${dayIdx}-${day || "blank"}`}
                              onClick={() => day && openEntryForDate(day)}
                              style={{
                                borderBottom: "1px solid #dce4ed",
                                borderLeft: "1px solid #edf2f6",
                                padding: 8,
                                minHeight: 72,
                                verticalAlign: "top",
                                cursor: day ? "pointer" : "default",
                                background: day && Number(dailyHours[day] || 0) > 0 ? "#fbfdff" : "#fff",
                              }}
                            >
                              {day ? (
                                <div style={{ display: "grid", gap: 4 }}>
                                  <div style={{ fontSize: 12, color: "#445b72", fontWeight: 600 }}>{day.slice(8, 10)}</div>
                                  <div style={{ fontSize: 14, fontWeight: 700 }}>{Number(dailyHours[day] || 0).toFixed(2)}</div>
                                </div>
                              ) : ""}
                            </td>
                          ))}
                          <td style={{ borderBottom: "1px solid #dce4ed", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "right", fontWeight: 700 }}>
                            {Number(monthWeekTotals[weekIdx] || 0).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: "#fafbfd" }}>
                        {monthWeekdayTotals.map((value, idx) => (
                          <td key={`month-weekday-total-${idx}`} style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "center", fontWeight: 700 }}>
                            {value.toFixed(2)}
                          </td>
                        ))}
                        <td style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "right", fontWeight: 700 }}>
                          {monthTotalHours.toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <div style={{ overflowX: "auto", border: "1px solid #c4cfdb", borderRadius: 6 }}>
                  <table data-disable-table-sort="true" style={{ borderCollapse: "collapse", width: "100%", minWidth: lockToMyTimesheet ? (isNarrowViewport ? 0 : Math.max(860, 360 + displayedGridDates.length * 84)) : Math.max(960, 380 + displayedGridDates.length * 92) }}>
                    <thead>
                      <tr style={{ background: "#f7f9fb" }}>
                        <th style={{ borderBottom: "1px solid #c4cfdb", borderRight: "1px solid #d7dfe8", textAlign: "left", padding: 8 }}>
                          {lockToMyTimesheet ? "Project / Task" : "Project"}
                        </th>
                        {!lockToMyTimesheet && <th style={{ borderBottom: "1px solid #c4cfdb", borderRight: "1px solid #d7dfe8", textAlign: "left", padding: 8 }}>Task</th>}
                        {!lockToMyTimesheet && <th style={{ borderBottom: "1px solid #c4cfdb", borderRight: "1px solid #d7dfe8", textAlign: "left", padding: 8 }}>Subtask</th>}
                        {displayedGridDates.map((day) => (
                          <th key={`grid-head-${day}`} style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "center", padding: 8, minWidth: isNarrowViewport ? 68 : 92, background: "#f4f7fa" }}>
                            <div style={{ display: "grid", gap: 4, justifyItems: "center" }}>
                              <span style={{ fontSize: 12 }}>{dayLabelFromYmd(day)}</span>
                              <button onClick={() => openEntryForDate(day)} title={`Add entry on ${day}`}>+</button>
                            </div>
                          </th>
                        ))}
                        <th style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "right", padding: 8 }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeGridRows.length === 0 && (
                        <tr>
                          <td colSpan={displayedGridDates.length + (lockToMyTimesheet ? 2 : 4)} style={{ padding: 10, color: "#666" }}>
                            No rows yet for this period. Use + on any day to add time.
                          </td>
                        </tr>
                      )}
                      {timeGridRows.map((row) => {
                        const rowDisplayedTotal = displayedGridDates.reduce((sum, day) => sum + Number(row.byDay[day] || 0), 0);
                        return (
                        <tr key={`grid-row-${row.key}`}>
                          <td style={{ borderBottom: "1px solid #dce4ed", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>
                            <div style={{ fontWeight: 600 }}>{row.projectLabel}</div>
                            {lockToMyTimesheet ? (
                              <div style={{ fontSize: 11, color: "#667a90", marginTop: 2 }}>
                                {row.taskLabel}{row.subtaskLabel ? ` • ${row.subtaskLabel}` : ""}
                              </div>
                            ) : null}
                          </td>
                          {!lockToMyTimesheet && <td style={{ borderBottom: "1px solid #dce4ed", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>{row.taskLabel}</td>}
                          {!lockToMyTimesheet && <td style={{ borderBottom: "1px solid #dce4ed", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>{row.subtaskLabel}</td>}
                          {displayedGridDates.map((day) => (
                            (() => {
                              const noteList = row.byDayNotes[day] || [];
                              const noteTitle = noteList.length > 0 ? noteList.join("\n") : `Open entries for ${day}`;
                              return (
                            <td
                              key={`grid-cell-${row.key}-${day}`}
                              onClick={() => openEntryForDate(day)}
                              title={noteTitle}
                              style={{ borderBottom: "1px solid #dce4ed", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "center", cursor: "pointer", background: row.byDay[day] ? "#fbfdff" : "#fff" }}
                            >
                              {row.byDay[day] ? (
                                <div style={{ display: "grid", gap: 2, justifyItems: "center" }}>
                                  <strong style={{ fontSize: 12 }}>{row.byDay[day].toFixed(2)}</strong>
                                  {noteList.length > 0 && (
                                    <span style={{ fontSize: 10, color: "#567", maxWidth: isNarrowViewport ? 56 : 78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {noteList[0]}
                                    </span>
                                  )}
                                </div>
                              ) : ""}
                            </td>
                              );
                            })()
                          ))}
                          <td style={{ borderBottom: "1px solid #dce4ed", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "right", fontWeight: 700 }}>{rowDisplayedTotal.toFixed(2)}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: "#fafbfd" }}>
                        <td colSpan={lockToMyTimesheet ? 1 : 3} style={{ borderTop: "1px solid #c4cfdb", padding: 8, fontWeight: 700 }}>Period Totals</td>
                        {displayedGridDates.map((day) => (
                          <td key={`grid-total-${day}`} style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "center", fontWeight: 700 }}>
                            {Number(timeGridDayTotals[day] || 0).toFixed(2)}
                          </td>
                        ))}
                        <td style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "right", fontWeight: 700 }}>
                          {displayedGridDates.reduce((sum, d) => sum + Number(timeGridDayTotals[d] || 0), 0).toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {entryDate && (
                <div
                  style={{
                    position: lockToMyTimesheet ? "static" : "fixed",
                    top: lockToMyTimesheet ? undefined : 0,
                    right: lockToMyTimesheet ? undefined : 0,
                    height: lockToMyTimesheet ? "auto" : "100%",
                    display: "block",
                    zIndex: 1000,
                    pointerEvents: lockToMyTimesheet ? "auto" : "none",
                    marginTop: lockToMyTimesheet ? 12 : 0,
                  }}
                >
                  <div
                    style={{
                      width: lockToMyTimesheet ? "100%" : 460,
                      maxWidth: "100%",
                      height: lockToMyTimesheet ? "auto" : "100%",
                      background: "#fff",
                      padding: 16,
                      overflowY: "auto",
                      boxShadow: lockToMyTimesheet ? "none" : "-2px 0 12px rgba(0,0,0,0.18)",
                      border: lockToMyTimesheet ? "1px solid #d3dce6" : "none",
                      borderRadius: lockToMyTimesheet ? 8 : 0,
                      pointerEvents: "auto",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <h4 style={{ margin: 0 }}>{editingEntryId ? `Edit Entry #${editingEntryId}` : "Add Entry"} - {entryDate}</h4>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button
                          onClick={() => {
                            setEditingEntryId(null);
                            setEntryHours("8");
                            setEntryNote("");
                            if (!entryDate) return;
                            openEntryForDate(entryDate);
                          }}
                          title="Add another project/task entry for this day"
                        >
                          + Add Another
                        </button>
                        <button onClick={closeEntryModal}>
                          Close
                        </button>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
                      <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "#4b6075", fontWeight: 700 }}>Project</span>
                        <select value={entryProjectId ?? ""} onChange={(e) => setEntryProject(e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Select project</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "#4b6075", fontWeight: 700 }}>Task</span>
                        <select
                          value={entryTaskId ?? ""}
                          onChange={(e) => {
                            setEntryTaskId(e.target.value ? Number(e.target.value) : null);
                            setEntrySubtaskId(null);
                          }}
                        >
                          <option value="">Select task</option>
                          {(entryProjectId ? wbsByProject[entryProjectId] || [] : []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "#4b6075", fontWeight: 700 }}>Subtask</span>
                        <select value={entrySubtaskId ?? ""} onChange={(e) => setEntrySubtaskId(e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Select subtask</option>
                          {((entryProjectId ? wbsByProject[entryProjectId] || [] : []).find((t) => t.id === entryTaskId)?.subtasks || []).map((s) => (
                            <option key={s.id} value={s.id}>
                              {formatWbsSubtaskLabel(s)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
                        <span style={{ fontSize: 11, color: "#4b6075", fontWeight: 700 }}>Hours</span>
                        <input value={entryHours} onChange={(e) => setEntryHours(e.target.value)} placeholder="0.00" />
                      </label>
                      <label style={{ display: "inline-flex", flexDirection: "column", gap: 4, minWidth: 180 }}>
                        <span style={{ fontSize: 11, color: "#4b6075", fontWeight: 700 }}>Notes</span>
                        <input value={entryNote} onChange={(e) => setEntryNote(e.target.value)} placeholder="Work note" />
                      </label>
                      <button onClick={copyPreviousDayEntries} disabled={editingEntryId !== null || !isOwnTimeEntryContext}>Copy Previous Day</button>
                      <button onClick={fillEntryToEightHours} disabled={editingEntryId !== null}>Fill to 8h</button>
                      <button onClick={saveSelectedDayEntry} disabled={isSavingTimeEntry || !isOwnTimeEntryContext}>
                        {isSavingTimeEntry ? "Saving..." : editingEntryId ? "Update Entry" : "Save Entry"}
                      </button>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "#4a6076" }}>
                      Day total: <strong>{selectedDayTotalHours.toFixed(2)}h</strong>
                      {!isOwnTimeEntryContext ? " | Save and copy actions are available only on your own timesheet." : ""}
                    </div>
                    <div style={{ marginTop: 16 }}>
                      <h4 style={{ margin: "0 0 8px 0" }}>Entries On {entryDate}</h4>
                      {selectedDayEntries.length === 0 && <p>No entries on this day yet.</p>}
                      {selectedDayEntries.map((entry) => (
                        <div key={entry.id} style={{ border: "1px solid #eee", padding: 8, marginBottom: 8 }}>
                          <div>
                            {entry.hours}h | {entry.project_name || `P${entry.project_id}`} / {entry.task_name || `T${entry.task_id}`} / {formatSubtaskLabelFromEntry(entry)}
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
            {canManageProjects && !lockToMyTimesheet && (
              <FreshbooksCsvImportPanel
                title="FreshBooks Time CSV Import"
                description="Upload a FreshBooks time export. Use preview first, then apply."
                onFileChange={setImportFile}
                apply={importApply}
                setApply={setImportApply}
                runLabelApply="Run Apply Import"
                runLabelPreview="Run Preview"
                onRun={runFreshbooksImport}
                mappingLabel="Mapping overrides (JSON):"
                mappingJson={importMappingJson}
                setMappingJson={setImportMappingJson}
                summary={importSummary}
              />
            )}
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

          {activeView === "timesheets" && timesheetSubView !== "analysis" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2 style={{ marginTop: 0 }}>{timesheetSubView === "team" ? "Team Timesheet Review" : timesheetSubView === "pending" ? "Pending Timesheet Queue" : "My Timesheet Review"}</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                Review uses the same calendar grid as time entry. Select period, confirm hours, then approve or return.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                {timesheetSubView === "mine" && (
                  <>
                    <button onClick={generateTimesheet}>Generate Current Week</button>
                    <select value={myTimesheetPeriodFilter} onChange={(e) => setMyTimesheetPeriodFilter(e.target.value)}>
                      <option value="">Select period</option>
                      {availableMyTimesheetPeriods.map((p) => (
                        <option key={`my-ts-period-${p}`} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {timesheetSubView === "team" && canApproveTimesheets && (
                  <>
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
                      }}
                    >
                      <option value="">Select employee</option>
                      {availableTimesheetUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.full_name || u.email}
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
                    <button onClick={generateTimesheetsForRange}>Generate In Range</button>
                  </>
                )}
                {timesheetSubView === "pending" && canApproveTimesheets && (
                  <>
                    <select
                      value={selectedPendingTimesheetId ?? ""}
                      onChange={(e) => setSelectedPendingTimesheetId(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">{pendingAdminTimesheets.length > 0 ? "Select submitted timesheet" : "No submitted timesheets"}</option>
                      {pendingAdminTimesheets.map((t) => (
                        <option key={`ts-pending-${t.id}`} value={t.id}>
                          {(t.user_full_name || t.user_email || `User ${t.user_id}`) + ` - ${t.week_start} to ${t.week_end}`}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{selectedReviewUserLabel}</strong>
                      {selectedReviewTimesheet ? (
                        <>
                          <span style={{ color: "#667" }}>
                            {selectedReviewTimesheet.week_start} to {selectedReviewTimesheet.week_end}
                          </span>
                          <span style={{ ...timesheetStatusStyle(selectedReviewTimesheet.status), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                            {selectedReviewTimesheet.status}
                          </span>
                          <strong>{Number(selectedReviewTimesheet.total_hours || 0).toFixed(2)} h</strong>
                          {selectedReviewTimesheet.status === "draft" && timesheetSubView === "mine" && ALLOW_TIMESHEET_SUBMIT && (
                            <button onClick={() => submitTimesheet(selectedReviewTimesheet.id)}>Submit</button>
                          )}
                          {timesheetSubView === "team" && canApproveTimesheets && (selectedReviewTimesheet.status === "draft" || selectedReviewTimesheet.status === "rejected") && (
                            <button onClick={() => submitTimesheetForEmployee(selectedReviewTimesheet.id)}>Submit for Employee</button>
                          )}
                          {canApproveTimesheets && (
                            <button
                              onClick={() => approveTimesheet(selectedReviewTimesheet.id)}
                              disabled={selectedReviewTimesheet.status !== "submitted"}
                              title={selectedReviewTimesheet.status !== "submitted" ? "Only submitted timesheets can be approved." : "Approve this timesheet"}
                            >
                              Approve
                            </button>
                          )}
                          {canApproveTimesheets && (
                            <button
                              onClick={() => returnTimesheet(selectedReviewTimesheet.id)}
                              disabled={selectedReviewTimesheet.status !== "submitted" && selectedReviewTimesheet.status !== "approved"}
                              title={selectedReviewTimesheet.status !== "submitted" && selectedReviewTimesheet.status !== "approved" ? "Only submitted or approved timesheets can be returned." : "Return this timesheet"}
                            >
                              Return
                            </button>
                          )}
                        </>
                      ) : (
                    <span style={{ color: "#667" }}>No timesheet selected</span>
                  )}
                </div>
              </div>
              {timesheetSubView === "team" && !timesheetUserFilter && <p>Select an employee to begin.</p>}
              {timesheetSubView === "team" && timesheetUserFilter && !timesheetPeriodFilter && <p>Select a period for the chosen employee.</p>}
              {timesheetSubView === "pending" && pendingAdminTimesheets.length === 0 && <p>No submitted timesheets are waiting for review.</p>}
              <div style={{ marginTop: 12, overflowX: "auto", border: "1px solid #c4cfdb", borderRadius: 6 }}>
                <table data-disable-table-sort="true" style={{ borderCollapse: "collapse", width: "100%", minWidth: Math.max(860, 360 + displayedGridDates.length * 84) }}>
                  <thead>
                    <tr style={{ background: "#f7f9fb" }}>
                      <th style={{ borderBottom: "1px solid #c4cfdb", borderRight: "1px solid #d7dfe8", textAlign: "left", padding: 8 }}>Project / Task</th>
                      {displayedGridDates.map((day) => (
                        <th key={`ts-review-head-${day}`} style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "center", padding: 8, minWidth: 92, background: "#f4f7fa" }}>
                          {dayLabelFromYmd(day)}
                        </th>
                      ))}
                      <th style={{ borderBottom: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", textAlign: "right", padding: 8 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeGridRows.length === 0 && (
                      <tr>
                        <td colSpan={displayedGridDates.length + 2} style={{ padding: 10, color: "#666" }}>
                          No time entries in this period.
                        </td>
                      </tr>
                    )}
                    {timeGridRows.map((row) => {
                      const rowDisplayedTotal = displayedGridDates.reduce((sum, day) => sum + Number(row.byDay[day] || 0), 0);
                      return (
                        <tr key={`ts-review-grid-row-${row.key}`}>
                          <td style={{ borderBottom: "1px solid #dce4ed", borderRight: "1px solid #edf2f6", padding: 8, fontSize: 12 }}>
                            <div style={{ fontWeight: 600 }}>{row.projectLabel}</div>
                            <div style={{ fontSize: 11, color: "#667a90", marginTop: 2 }}>
                              {row.taskLabel}{row.subtaskLabel ? ` • ${row.subtaskLabel}` : ""}
                            </div>
                          </td>
                          {displayedGridDates.map((day) => (
                            <td key={`ts-review-grid-cell-${row.key}-${day}`} style={{ borderBottom: "1px solid #dce4ed", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "center", background: row.byDay[day] ? "#fbfdff" : "#fff" }}>
                              {row.byDay[day] ? (
                                <div style={{ display: "grid", gap: 2, justifyItems: "center" }}>
                                  <strong style={{ fontSize: 12 }}>{row.byDay[day].toFixed(2)}</strong>
                                  {(row.byDayNotes[day] || [])[0] && (
                                    <span style={{ fontSize: 10, color: "#567", maxWidth: 78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {(row.byDayNotes[day] || [])[0]}
                                    </span>
                                  )}
                                </div>
                              ) : ""}
                            </td>
                          ))}
                          <td style={{ borderBottom: "1px solid #dce4ed", borderLeft: "1px solid #edf2f6", padding: 8, textAlign: "right", fontWeight: 700 }}>
                            {rowDisplayedTotal.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#fafbfd" }}>
                      <td style={{ borderTop: "1px solid #c4cfdb", padding: 8, fontWeight: 700 }}>Period Totals</td>
                      {displayedGridDates.map((day) => (
                        <td key={`ts-review-grid-total-${day}`} style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "center", fontWeight: 700 }}>
                          {Number(timeGridDayTotals[day] || 0).toFixed(2)}
                        </td>
                      ))}
                      <td style={{ borderTop: "1px solid #c4cfdb", borderLeft: "1px solid #d7dfe8", padding: 8, textAlign: "right", fontWeight: 700 }}>
                        {displayedGridDates.reduce((sum, d) => sum + Number(timeGridDayTotals[d] || 0), 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {timesheetSubView === "mine" && (
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10 }}>
                  <div style={{ border: "1px solid #eee", padding: 10 }}>Weeks<br /><strong>{myTimesheetSummary.total}</strong></div>
                  <div style={{ border: "1px solid #eee", padding: 10 }}>Hours<br /><strong>{myTimesheetSummary.hours.toFixed(2)}</strong></div>
                  <div style={{ border: "1px solid #eee", padding: 10 }}>Submitted<br /><strong>{myTimesheetSummary.submitted}</strong></div>
                  <div style={{ border: "1px solid #eee", padding: 10 }}>Approved<br /><strong>{myTimesheetSummary.approved}</strong></div>
                </div>
              )}
            </section>
          )}

          {activeView === "timesheets" && timesheetSubView === "analysis" && (
            <section style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
              <h2 style={{ marginTop: 0 }}>Timesheet Analysis</h2>
              <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                Analyze loaded time by employee, project, or task for the selected period.
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
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
                <strong style={{ marginLeft: 12 }}>Group by:</strong>
                <select value={timesheetAnalysisDimension} onChange={(e) => setTimesheetAnalysisDimension(e.target.value as "employee" | "project" | "task")}>
                  <option value="employee">Employee</option>
                  <option value="project">Project</option>
                  <option value="task">Task</option>
                </select>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Group</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Entries</th>
                      <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timesheetAnalysisRows.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ borderBottom: "1px solid #eee", padding: 6, color: "#666" }}>
                          No rows for the selected period.
                        </td>
                      </tr>
                    )}
                    {timesheetAnalysisRows.map((row) => (
                      <tr key={`ts-analysis-${row.label}`}>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{row.label}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{row.entries}</td>
                        <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right", fontWeight: 700 }}>{row.hours.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td style={{ borderTop: "2px solid #ddd", padding: 6, fontWeight: 700 }}>Totals</td>
                      <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}>
                        {timesheetAnalysisRows.reduce((sum, row) => sum + row.entries, 0)}
                      </td>
                      <td style={{ borderTop: "2px solid #ddd", padding: 6, textAlign: "right", fontWeight: 700 }}>
                        {timesheetAnalysisRows.reduce((sum, row) => sum + row.hours, 0).toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}

          {canViewFinancials && activeView === "projects" && projectSubView === "performance" && (
            <section className="aq-performance-compact" style={{ border: "1px solid #ddd", padding: 16, marginBottom: 16 }}>
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
              {projectPerformance.length === 0 && <p>No performance rows returned for the selected period.</p>}
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
                        <div style={{ color: selectedPerformanceProject.target_margin_gap_pct >= 0 ? "#1f3f60" : "#b00020", marginBottom: 8 }}>
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
                        {
                          key: "emp",
                          title: "By Employee",
                          rows: selectedPerformanceProject.by_employee.map((r) => ({
                            label: r.name || r.email,
                            hours: r.hours,
                            revenue: r.revenue,
                            cost: r.cost,
                            profit: r.profit,
                          })),
                        },
                        {
                          key: "task",
                          title: "By Task",
                          rows: selectedPerformanceProject.by_task.map((r) => ({
                            label: r.task_name || `Task ${r.task_id}`,
                            hours: r.hours,
                            revenue: r.revenue,
                            cost: r.cost,
                            profit: r.profit,
                          })),
                        },
                        {
                          key: "sub",
                          title: "By Subtask",
                          rows: selectedPerformanceProject.by_subtask.map((r) => ({
                            label: `${r.subtask_code} ${r.subtask_name}`.trim() || `Subtask ${r.subtask_id}`,
                            hours: r.hours,
                            revenue: r.revenue,
                            cost: r.cost,
                            profit: r.profit,
                          })),
                        },
                      ].map((section) => {
                        const sectionKey = `${selectedPerformanceProject.project_id}-${section.key}`;
                        const expanded = !!performanceExpanded[sectionKey];
                        const selectedMetric = performancePieMetric[sectionKey] || "hours";
                        const piePalette = ["#2f4f73", "#f3a35f", "#8db68b", "#6a8caf", "#d36f6f"];
                        const buildPie = (metric: "hours" | "revenue" | "profit") =>
                          section.rows
                            .slice()
                            .map((row) => ({
                              ...row,
                              metricValue: metric === "profit" ? Math.max(0, row.profit) : row[metric],
                            }))
                            .sort((a, b) => b.metricValue - a.metricValue)
                            .slice(0, 5)
                            .map((row, idx) => ({
                              label: row.label,
                              value: row.metricValue,
                              color: piePalette[idx % piePalette.length],
                            }));
                        const pieSlices = buildPie(selectedMetric);
                        const pieTitle = selectedMetric === "hours" ? "Hours Mix" : selectedMetric === "revenue" ? "Revenue Mix" : "Profit Mix";
                        const pieValueMode = selectedMetric === "hours" ? "hours" : "currency";
                        return (
                          <div key={`perf-section-${sectionKey}`} style={{ marginTop: 10, borderTop: "1px solid #f2f2f2", paddingTop: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <strong>{section.title}</strong>
                              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                {expanded && (
                                  <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <input
                                        type="radio"
                                        name={`metric-${sectionKey}`}
                                        checked={selectedMetric === "hours"}
                                        onChange={() => setPerformancePieMetric((prev) => ({ ...prev, [sectionKey]: "hours" }))}
                                      />
                                      Hours
                                    </label>
                                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <input
                                        type="radio"
                                        name={`metric-${sectionKey}`}
                                        checked={selectedMetric === "revenue"}
                                        onChange={() => setPerformancePieMetric((prev) => ({ ...prev, [sectionKey]: "revenue" }))}
                                      />
                                      Revenue
                                    </label>
                                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <input
                                        type="radio"
                                        name={`metric-${sectionKey}`}
                                        checked={selectedMetric === "profit"}
                                        onChange={() => setPerformancePieMetric((prev) => ({ ...prev, [sectionKey]: "profit" }))}
                                      />
                                      Profit
                                    </label>
                                  </div>
                                )}
                                <button onClick={() => setPerformanceExpanded((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }))}>
                                  {expanded ? "-" : "+"}
                                </button>
                              </div>
                            </div>
                            {expanded && (
                              <div style={{ marginTop: 6 }}>
                                {section.rows.length === 0 && <div>No data</div>}
                                {section.rows.length > 0 && (
                                  <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) 1fr", gap: 12, alignItems: "start" }}>
                                    <div style={{ border: "1px solid #eef3f8", borderRadius: 8, padding: 8, background: "#fbfdff" }}>
                                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{pieTitle}</div>
                                      <MiniLabeledPie slices={pieSlices} size={104} valueMode={pieValueMode} />
                                    </div>
                                    <div>
                                      <div
                                        style={{
                                          display: "grid",
                                          gridTemplateColumns: "minmax(220px, 1fr) 92px 120px 120px 120px",
                                          gap: 8,
                                          fontSize: 12,
                                          fontWeight: 600,
                                          color: "#2f4860",
                                          padding: "6px 8px",
                                          borderBottom: "1px solid #dfe8f1",
                                          background: "#f5f9fd",
                                          borderTopLeftRadius: 6,
                                          borderTopRightRadius: 6,
                                        }}
                                      >
                                        <span>{section.title.replace("By ", "")}</span>
                                        <span style={{ textAlign: "right" }}>Hours</span>
                                        <span style={{ textAlign: "right" }}>Revenue</span>
                                        <span style={{ textAlign: "right" }}>Cost</span>
                                        <span style={{ textAlign: "right" }}>Profit</span>
                                      </div>
                                      {section.rows.map((row, idx) => (
                                        <div
                                          key={`perf-row-${sectionKey}-${idx}`}
                                          style={{
                                            display: "grid",
                                            gridTemplateColumns: "minmax(220px, 1fr) 92px 120px 120px 120px",
                                            gap: 8,
                                            alignItems: "center",
                                            fontSize: 12.5,
                                            color: "#1f2f3f",
                                            padding: "7px 8px",
                                            borderBottom: "1px solid #eef3f8",
                                            background: idx % 2 === 0 ? "#ffffff" : "#fbfdff",
                                          }}
                                        >
                                          <span style={{ fontWeight: 600 }}>{row.label}</span>
                                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.hours.toFixed(2)}h</span>
                                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(row.revenue)}</span>
                                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(row.cost)}</span>
                                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: row.profit < 0 ? "#b00020" : "#1f3f60" }}>
                                            {formatCurrency(row.profit)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
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
                  {projects.length === 0 && <option value="">No active project options</option>}
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
                end_date: p.end_date || "",
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
                  <div style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(2, minmax(220px, 1fr))", gap: 10 }}>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Project Start Date</span>
                      <input
                        type="date"
                        value={pd.start_date}
                        onChange={(e) => setProjectDraft(p.id, { start_date: e.target.value })}
                        onFocus={(e) => showNativeDatePicker(e.currentTarget)}
                        onClick={(e) => showNativeDatePicker(e.currentTarget)}
                      />
                    </label>
                    <label style={{ display: "inline-flex", flexDirection: "column" }}>
                      <span>Project Target End Date</span>
                      <input
                        type="date"
                        value={pd.end_date}
                        onChange={(e) => setProjectDraft(p.id, { end_date: e.target.value })}
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
                    <div style={{ marginTop: 6, fontSize: 12, color: "#7a4f00" }}>
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

          {isAccountingView && accountingSubView === "workspace" && (
            <section style={{ border: "1px solid #ddd", padding: 16 }}>
              <h2>{activeView === "invoices" ? "Invoices" : activeView === "payments" ? "Payments" : activeView === "expenses" ? "Expenses" : "Accounting"}</h2>
              <p>
                {activeView === "invoices" && "Create invoices, review billing lines, and manage invoice status."}
                {activeView === "payments" && "Track payment links, payment status updates, and account receivables."}
                {activeView === "expenses" && "Monitor project expenses, profitability impact, and recurring financial controls."}
                {activeView === "accounting" && "Use this area for invoicing, recurring billing setup, invoice continuity imports, and A/R tracking."}
              </p>
              {!canViewFinancials && (activeView === "invoices" || activeView === "payments" || activeView === "expenses" || activeView === "accounting") && (
                <div style={{ border: "1px solid #f2c7b8", background: "#fff1eb", color: "#8a3a2a", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  Financial workspaces are restricted for this user. Sign in as an admin/manager account with financial access.
                </div>
              )}
              {activeView === "accounting" && (
                <div style={{ border: "1px solid #d8e2ed", background: "#f7fafd", borderRadius: 10, padding: 12, marginBottom: 10 }}>
                  Select a submenu from the left navigation to open Invoices, Payments, or Expenses details.
                  <BankFeedQuickActions
                    isPlaidConnecting={isPlaidConnecting}
                    onConnectPlaidLink={connectPlaidLink}
                    onConnectPlaidSandbox={connectPlaidSandbox}
                    onImportExpenseCatBusiness={() => selectExpenseCatCategorizedCsv(true)}
                    showImportExpenseCat={showEmergencyCsvImport}
                    onRefreshBankFeed={refreshBankWorkspaceData}
                    showIncludePersonalToggle
                    includePersonal={bankQueueIncludePersonal}
                    onToggleIncludePersonal={(checked) => {
                      setBankQueueOffset(0);
                      setBankQueueIncludePersonal(checked);
                    }}
                  />
                </div>
              )}
              {showExpenseCostControls && (
                <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <h3 style={{ marginTop: 0 }}>Expense Cost Controls</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10, marginBottom: 10 }}>
                    <div style={{ border: "1px solid #eee", padding: 8 }}>Total Cost (PTD)<br /><strong><Currency value={dashboardStats.cost} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 8 }}>Revenue (PTD)<br /><strong><Currency value={dashboardStats.revenue} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 8 }}>Profit (PTD)<br /><strong><Currency value={dashboardStats.profit} digits={0} /></strong></div>
                    <div style={{ border: "1px solid #eee", padding: 8 }}>At-Risk Projects<br /><strong>{dashboardAtRiskProjects.length}</strong></div>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Project</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Revenue</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Cost</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Profit</th>
                          <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectPerformance.map((p) => (
                          <tr key={`exp-ctrl-${p.project_id}`}>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{p.project_name}</td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_revenue} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_cost} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={p.actual_profit} /></td>
                            <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}>{p.margin_pct.toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {canViewFinancials && isAccountingView && (
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
                      <option value="">Select project</option>
                      {projects.map((p) => (
                        <option key={`inv-proj-${p.id}`} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <select value={invoiceDraftTemplateId} onChange={(e) => setInvoiceDraftTemplateId(e.target.value as InvoiceTemplateId)}>
                      <option value="default">{aquatechTemplateConfig.label}</option>
                      <option value="hdr">HDR</option>
                      <option value="stantec_bc">Stantec + Brown & Caldwell</option>
                    </select>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input type="checkbox" checked={invoiceApprovedOnly} onChange={(e) => setInvoiceApprovedOnly(e.target.checked)} />
                      Approved timesheets only
                    </label>
                    <button onClick={refreshInvoicePreview}>Refresh Preview</button>
                    <button onClick={createInvoiceFromPeriod}>Create Draft Invoice</button>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    {!invoiceProjectId && (
                      <div style={{ marginBottom: 8, color: "#8a5a00", fontSize: 13 }}>
                        Select a project to preview/create invoice lines with the correct project-specific rates.
                      </div>
                    )}
                    <div style={{ marginBottom: 8, color: "#2f4860", fontSize: 13 }}>
                      Selected template for new invoice: <strong>{invoiceDraftTemplateLabel}</strong>
                    </div>
                    <textarea
                      value={invoiceNotes}
                      onChange={(e) => setInvoiceNotes(e.target.value)}
                      rows={2}
                      placeholder="Invoice notes / payment terms"
                      style={{ width: "100%" }}
                    />
                  </div>
                  {invoicePreview && (
                    <div style={{ border: "1px solid #dbe4ee", borderRadius: 10, padding: 12, marginBottom: 12, background: "linear-gradient(180deg,#fff,#f4f8fc)" }}>
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
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>Lines<br /><strong>{invoicePreview.line_count}</strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>Hours<br /><strong>{invoicePreview.total_hours.toFixed(2)}</strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>Subtotal<br /><strong><Currency value={invoicePreview.subtotal_amount} /></strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>Profit<br /><strong><Currency value={invoicePreview.total_profit} /></strong></div>
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
                    const template = invoiceTemplateMeta(selectedInvoice, selectedInvoiceTemplateId, aquatechTemplateConfig);
                    return (
                  <div style={{ position: "absolute", inset: "2% 2%", background: "#fff", borderRadius: 10, overflow: "hidden", display: "grid", gridTemplateRows: "auto auto 1fr auto" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #e6e6e6" }}>
                      <div style={{ fontWeight: 700, fontSize: 18 }}>Invoice {selectedInvoice.invoice_number} <span style={{ fontWeight: 500, color: "#4a4a4a", fontSize: 13 }}>({template.label} template)</span></div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <select
                          value={selectedInvoiceTemplateId}
                          onChange={(e) =>
                            setInvoiceTemplateById((prev) => ({
                              ...prev,
                              [selectedInvoice.id]: e.target.value as InvoiceTemplateId,
                            }))
                          }
                        >
                          <option value="default">{aquatechTemplateConfig.label}</option>
                          <option value="hdr">HDR</option>
                          <option value="stantec_bc">Stantec + Brown & Caldwell</option>
                        </select>
                        <button onClick={() => downloadInvoicePdf(selectedInvoice, selectedInvoiceTemplateId)}>Download PDF</button>
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
                                    <tr key={`appendix-entry-${e.time_entry_id}`} style={e.is_invoiced ? { background: "#fff2e8", boxShadow: "inset 0 0 0 2px #c97c3d" } : undefined}>
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
                      <span>Balance <strong><Currency value={invoiceOutstandingBalance(selectedInvoice)} /></strong></span>
                    </div>
                  </div>
                    );
                  })()}
                </div>
              )}

                  {showSavedInvoices && (
                  <div style={{ borderTop: "1px solid #eee", paddingTop: 10 }}>
                    <h4 style={{ marginTop: 0 }}>Saved Invoices</h4>
                    {activeView === "invoices" && (
                      <div style={{ border: "1px solid #f0d9bf", background: "#fff9f2", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, marginBottom: 6 }}>Client Label Reconciliation</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            value={invoiceClientReconcileName}
                            onChange={(e) => setInvoiceClientReconcileName(e.target.value)}
                            placeholder={suggestedReconcileClient || "Enter real client name"}
                            style={{ minWidth: 280 }}
                          />
                          <button onClick={reconcileLegacyImportedClients}>Reconcile Imported/Legacy Client</button>
                          <span style={{ color: "#6f4f1b", fontSize: 12 }}>
                            Replaces client labels `Imported Client` and `Legacy Client` in invoices and projects.
                          </span>
                        </div>
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(160px, 1fr))", gap: 8, marginBottom: 10 }}>
                      <div style={{ border: "1px solid #dbe6d5", background: "#f6fbf4", padding: 8 }}>
                        Paid to Date<br /><strong><Currency value={invoiceStatusOverview.paidToDate} /></strong>
                      </div>
                      <div style={{ border: "1px solid #f1dcc2", background: "#fff8ef", padding: 8 }}>
                        Sent &amp; Unpaid<br /><strong><Currency value={invoiceStatusOverview.sentUnpaidAmount} /></strong>
                        <div style={{ fontSize: 12, color: "#6c4b1f" }}>{invoiceStatusOverview.sentUnpaidCount} invoices</div>
                      </div>
                      <div style={{ border: "1px solid #d6e3f1", background: "#f3f8fe", padding: 8 }}>
                        Unbilled<br /><strong><Currency value={invoiceStatusOverview.unbilledAmount} /></strong>
                        <div style={{ fontSize: 12, color: "#35506e" }}>Since project last invoice date</div>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(120px, 1fr))", gap: 8, marginBottom: 10 }}>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Invoices<br /><strong>{paymentStatusTotals.invoiceCount}</strong></div>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Open<br /><strong>{paymentStatusTotals.openCount}</strong></div>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue<br /><strong>{paymentStatusTotals.overdueCount}</strong></div>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Invoiced<br /><strong><Currency value={paymentStatusTotals.totalInvoiced} /></strong></div>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Paid<br /><strong><Currency value={paymentStatusTotals.totalPaid} /></strong></div>
                      <div style={{ border: "1px solid #eee", padding: 8 }}>Outstanding<br /><strong><Currency value={paymentStatusTotals.totalOutstanding} /></strong></div>
                    </div>
                    {savedInvoices.length > 0 && (
                      <div style={{ overflowX: "auto", marginBottom: 10 }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                          <thead>
                            <tr>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Invoice #</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Issue</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Due</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Invoice</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Paid</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {savedInvoices.map((inv) => {
                              const isSelected = inv.id === invoiceSelectedId;
                              const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
                              const overdue = effectiveStatus === "overdue";
                              return (
                                <tr
                                  key={`pay-status-row-${inv.id}`}
                                  onClick={() => setInvoiceSelectedId(inv.id)}
                                  style={{
                                    cursor: "pointer",
                                    background: isSelected ? "#eef6ff" : overdue ? "#fff6f6" : "transparent",
                                  }}
                                >
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.invoice_number}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.client_name}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.issue_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.due_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                    <span style={{ ...invoiceStatusStyle(effectiveStatus), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                                      {titleCaseWord(effectiveStatus)}
                                    </span>
                                  </td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.subtotal_amount || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.amount_paid || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={invoiceOutstandingBalance(inv)} /></td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
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
                              <span style={{ ...invoiceStatusStyle(effectiveInvoiceStatus(selectedInvoice, todayYmd)), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                                {titleCaseWord(effectiveInvoiceStatus(selectedInvoice, todayYmd))}
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
                          <button onClick={() => downloadInvoicePdf(selectedInvoice, selectedInvoiceTemplateId)}>Download PDF</button>
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
                  )}

                  {showRecurringSchedules && (
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
                  )}

                  {showInvoiceTemplates && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>Invoice Templates</h4>
                    <p style={{ marginTop: 4, color: "#4a4a4a" }}>
                      Configure your default Aquatech invoice template and choose a template in Invoice Studio before creating a draft.
                    </p>
                    <div style={{ border: "1px solid #e6edf5", borderRadius: 8, padding: 10, background: "#f8fbff", marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Default Aquatech Template</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(240px, 1fr))", gap: 8 }}>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Template Name</span>
                          <input value={aquatechTemplateLabel} onChange={(e) => setAquatechTemplateLabel(e.target.value)} placeholder="Aquatech Generic" />
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Period Label</span>
                          <input value={aquatechTemplatePeriodLabel} onChange={(e) => setAquatechTemplatePeriodLabel(e.target.value)} placeholder="Professional Services for the Period" />
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Bill To Lines (one per line)</span>
                          <textarea value={aquatechTemplateBillToText} onChange={(e) => setAquatechTemplateBillToText(e.target.value)} rows={5} />
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Reference Lines (`Label: Value` per line)</span>
                          <textarea value={aquatechTemplateReferencesText} onChange={(e) => setAquatechTemplateReferencesText(e.target.value)} rows={5} />
                        </label>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, color: "#2f4860" }}>
                        Saved automatically for this browser. Use Invoice Studio to apply this template to new invoices.
                      </div>
                    </div>
                    <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Available Templates</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        <li>{aquatechTemplateConfig.label} (default Aquatech)</li>
                        <li>HDR</li>
                        <li>Stantec + Brown & Caldwell</li>
                      </ul>
                    </div>
                  </div>
                  )}

                  {showLegacyImport && (
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
                    <div style={{ marginTop: 10, overflowX: "auto" }}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>Legacy Imported Invoices</div>
                      <table style={{ borderCollapse: "collapse", width: "100%" }}>
                        <thead>
                          <tr>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Invoice #</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Issue</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Due</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Invoice</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Paid</th>
                            <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {savedInvoices
                            .filter((inv) => {
                              const src = String(inv.source || "").toLowerCase();
                              return src.includes("legacy") || src.includes("freshbooks");
                            })
                            .slice(0, 200)
                            .map((inv) => {
                              const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
                              return (
                                <tr key={`legacy-inv-row-${inv.id}`}>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.invoice_number}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.client_name}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.issue_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.due_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                    <span style={{ ...invoiceStatusStyle(effectiveStatus), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                                      {titleCaseWord(effectiveStatus)}
                                    </span>
                                  </td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.subtotal_amount || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.amount_paid || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={invoiceOutstandingBalance(inv)} /></td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  )}

                  {showArDashboard && (
                  <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>A/R Dashboard</h4>
                    <p style={{ marginTop: 4, color: "#4a4a4a", fontSize: 12 }}>
                      A/R aging is calculated from saved invoice balances and recorded payments received.
                    </p>
                    {effectiveArSummary ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(130px, 1fr))", gap: 10, marginBottom: 10 }}>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Open Invoices<br /><strong>{effectiveArSummary.invoice_count_open}</strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Outstanding<br /><strong><Currency value={effectiveArSummary.total_outstanding} /></strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue Count<br /><strong>{effectiveArSummary.overdue_invoice_count}</strong></div>
                          <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue Amount<br /><strong><Currency value={effectiveArSummary.overdue_total} /></strong></div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 8, marginBottom: 10 }}>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>Current<br /><strong><Currency value={effectiveArSummary.aging.current} /></strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>1-30<br /><strong><Currency value={effectiveArSummary.aging["1_30"]} /></strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>31-60<br /><strong><Currency value={effectiveArSummary.aging["31_60"]} /></strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>61-90<br /><strong><Currency value={effectiveArSummary.aging["61_90"]} /></strong></div>
                          <div style={{ border: "1px solid #e9eff5", padding: 8 }}>90+<br /><strong><Currency value={effectiveArSummary.aging["90_plus"]} /></strong></div>
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
                              {effectiveArSummary.top_clients.map((r) => (
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
                  )}
                </div>
              )}
              {canViewFinancials && showReconciliation && (
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
              {showPaymentsImport && (
                <>
                  {showPaymentStatusWorkspace && (
                    <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                      <h4 style={{ marginTop: 0 }}>Payment Status</h4>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(110px, 1fr))", gap: 8, marginBottom: 10 }}>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Filtered Invoices<br /><strong>{paymentFilteredTotals.rows}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Paid<br /><strong>{paymentFilteredTotals.paidCount}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Partial<br /><strong>{paymentFilteredTotals.partialCount}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Overdue<br /><strong>{paymentFilteredTotals.overdueCount}</strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Invoiced<br /><strong><Currency value={paymentFilteredTotals.invoiced} /></strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Paid Amount<br /><strong><Currency value={paymentFilteredTotals.paidAmount} /></strong></div>
                        <div style={{ border: "1px solid #eee", padding: 8 }}>Outstanding<br /><strong><Currency value={paymentFilteredTotals.outstanding} /></strong></div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 8, marginBottom: 10 }}>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Status</span>
                          <select value={paymentStatusFilter} onChange={(e) => setPaymentStatusFilter(e.target.value)}>
                            <option value="all">All statuses</option>
                            <option value="paid">Paid</option>
                            <option value="partial">Partially Paid</option>
                            <option value="overdue">Overdue</option>
                            <option value="sent">Sent</option>
                            <option value="draft">Draft</option>
                            <option value="void">Void</option>
                          </select>
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Client</span>
                          <select value={paymentClientFilter} onChange={(e) => setPaymentClientFilter(e.target.value)}>
                            <option value="all">All clients</option>
                            {paymentClientOptions.map((client) => (
                              <option key={`payment-client-filter-${client}`} value={client}>
                                {client}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ display: "grid", gap: 4 }}>
                          <span style={{ fontSize: 12, color: "#4a4a4a" }}>Period</span>
                          <select value={paymentPeriodFilter} onChange={(e) => setPaymentPeriodFilter(e.target.value as "all" | "last30" | "this_month" | "this_quarter" | "this_year")}>
                            <option value="all">All time</option>
                            <option value="last30">Last 30 days</option>
                            <option value="this_month">This month</option>
                            <option value="this_quarter">This quarter</option>
                            <option value="this_year">This year</option>
                          </select>
                        </label>
                      </div>
                      <div style={{ overflowX: "auto", marginBottom: 10 }}>
                        <table style={{ borderCollapse: "collapse", width: "100%" }}>
                          <thead>
                            <tr>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Invoice #</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Client</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Issue</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Due</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "left", padding: 6 }}>Status</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Invoice</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Paid</th>
                              <th style={{ borderBottom: "1px solid #ddd", textAlign: "right", padding: 6 }}>Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paymentRows.map((inv) => {
                              const isSelected = inv.id === invoiceSelectedId;
                              const effectiveStatus = effectiveInvoiceStatus(inv, todayYmd);
                              const overdue = effectiveStatus === "overdue";
                              return (
                                <tr
                                  key={`pay-status-workspace-row-${inv.id}`}
                                  onClick={() => setInvoiceSelectedId(inv.id)}
                                  style={{
                                    cursor: "pointer",
                                    background: isSelected ? "#eef6ff" : overdue ? "#fff6f6" : "transparent",
                                  }}
                                >
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.invoice_number}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.client_name}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.issue_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{inv.due_date}</td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>
                                    <span style={{ ...invoiceStatusStyle(effectiveStatus), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                                      {titleCaseWord(effectiveStatus)}
                                    </span>
                                  </td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.subtotal_amount || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={Number(inv.amount_paid || 0)} /></td>
                                  <td style={{ borderBottom: "1px solid #eee", padding: 6, textAlign: "right" }}><Currency value={invoiceOutstandingBalance(inv)} /></td>
                                </tr>
                              );
                            })}
                            {paymentRows.length === 0 && (
                              <tr>
                                <td colSpan={8} style={{ borderBottom: "1px solid #eee", padding: 10, color: "#666", textAlign: "center" }}>
                                  No invoices match the selected filters.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  <FreshbooksCsvImportPanel
                    title="FreshBooks Payments CSV Import"
                    description="Upload the FreshBooks payments_collected CSV. This updates paid-to-date and balances by invoice number."
                    onFileChange={setPaymentImportFile}
                    apply={paymentImportApply}
                    setApply={setPaymentImportApply}
                    runLabelApply="Import Payments"
                    runLabelPreview="Preview Payments Import"
                    onRun={runFreshbooksPaymentImport}
                    mappingLabel="Payment mapping overrides (JSON):"
                    mappingJson={paymentImportMappingJson}
                    setMappingJson={setPaymentImportMappingJson}
                    summary={paymentImportSummary}
                  />
                </>
              )}
            </section>
          )}
          </div>
        </div>
      )}
    </main>
  );
}
