"use client";

export type User = {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  permissions: string[];
};

export type ProjectLifecycleStatus =
  | "planning"
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export type Project = {
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
  lifecycle_status?: ProjectLifecycleStatus;
  completed_date?: string | null;
};

export type Subtask = {
  id: number;
  code: string;
  name: string;
  budget_hours: number;
  budget_fee: number;
};

export type Task = {
  id: number;
  name: string;
  is_billable: boolean;
  subtasks: Subtask[];
};

export type ProjectWbs = {
  tasks: Task[];
};

export type TimeEntry = {
  id: number;
  user_id: number;
  project_id: number;
  task_id: number;
  subtask_id: number;
  project_name?: string | null;
  task_name?: string | null;
  subtask_name?: string | null;
  user_full_name?: string | null;
  user_email?: string | null;
  work_date: string;
  hours: number;
  note: string;
  bill_rate_applied: number;
  cost_rate_applied: number;
};

export type Timesheet = {
  id: number | null;
  user_id: number;
  week_start: string;
  week_end: string;
  status: string;
  total_hours: number;
  employee_signed_at?: string | null;
  supervisor_signed_at?: string | null;
};

export type AdminTimesheet = Timesheet & {
  user_email: string;
  user_full_name: string;
  has_record: boolean;
};

export type Invoice = {
  id: number;
  invoice_number: string;
  status: string;
  client_name: string;
  issue_date: string;
  due_date: string;
  subtotal_amount: number;
  amount_paid: number;
  balance_due: number;
  financed_pct?: number;   // 0 = not financed; 0.70 = 70% advanced by financier
  financed_source?: string;
  project_id: number | null;
  line_count: number;
};

export type InvoicePreview = {
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
};

export type ProjectPerformanceRow = {
  project_id: number;
  project_name: string;
  overall_budget_fee: number;
  actual_revenue: number;
  actual_cost: number;
  actual_profit: number;
  margin_pct: number;
  target_gross_margin_pct: number;
  budget_fee: number;
};

export type ProjectPerformanceResponse = {
  start: string;
  end: string;
  projects: ProjectPerformanceRow[];
};

export type ProjectPerformanceRange = {
  start: string;
  end: string;
  has_data: boolean;
};

export type CompRecon = {
  period: { start: string; end: string };
  rows: Array<{
    name: string; billable: number; nonbillable: number; total_hours: number;
    rate: number; earned: number; paid: number; gap: number;
  }>;
  total_earned: number; total_paid: number; total_gap: number;
};

export type CashFlow = {
  period: { start: string; end: string };
  operating: { cash_in_invoices: number; cash_out_opex?: number; cash_out_payroll?: number; cash_out_opex_and_payroll: number; net: number };
  financing: { loan_proceeds_boc: number; loan_proceeds_fundbox: number; loan_payments_total: number; net: number };
  owner: { contributions_in: number; distributions_out: number; net: number };
  net_change_in_cash: number;
};

export type InvoiceRevenueStatus = {
  invoiced_period?: number;
  collected_period?: number;
  boc_financed_advances?: number;
  outstanding_net_of_boc?: number;
  period?: { start: string; end: string };
  total_invoiced: number;
  total_paid_to_date: number;
  total_outstanding: number;
  overdue_total: number;
  earned_not_billed_total: number;
  invoice_count_open: number;
  overdue_invoice_count: number;
  top_clients: Array<{
    client_name: string;
    invoice_count: number;
    outstanding: number;
    overdue: number;
  }>;
};

export type PayableItem = {
  entity: string;
  label: string;
  amount: number;
  description: string;
  category: "financing" | "credit_card" | "salary";
};

export type AccountsPayable = {
  as_of: string;
  items: PayableItem[];
  total: number;
  total_financing: number;
  total_salary: number;
};

export type UnbilledEmployeeRow = {
  user_id: number;
  name: string;
  email: string;
  hours: number;
  value?: number;
};

export type UnbilledProjectRow = {
  project_id: number;
  project_name: string;
  client_name: string;
  hours: number;
  value?: number;
};

export type UnbilledHoursReport = {
  as_of: string;
  billable: {
    totals: { hours: number; value: number };
    by_employee: UnbilledEmployeeRow[];
    by_project: UnbilledProjectRow[];
  };
  non_billable: {
    current_month: {
      period_start: string;
      period_end: string;
      label: string;
      totals: { hours: number };
      by_employee: UnbilledEmployeeRow[];
      by_project: UnbilledProjectRow[];
    };
    ytd: {
      period_start: string;
      period_end: string;
      label: string;
      totals: { hours: number };
      by_employee: UnbilledEmployeeRow[];
      by_project: UnbilledProjectRow[];
    };
  };
};

export type ProjectExpense = {
  id: number;
  project_id: number;
  expense_date: string;
  category: string;
  description: string;
  amount: number;
};

export type BankCategorySummaryRow = {
  expense_group: string;
  category: string;
  transaction_count: number;
  amount_abs: number;
};

export type BankExpenseSummaryRow = {
  dimension: string;
  label: string;
  transaction_count: number;
  amount_abs: number;
};

export type FreshBooksInboxFile = {
  name: string;
  path: string;
  category: string;
  size_bytes: number;
  modified_at: string;
  sha1_prefix: string;
  duplicate_of: string | null;
  recommended_use: boolean;
  reason: string;
};

export type FreshBooksInbox = {
  root_path: string;
  exists: boolean;
  file_count: number;
  files: FreshBooksInboxFile[];
};

export type FreshBooksTransitionStep = {
  step: string;
  ok: boolean;
  used_files: string[];
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  detail: Record<string, unknown>;
};

export type FreshBooksTransitionRun = {
  apply: boolean;
  root_path: string;
  steps: FreshBooksTransitionStep[];
  totals: Record<string, number>;
};

export type ClientRollup = {
  name: string;
  projectCount: number;
  activeProjectCount: number;
  billedRevenue: number;
  outstandingRevenue: number;
};

export function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    value ?? 0,
  );
}

export function formatNumber(value: number | null | undefined, digits = 1) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value ?? 0);
}

export function formatPercent(value: number | null | undefined) {
  return `${formatNumber(value ?? 0, 1)}%`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
