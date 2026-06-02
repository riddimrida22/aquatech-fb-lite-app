"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { deriveUserCapabilities } from "../lib/permissions";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { TimeWorkspace } from "./components/TimeWorkspace";
import { WeeklyTimeEntry } from "./components/WeeklyTimeEntry";
import { Toast } from "./components/Toast";
import { StatusBadge } from "./components/StatusBadge";
import { ARAgingPanel } from "./components/ARAgingPanel";
import { TransfersPanel } from "./components/TransfersPanel";
import { DedupPanel } from "./components/DedupPanel";
import { PayrollPortal } from "./components/PayrollPortal";
import { PayrollExpenseSummary } from "./components/PayrollExpenseSummary";
import { TimesheetsWorkspace } from "./components/TimesheetsWorkspace";
import { TransitionInboxPanel } from "./components/TransitionInboxPanel";
import { useAutoSortableTables } from "./components/useAutoSortableTables";
import { GroupedList } from "./components/GroupedList";
import { AccountingWorkspace } from "./components/AccountingWorkspace";
import { BookkeepingWorkspace } from "./components/BookkeepingWorkspace";
import { CloudConnectionsPanel } from "./components/CloudConnectionsPanel";
import { ReconciliationPanel } from "./components/ReconciliationPanel";
import {
  AdminTimesheet,
  BankCategorySummaryRow,
  BankExpenseSummaryRow,
  ClientRollup,
  FreshBooksInbox,
  FreshBooksTransitionRun,
  Invoice,
  InvoicePreview,
  InvoiceRevenueStatus,
  UnbilledHoursReport,
  Project,
  ProjectExpense,
  ProjectPerformanceRange,
  ProjectPerformanceResponse,
  ProjectPerformanceRow,
  ProjectWbs,
  TimeEntry,
  Timesheet,
  User,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
} from "./components/workspaceShared";

type WorkspaceKey =
  | "dashboard"
  | "clients"
  | "projects"
  | "time"
  | "timesheets"
  | "invoices"
  | "costs"
  | "payroll"
  | "accounting"
  | "bookkeeping"
  | "reports"
  | "imports"
  | "settings";

const DEV_AUTH_ENABLED = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true";

const WORKSPACES: Array<{ key: WorkspaceKey; label: string; hint: string }> = [
  { key: "dashboard", label: "Dashboard", hint: "Snapshot" },
  { key: "clients", label: "Clients", hint: "Relationships" },
  { key: "projects", label: "Projects", hint: "Pipeline + setup" },
  { key: "time", label: "Time", hint: "Capture work" },
  { key: "timesheets", label: "Timesheets", hint: "Approval flow" },
  { key: "invoices", label: "Invoices", hint: "Billing + A/R" },
  { key: "costs", label: "Costs", hint: "Expenses + tax" },
  { key: "payroll", label: "Payroll", hint: "Payroll journal · COGS" },
  { key: "accounting", label: "Accounting", hint: "P&L · Cash Flow · Loans" },
  { key: "bookkeeping", label: "Bookkeeping", hint: "Tax-remediation log" },
  { key: "reports", label: "Reports", hint: "Benchmarks" },
  { key: "imports", label: "Imports", hint: "FreshBooks transition" },
  { key: "settings", label: "Settings", hint: "Lean admin" },
];

const BUILD_STAMP = "AqtPM rebuild live on Apr 17, 2026";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonthIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

function weekStartIso() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(now);
  monday.setDate(now.getDate() - mondayOffset);
  return monday.toISOString().slice(0, 10);
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function AquatechPmHome() {
  useAutoSortableTables();

  const [workspace, setWorkspace] = useState<WorkspaceKey>("dashboard");
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [adminTimesheets, setAdminTimesheets] = useState<AdminTimesheet[]>([]);
  const [staffList, setStaffList] = useState<User[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [reportRange, setReportRange] = useState<ProjectPerformanceRange | null>(null);
  const [projectPerformance, setProjectPerformance] = useState<ProjectPerformanceRow[]>([]);
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceRevenueStatus | null>(null);
  const [unbilledHours, setUnbilledHours] = useState<UnbilledHoursReport | null>(null);
  const [wbsByProject, setWbsByProject] = useState<Record<number, ProjectWbs>>({});
  const [projectExpenses, setProjectExpenses] = useState<ProjectExpense[]>([]);
  const [bankCategorySummary, setBankCategorySummary] = useState<BankCategorySummaryRow[]>([]);
  const [bankMerchantSummary, setBankMerchantSummary] = useState<BankExpenseSummaryRow[]>([]);
  const [freshbooksInbox, setFreshbooksInbox] = useState<FreshBooksInbox | null>(null);
  const [transitionRun, setTransitionRun] = useState<FreshBooksTransitionRun | null>(null);

  const [projectForm, setProjectForm] = useState({
    name: "",
    client_name: "",
    overall_budget_fee: "",
    target_gross_margin_pct: "45",
  });
  const [timeForm, setTimeForm] = useState({
    projectId: "",
    taskId: "",
    subtaskId: "",
    workDate: todayIso(),
    hours: "8",
    note: "",
  });
  const [invoiceForm, setInvoiceForm] = useState({
    projectId: "",
    start: startOfMonthIso(),
    end: todayIso(),
    approvedOnly: true,
  });
  const [expenseForm, setExpenseForm] = useState({
    projectId: "",
    expenseDate: todayIso(),
    category: "Software And Subscriptions",
    description: "",
    amount: "",
  });
  const [invoicePreview, setInvoicePreview] = useState<InvoicePreview | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const capabilities = useMemo(() => deriveUserCapabilities(user), [user]);

  const selectedProjectWbs = useMemo(() => {
    const projectId = Number(timeForm.projectId || invoiceForm.projectId || 0);
    if (!projectId) return null;
    return wbsByProject[projectId] ?? null;
  }, [timeForm.projectId, invoiceForm.projectId, wbsByProject]);

  const timeTasks = useMemo(() => {
    const projectId = Number(timeForm.projectId);
    if (!projectId) return [];
    return wbsByProject[projectId]?.tasks ?? [];
  }, [timeForm.projectId, wbsByProject]);

  const timeSubtasks = useMemo(() => {
    const taskId = Number(timeForm.taskId);
    return timeTasks.find((task) => task.id === taskId)?.subtasks ?? [];
  }, [timeForm.taskId, timeTasks]);

  const clientRollups = useMemo<ClientRollup[]>(() => {
    const rollup = new Map<string, ClientRollup>();
    for (const project of projects) {
      const key = (project.client_name || "Unassigned").trim();
      const current = rollup.get(key) ?? {
        name: key,
        projectCount: 0,
        activeProjectCount: 0,
        billedRevenue: 0,
        outstandingRevenue: 0,
      };
      current.projectCount += 1;
      if (project.is_active) current.activeProjectCount += 1;
      rollup.set(key, current);
    }
    for (const invoice of invoices) {
      const key = (invoice.client_name || "Unassigned").trim();
      const current = rollup.get(key) ?? {
        name: key,
        projectCount: 0,
        activeProjectCount: 0,
        billedRevenue: 0,
        outstandingRevenue: 0,
      };
      current.billedRevenue += invoice.subtotal_amount;
      current.outstandingRevenue += invoice.balance_due;
      rollup.set(key, current);
    }
    return Array.from(rollup.values()).sort((a, b) => b.billedRevenue - a.billedRevenue || a.name.localeCompare(b.name));
  }, [invoices, projects]);

  async function loadWorkspaceData(activeUser: User) {
    setWorkspaceLoading(true);
    setError(null);
    try {
      const monthStart = startOfMonthIso();
      const monthEnd = todayIso();
      // Load 24 months of time history so Projects + Dashboard surfaces show real
      // hours/revenue. WeeklyTimeEntry self-fetches per-week so this only affects rollups.
      const historyStart = new Date();
      historyStart.setMonth(historyStart.getMonth() - 24);
      historyStart.setDate(1);
      const historyStartIso = `${historyStart.getFullYear()}-${String(historyStart.getMonth() + 1).padStart(2, "0")}-01`;
      const requests: Promise<unknown>[] = [
        apiGet<Project[]>("/projects?include_inactive=true"),
        apiGet<TimeEntry[]>(`/time-entries?start=${historyStartIso}&end=${monthEnd}`),
        apiGet<Timesheet[]>("/timesheets/mine"),
      ];
      const canApproveTimesheetsLocal = deriveUserCapabilities(activeUser).canApproveTimesheets;
      if (canApproveTimesheetsLocal) {
        requests.push(apiGet<AdminTimesheet[]>("/timesheets/all?include_pending=true"));
        // Best-effort fetch of staff list for admin "view as employee" feature
        apiGet<User[]>("/users").then((u) => setStaffList(u || [])).catch(() => setStaffList([]));
      }
      if (deriveUserCapabilities(activeUser).canViewFinancials) {
        requests.push(apiGet<Invoice[]>("/invoices"));
        requests.push(apiGet<ProjectPerformanceRange>("/reports/project-performance-range"));
        requests.push(apiGet<InvoiceRevenueStatus>("/reports/invoice-revenue-status"));
        requests.push(apiGet<BankCategorySummaryRow[]>("/bank/categories/summary?include_personal=false&unmatched_only=false"));
        requests.push(apiGet<BankExpenseSummaryRow[]>("/bank/summary?group_by=merchant&include_personal=false&unmatched_only=false&limit=10"));
        requests.push(apiGet<FreshBooksInbox>("/transition/freshbooks/inbox"));
        requests.push(apiGet<UnbilledHoursReport>("/reports/unbilled-hours"));
      }
      const results = await Promise.all(requests);
      const canApproveTimesheets = deriveUserCapabilities(activeUser).canApproveTimesheets;
      const financialOffset = canApproveTimesheets ? 4 : 3;
      setProjects(results[0] as Project[]);
      setTimeEntries(results[1] as TimeEntry[]);
      setTimesheets(results[2] as Timesheet[]);
      setAdminTimesheets(canApproveTimesheets ? ((results[3] as AdminTimesheet[]) ?? []) : []);
      if (deriveUserCapabilities(activeUser).canViewFinancials) {
        const nextInvoices = (results[financialOffset] as Invoice[]) ?? [];
        const nextRange = (results[financialOffset + 1] as ProjectPerformanceRange) ?? null;
        const nextInvoiceStatus = (results[financialOffset + 2] as InvoiceRevenueStatus) ?? null;
        const nextBankCategories = (results[financialOffset + 3] as BankCategorySummaryRow[]) ?? [];
        const nextBankMerchants = (results[financialOffset + 4] as BankExpenseSummaryRow[]) ?? [];
        const nextInbox = (results[financialOffset + 5] as FreshBooksInbox) ?? null;
        const nextUnbilledHours = (results[financialOffset + 6] as UnbilledHoursReport) ?? null;
        setInvoices(nextInvoices);
        setReportRange(nextRange);
        setInvoiceStatus(nextInvoiceStatus);
        setBankCategorySummary(nextBankCategories);
        setBankMerchantSummary(nextBankMerchants);
        setFreshbooksInbox(nextInbox);
        setUnbilledHours(nextUnbilledHours);
        if (nextRange?.has_data) {
          const performance = await apiGet<ProjectPerformanceResponse>(
            `/reports/project-performance?start=${nextRange.start}&end=${nextRange.end}`,
          );
          setProjectPerformance(performance.projects);
        } else {
          setProjectPerformance([]);
        }
      } else {
        setInvoices([]);
        setAdminTimesheets(canApproveTimesheets ? ((results[3] as AdminTimesheet[]) ?? []) : []);
        setReportRange(null);
        setInvoiceStatus(null);
        setProjectPerformance([]);
        setBankCategorySummary([]);
        setBankMerchantSummary([]);
        setFreshbooksInbox(null);
        setUnbilledHours(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load workspace");
    } finally {
      setWorkspaceLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const me = await apiGet<User>("/auth/me");
        if (!alive) return;
        setUser(me);
        await loadWorkspaceData(me);
      } catch (err) {
        if (!alive) return;
        setUser(null);
        setError(err instanceof Error ? err.message : "Unable to load session");
      } finally {
        if (alive) setAuthLoading(false);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, []);

  async function ensureWbs(projectId: number) {
    if (wbsByProject[projectId]) return wbsByProject[projectId];
    const wbs = await apiGet<ProjectWbs>(`/projects/${projectId}/wbs`);
    setWbsByProject((current) => ({ ...current, [projectId]: wbs }));
    return wbs;
  }

  async function loadProjectExpenses(projectId: number) {
    if (!projectId) {
      setProjectExpenses([]);
      return;
    }
    const rows = await apiGet<ProjectExpense[]>(`/projects/${projectId}/expenses`);
    setProjectExpenses(rows);
  }

  async function refresh() {
    if (!user) return;
    await loadWorkspaceData(user);
  }

  async function handleImportFreshBooksInbox() {
    setSubmitting("transition-import");
    setFlash(null);
    setError(null);
    try {
      const result = await apiPost<FreshBooksTransitionRun>("/transition/freshbooks/import?apply=true");
      setTransitionRun(result);
      setFlash(
        `FreshBooks import finished. Imported ${result.totals.imported || 0}, updated ${result.totals.updated || 0}, errors ${result.totals.errors || 0}.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import FreshBooks inbox");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("project");
    setFlash(null);
    setError(null);
    try {
      await apiPost<Project>("/projects", {
        name: projectForm.name.trim(),
        client_name: projectForm.client_name.trim() || null,
        pm_user_id: user?.id ?? null,
        start_date: null,
        end_date: null,
        overall_budget_fee: Number(projectForm.overall_budget_fee || 0),
        target_gross_margin_pct: Number(projectForm.target_gross_margin_pct || 0),
        is_overhead: false,
        is_billable: true,
      });
      setProjectForm({ name: "", client_name: "", overall_budget_fee: "", target_gross_margin_pct: "45" });
      setFlash("Project created.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create project");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleProjectPick(projectId: string) {
    setTimeForm((current) => ({ ...current, projectId, taskId: "", subtaskId: "" }));
    const numericProjectId = Number(projectId);
    if (numericProjectId) {
      await ensureWbs(numericProjectId);
    }
  }

  async function handleInvoiceProjectPick(projectId: string) {
    setInvoiceForm((current) => ({ ...current, projectId }));
    const numericProjectId = Number(projectId);
    if (numericProjectId) {
      await ensureWbs(numericProjectId);
    }
  }

  async function handleExpenseProjectPick(projectId: string) {
    setExpenseForm((current) => ({ ...current, projectId }));
    const numericProjectId = Number(projectId);
    await loadProjectExpenses(numericProjectId);
  }

  async function handleCreateTimeEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("time");
    setFlash(null);
    setError(null);
    try {
      await apiPost<TimeEntry>("/time-entries", {
        project_id: Number(timeForm.projectId),
        task_id: Number(timeForm.taskId),
        subtask_id: Number(timeForm.subtaskId),
        work_date: timeForm.workDate,
        hours: Number(timeForm.hours),
        note: timeForm.note,
      });
      setTimeForm((current) => ({ ...current, hours: "8", note: "" }));
      setFlash("Time entry saved.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save time entry");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleGenerateTimesheet() {
    setSubmitting("timesheet-generate");
    setFlash(null);
    setError(null);
    try {
      await apiPost<Timesheet>(`/timesheets/generate?week_start=${weekStartIso()}`);
      setFlash("This week’s timesheet is ready.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to generate timesheet");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleSubmitTimesheet(timesheetId: number) {
    setSubmitting(`timesheet-${timesheetId}`);
    setFlash(null);
    setError(null);
    try {
      await apiPost<Timesheet>(`/timesheets/${timesheetId}/submit`);
      setFlash("Timesheet submitted.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit timesheet");
    } finally {
      setSubmitting(null);
    }
  }

  async function ensureAdminTimesheet(sheet: AdminTimesheet): Promise<Timesheet> {
    if (sheet.id) {
      return {
        id: sheet.id,
        user_id: sheet.user_id,
        week_start: sheet.week_start,
        week_end: sheet.week_end,
        status: sheet.status,
        total_hours: sheet.total_hours,
        employee_signed_at: sheet.employee_signed_at ?? null,
        supervisor_signed_at: sheet.supervisor_signed_at ?? null,
      };
    }
    return apiPost<Timesheet>(`/timesheets/ensure?user_id=${sheet.user_id}&week_start=${sheet.week_start}`);
  }

  async function handleAdminSubmitTimesheet(sheet: AdminTimesheet) {
    const submitKey = `timesheet-admin-submit-${sheet.user_id}-${sheet.week_start}`;
    setSubmitting(submitKey);
    setFlash(null);
    setError(null);
    try {
      const ensured = await ensureAdminTimesheet(sheet);
      await apiPost<Timesheet>(`/timesheets/${ensured.id}/submit-admin`);
      setFlash(`Submitted ${sheet.user_full_name || sheet.user_email}'s timesheet.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit employee timesheet");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleAdminApproveTimesheet(sheet: AdminTimesheet) {
    const approveKey = `timesheet-admin-approve-${sheet.user_id}-${sheet.week_start}`;
    setSubmitting(approveKey);
    setFlash(null);
    setError(null);
    try {
      let ensured = await ensureAdminTimesheet(sheet);
      if (sheet.status === "unsubmitted" || sheet.status === "draft" || sheet.status === "rejected") {
        ensured = await apiPost<Timesheet>(`/timesheets/${ensured.id}/submit-admin`);
      }
      await apiPost<Timesheet>(`/timesheets/${ensured.id}/approve`);
      setFlash(`Approved ${sheet.user_full_name || sheet.user_email}'s timesheet.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to approve employee timesheet");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleAdminReturnTimesheet(sheet: AdminTimesheet) {
    if (!sheet.id) return;
    const reason = typeof window !== "undefined"
      ? window.prompt(
          `Return ${sheet.user_full_name || sheet.user_email}'s timesheet?\n\nEnter the reason (will be sent to the employee + audit log):`,
          "",
        )
      : "";
    if (reason === null) return; // user canceled
    const trimmed = (reason || "").trim();
    const returnKey = `timesheet-admin-return-${sheet.user_id}-${sheet.week_start}`;
    setSubmitting(returnKey);
    setFlash(null);
    setError(null);
    try {
      const qs = trimmed ? `?note=${encodeURIComponent(trimmed)}` : "";
      await apiPost<Timesheet>(`/timesheets/${sheet.id}/return${qs}`);
      setFlash(
        trimmed
          ? `Returned ${sheet.user_full_name || sheet.user_email}'s timesheet with note: "${trimmed}"`
          : `Returned ${sheet.user_full_name || sheet.user_email}'s timesheet.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to return employee timesheet");
    } finally {
      setSubmitting(null);
    }
  }

  async function handlePreviewInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("invoice-preview");
    setFlash(null);
    setError(null);
    try {
      const query = new URLSearchParams({
        start: invoiceForm.start,
        end: invoiceForm.end,
        project_id: invoiceForm.projectId,
        approved_only: String(invoiceForm.approvedOnly),
      });
      const preview = await apiGet<InvoicePreview>(`/invoices/preview?${query.toString()}`);
      setInvoicePreview(preview);
      setFlash("Invoice preview refreshed.");
    } catch (err) {
      setInvoicePreview(null);
      setError(err instanceof Error ? err.message : "Unable to preview invoice");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleCreateInvoice() {
    if (!invoicePreview) return;
    setSubmitting("invoice-create");
    setFlash(null);
    setError(null);
    try {
      await apiPost<Invoice>("/invoices", {
        start: invoiceForm.start,
        end: invoiceForm.end,
        project_id: Number(invoiceForm.projectId),
        approved_only: invoiceForm.approvedOnly,
        notes: "",
      });
      setInvoicePreview(null);
      setFlash("Invoice created as draft.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create invoice");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleCreateExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting("expense");
    setFlash(null);
    setError(null);
    try {
      const projectId = Number(expenseForm.projectId);
      await apiPost<ProjectExpense>(`/projects/${projectId}/expenses`, {
        expense_date: expenseForm.expenseDate,
        category: expenseForm.category,
        description: expenseForm.description,
        amount: Number(expenseForm.amount),
      });
      setExpenseForm((current) => ({ ...current, description: "", amount: "" }));
      setFlash("Expense logged.");
      await loadProjectExpenses(projectId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create expense");
    } finally {
      setSubmitting(null);
    }
  }

  const headlineMetrics = useMemo(() => {
    const activeProjects = projects.filter((project) => project.is_active && !project.is_overhead).length;
    const openInvoices = invoices.filter((invoice) => invoice.balance_due > 0.01).length;
    // Filter to current month explicitly since timeEntries now spans 24 months
    const monthStartIso = startOfMonthIso();
    const monthHours = timeEntries
      .filter((row) => row.work_date >= monthStartIso)
      .reduce((sum, row) => sum + row.hours, 0);
    return {
      activeProjects,
      openInvoices,
      monthHours,
    };
  }, [invoices, projects, timeEntries]);

  if (authLoading) {
    return <div className="aq-lite-loading">Loading AqtPM…</div>;
  }

  if (!user) {
    return (
      <div className="aq-lite-auth">
        <div className="aq-lite-auth-card">
          <img src="/Aqt_Logo.png" alt="Aquatech" className="aq-lite-auth-logo" />
          <p className="aq-lite-eyebrow">AqtPM</p>
          <h1>FreshBooks-style operations, trimmed for Aquatech.</h1>
          <p className="aq-lite-auth-copy">
            This revamp keeps the business-critical workflows only: projects, time, timesheets, invoices, receivables,
            and reporting.
          </p>
          <div className="aq-lite-auth-actions">
            {DEV_AUTH_ENABLED ? (
              <button
                className="aq-lite-primary-link aq-lite-primary-button"
                type="button"
                onClick={async () => {
                  try {
                    await apiPost("/auth/dev/login", { email: "bertrand.byrne@aquatechpc.com" });
                    window.location.reload();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Unable to log in");
                  }
                }}
              >
                Enter AqtPM
              </button>
            ) : (
              <a className="aq-lite-primary-link" href="/api/auth/google/login">
                Sign in with Google
              </a>
            )}
          </div>
          {DEV_AUTH_ENABLED ? (
            <p className="aq-lite-muted" style={{ marginTop: 12 }}>
              Local mode is using dev auth. Google OAuth is disabled on this server.
            </p>
          ) : null}
          {error ? <p className="aq-lite-error">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="aq-lite-shell">
      <aside className="aq-lite-sidebar">
        <div className="aq-lite-signed-in">
          <div className="aq-lite-signed-in-info">
            <span className="aq-lite-signed-in-label">Signed in</span>
            <strong>{user.full_name}</strong>
            <span className="aq-lite-signed-in-role">{user.role}</span>
          </div>
          <button
            type="button"
            className="aq-lite-signed-in-out"
            onClick={async () => {
              await apiPost("/auth/logout");
              window.location.reload();
            }}
            title="Sign out"
          >
            Sign out
          </button>
        </div>
        <div className="aq-lite-brand">
          <img src="/Aqt_Logo.png" alt="Aquatech" className="aq-lite-brand-logo" />
          <div>
            <p className="aq-lite-eyebrow">Aquatech P.C.</p>
            <strong>AqtPM</strong>
          </div>
        </div>
        <nav className="aq-lite-nav">
          {WORKSPACES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={classNames("aq-lite-nav-item", workspace === item.key && "active")}
              onClick={() => setWorkspace(item.key)}
            >
              <span>{item.label}</span>
              <small>{item.hint}</small>
            </button>
          ))}
        </nav>
        <div className="aq-lite-sidebar-card">
          <p className="aq-lite-sidebar-label">Business posture</p>
          <strong>{formatCurrency(invoiceStatus?.total_outstanding)} open receivables</strong>
          <span>{headlineMetrics.activeProjects} active projects</span>
        </div>
      </aside>

      <main className="aq-lite-main">
        <header className="aq-lite-topbar">
          <div>
            <p className="aq-lite-eyebrow">Small business operating system</p>
            <h1>{WORKSPACES.find((item) => item.key === workspace)?.label}</h1>
            <div className="aq-lite-build-stamp">{BUILD_STAMP}</div>
          </div>
          <div className="aq-lite-topbar-actions">
            <button
              type="button"
              className="aq-lite-topbar-refresh"
              onClick={() => void refresh()}
              disabled={workspaceLoading}
            >
              Refresh
            </button>
          </div>
        </header>

        <Toast
          state={error ? { message: error, kind: "error" } : flash ? { message: flash, kind: "success" } : null}
          onClose={() => {
            setError(null);
            setFlash(null);
          }}
        />
        {flash ? <div className="aq-lite-flash">{flash}</div> : null}
        {error ? <div className="aq-lite-error-banner">{error}</div> : null}

        {workspaceLoading ? <div className="aq-lite-panel">Refreshing workspace…</div> : null}

        {workspace === "dashboard" ? (
          <section className="aq-lite-stack">
            <div className="aq-lite-hero">
              <div>
                <p className="aq-lite-eyebrow">Overview</p>
                <h2>{`Welcome back${headlineMetrics.activeProjects ? `, ${headlineMetrics.activeProjects} active project${headlineMetrics.activeProjects === 1 ? "" : "s"}` : ""}.`}</h2>
                <p>
                  Project delivery, time, billing, collections, and reporting — all on one screen.
                </p>
              </div>
              <div className="aq-lite-hero-grid">
                <article className="aq-lite-kpi">
                  <span>Active projects</span>
                  <strong>{headlineMetrics.activeProjects}</strong>
                </article>
                <article className="aq-lite-kpi">
                  <span>Month hours logged</span>
                  <strong>{formatNumber(headlineMetrics.monthHours, 1)}</strong>
                </article>
                <article className="aq-lite-kpi">
                  <span>Total invoiced</span>
                  <strong>{formatCurrency(invoiceStatus?.total_invoiced)}</strong>
                </article>
                <article className="aq-lite-kpi">
                  <span>Open invoices</span>
                  <strong>{headlineMetrics.openInvoices}</strong>
                </article>
              </div>
            </div>

            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Cash</p>
                    <h3>Invoice pipeline</h3>
                  </div>
                </div>
                <div className="aq-lite-stat-list">
                  <div>
                    <span>Paid to date</span>
                    <strong>{formatCurrency(invoiceStatus?.total_paid_to_date)}</strong>
                  </div>
                  <div>
                    <span>Outstanding</span>
                    <strong>{formatCurrency(invoiceStatus?.total_outstanding)}</strong>
                  </div>
                  <div>
                    <span>Overdue</span>
                    <strong>{formatCurrency(invoiceStatus?.overdue_total)}</strong>
                  </div>
                  <div>
                    <span>Earned, not billed</span>
                    <strong>{formatCurrency(invoiceStatus?.earned_not_billed_total)}</strong>
                  </div>
                </div>
              </section>

              <ARAgingPanel invoices={invoices} />
            </div>

            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Performance</p>
                    <h3>Top projects</h3>
                  </div>
                </div>
                <div className="aq-lite-list">
                  {projectPerformance.slice(0, 5).map((project) => (
                    <div key={project.project_id} className="aq-lite-list-row">
                      <div>
                        <strong>{project.project_name}</strong>
                        <span>{formatPercent(project.margin_pct)} margin</span>
                      </div>
                      <strong>{formatCurrency(project.actual_revenue)}</strong>
                    </div>
                  ))}
                  {projectPerformance.length === 0 ? <p className="aq-lite-muted">Financial reporting data will appear here once loaded.</p> : null}
                </div>
              </section>

              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Relationships</p>
                    <h3>Top clients by billings</h3>
                  </div>
                </div>
                <div className="aq-lite-list">
                  {clientRollups.slice(0, 5).map((client) => (
                    <div key={client.name} className="aq-lite-list-row">
                      <div>
                        <strong>{client.name}</strong>
                        <span>
                          {client.activeProjectCount} active project{client.activeProjectCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <strong>{formatCurrency(client.billedRevenue)}</strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Work in progress</p>
                  <h3>Unbilled hours (billable)</h3>
                  <p className="aq-lite-muted">
                    Billable time entered in timesheets not yet on any invoice. As of {unbilledHours?.as_of ?? "—"}.
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong style={{ fontSize: 24 }}>
                    {formatNumber(unbilledHours?.billable.totals.hours ?? 0, 1)} hrs
                  </strong>
                  <div className="aq-lite-muted">
                    {formatCurrency(unbilledHours?.billable.totals.value ?? 0)} unbilled value
                  </div>
                </div>
              </div>
              <div className="aq-lite-grid aq-lite-grid-2">
                <div>
                  <p className="aq-lite-eyebrow" style={{ marginTop: 8 }}>By employee</p>
                  <div className="aq-lite-list">
                    {(unbilledHours?.billable.by_employee ?? []).map((row) => (
                      <div key={row.user_id} className="aq-lite-list-row">
                        <div>
                          <strong>{row.name}</strong>
                          <span>{formatCurrency(row.value ?? 0)}</span>
                        </div>
                        <strong>{formatNumber(row.hours, 1)}h</strong>
                      </div>
                    ))}
                    {(unbilledHours?.billable.by_employee?.length ?? 0) === 0 ? (
                      <p className="aq-lite-muted">No unbilled billable hours.</p>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="aq-lite-eyebrow" style={{ marginTop: 8 }}>By project</p>
                  <div className="aq-lite-list">
                    {(unbilledHours?.billable.by_project ?? []).map((row) => (
                      <div key={row.project_id} className="aq-lite-list-row">
                        <div>
                          <strong>{row.project_name}</strong>
                          <span>{row.client_name || "—"} · {formatCurrency(row.value ?? 0)}</span>
                        </div>
                        <strong>{formatNumber(row.hours, 1)}h</strong>
                      </div>
                    ))}
                    {(unbilledHours?.billable.by_project?.length ?? 0) === 0 ? (
                      <p className="aq-lite-muted">No unbilled billable hours.</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Overhead</p>
                  <h3>Non-billable hours</h3>
                  <p className="aq-lite-muted">
                    Overhead, admin, internal work — time NOT eligible to be billed to a client.
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <strong style={{ fontSize: 20 }}>
                    {formatNumber(unbilledHours?.non_billable.current_month.totals.hours ?? 0, 1)} hrs
                  </strong>
                  <div className="aq-lite-muted">
                    {unbilledHours?.non_billable.current_month.label ?? "—"}
                  </div>
                  <div className="aq-lite-muted" style={{ marginTop: 4 }}>
                    {formatNumber(unbilledHours?.non_billable.ytd.totals.hours ?? 0, 1)} hrs ·{" "}
                    {unbilledHours?.non_billable.ytd.label ?? "—"}
                  </div>
                </div>
              </div>
              <div className="aq-lite-grid aq-lite-grid-2">
                <div>
                  <p className="aq-lite-eyebrow" style={{ marginTop: 8 }}>
                    By employee · {unbilledHours?.non_billable.ytd.label ?? "—"}
                  </p>
                  <div className="aq-lite-list">
                    {(unbilledHours?.non_billable.ytd.by_employee ?? []).map((row) => (
                      <div key={row.user_id} className="aq-lite-list-row">
                        <div>
                          <strong>{row.name}</strong>
                        </div>
                        <strong>{formatNumber(row.hours, 1)}h</strong>
                      </div>
                    ))}
                    {(unbilledHours?.non_billable.ytd.by_employee?.length ?? 0) === 0 ? (
                      <p className="aq-lite-muted">No non-billable hours this year.</p>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="aq-lite-eyebrow" style={{ marginTop: 8 }}>
                    By project · {unbilledHours?.non_billable.ytd.label ?? "—"}
                  </p>
                  <div className="aq-lite-list">
                    {(unbilledHours?.non_billable.ytd.by_project ?? []).map((row) => (
                      <div key={row.project_id} className="aq-lite-list-row">
                        <div>
                          <strong>{row.project_name}</strong>
                          <span>{row.client_name || "—"}</span>
                        </div>
                        <strong>{formatNumber(row.hours, 1)}h</strong>
                      </div>
                    ))}
                    {(unbilledHours?.non_billable.ytd.by_project?.length ?? 0) === 0 ? (
                      <p className="aq-lite-muted">No non-billable hours this year.</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Work capture</p>
                  <h3>Recent time entries</h3>
                </div>
              </div>
              <div className="aq-lite-grid aq-lite-grid-2" style={{ gap: 8 }}>
                {timeEntries.slice(-8).reverse().map((entry) => (
                  <div key={entry.id} className="aq-lite-list-row">
                    <div>
                      <strong>{entry.project_name || "Project"}</strong>
                      <span>
                        {formatDate(entry.work_date)} · {entry.task_name || "Task"}
                      </span>
                    </div>
                    <strong>{formatNumber(entry.hours, 1)}h</strong>
                  </div>
                ))}
              </div>
            </section>
          </section>
        ) : null}

        {workspace === "clients" ? (
          <section className="aq-lite-panel">
            <div className="aq-lite-panel-head">
              <div>
                <p className="aq-lite-eyebrow">Clients</p>
                <h3>Simple relationship view</h3>
              </div>
            </div>
            <table className="aq-lite-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Projects</th>
                  <th>Active</th>
                  <th>Billed</th>
                  <th>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {clientRollups.map((client) => (
                  <tr key={client.name}>
                    <td>{client.name}</td>
                    <td>{client.projectCount}</td>
                    <td>{client.activeProjectCount}</td>
                    <td>{formatCurrency(client.billedRevenue)}</td>
                    <td>{formatCurrency(client.outstandingRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {workspace === "projects" ? (
          <ProjectWorkspace
            projects={projects}
            projectForm={projectForm}
            setProjectForm={setProjectForm}
            onCreateProject={handleCreateProject}
            submitting={submitting}
            canManageProjects={capabilities.canManageProjects}
            performance={projectPerformance}
            timeEntries={timeEntries}
            invoices={invoices}
            expenses={projectExpenses}
            staffOptions={staffList.map((u) => ({ id: u.id, full_name: u.full_name, email: u.email }))}
          />
        ) : null}

        {workspace === "time" && user ? (
          <WeeklyTimeEntry
            user={user}
            projects={projects}
            wbsByProject={wbsByProject}
            timeEntries={timeEntries}
            onProjectPick={handleProjectPick}
            onSaved={async () => {
              if (user) await loadWorkspaceData(user);
            }}
            isAdmin={capabilities.canApproveTimesheets}
            staffOptions={staffList.map((u) => ({ id: u.id, name: u.full_name, email: u.email }))}
          />
        ) : null}

        {workspace === "timesheets" ? (
          <TimesheetsWorkspace
            timesheets={timesheets}
            adminTimesheets={adminTimesheets}
            canApproveTimesheets={capabilities.canApproveTimesheets}
            onGenerateTimesheet={handleGenerateTimesheet}
            onSubmitTimesheet={handleSubmitTimesheet}
            onAdminSubmitTimesheet={handleAdminSubmitTimesheet}
            onAdminApproveTimesheet={handleAdminApproveTimesheet}
            onAdminReturnTimesheet={handleAdminReturnTimesheet}
            submitting={submitting}
          />
        ) : null}

        {workspace === "invoices" ? (
          <div className="aq-lite-stack">
            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Billing</p>
                    <h3>Create invoice from approved time</h3>
                  </div>
                </div>
                <form className="aq-lite-form" onSubmit={handlePreviewInvoice}>
                  <label>
                    Project
                    <select value={invoiceForm.projectId} onChange={(event) => void handleInvoiceProjectPick(event.target.value)} required>
                      <option value="">Select project</option>
                      {projects
                        .filter((project) => !project.is_overhead)
                        .map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="aq-lite-form-grid">
                    <label>
                      Start date
                      <input
                        type="date"
                        value={invoiceForm.start}
                        onChange={(event) => setInvoiceForm((current) => ({ ...current, start: event.target.value }))}
                        required
                      />
                    </label>
                    <label>
                      End date
                      <input
                        type="date"
                        value={invoiceForm.end}
                        onChange={(event) => setInvoiceForm((current) => ({ ...current, end: event.target.value }))}
                        required
                      />
                    </label>
                  </div>
                  <label className="aq-lite-inline-check">
                    <input
                      type="checkbox"
                      checked={invoiceForm.approvedOnly}
                      onChange={(event) =>
                        setInvoiceForm((current) => ({ ...current, approvedOnly: event.target.checked }))
                      }
                    />
                    Approved entries only
                  </label>
                  <div className="aq-lite-action-row">
                    <button type="submit" disabled={submitting === "invoice-preview" || !capabilities.canViewFinancials}>
                      {submitting === "invoice-preview" ? "Previewing…" : "Preview invoice"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCreateInvoice()}
                      disabled={submitting === "invoice-create" || !invoicePreview || !capabilities.canManageProjects}
                    >
                      {submitting === "invoice-create" ? "Creating…" : "Create draft invoice"}
                    </button>
                  </div>
                </form>
              </section>

              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Preview</p>
                    <h3>Draft summary</h3>
                  </div>
                </div>
                {invoicePreview ? (
                  <div className="aq-lite-stat-list">
                    <div>
                      <span>Client</span>
                      <strong>{invoicePreview.client_name}</strong>
                    </div>
                    <div>
                      <span>Line items</span>
                      <strong>{invoicePreview.line_count}</strong>
                    </div>
                    <div>
                      <span>Total hours</span>
                      <strong>{formatNumber(invoicePreview.total_hours, 1)}</strong>
                    </div>
                    <div>
                      <span>Subtotal</span>
                      <strong>{formatCurrency(invoicePreview.subtotal_amount)}</strong>
                    </div>
                    <div>
                      <span>Total cost</span>
                      <strong>{formatCurrency(invoicePreview.total_cost)}</strong>
                    </div>
                    <div>
                      <span>Estimated profit</span>
                      <strong>{formatCurrency(invoicePreview.total_profit)}</strong>
                    </div>
                  </div>
                ) : (
                  <p className="aq-lite-muted">Run a preview to see the invoice summary before creating a draft.</p>
                )}
              </section>
            </div>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">A/R</p>
                  <h3>Invoice roster ({invoices.length})</h3>
                </div>
              </div>
              <GroupedList
                rows={invoices}
                persistKey="invoices.roster"
                searchPredicate={(i, q) =>
                  `${i.invoice_number} ${i.client_name} ${i.status}`.toLowerCase().includes(q)
                }
                searchPlaceholder="Search invoice # / client / status"
                emptyHint="No invoices yet."
                groupOptions={[
                  { key: "status", label: "Status", groupBy: (i) => i.status || "(no status)" },
                  { key: "client", label: "Client", groupBy: (i) => i.client_name || "(no client)" },
                  {
                    key: "year",
                    label: "Issue year",
                    groupBy: (i) => (i.issue_date || "").slice(0, 4) || "—",
                    sortBuckets: (a, b) => b.localeCompare(a),
                  },
                  {
                    key: "month",
                    label: "Issue month",
                    groupBy: (i) => (i.issue_date || "").slice(0, 7) || "—",
                    sortBuckets: (a, b) => b.localeCompare(a),
                  },
                ]}
                renderGroupSummary={(items) => {
                  const total = items.reduce((s, i) => s + (i.subtotal_amount || 0), 0);
                  const open = items.reduce((s, i) => s + (i.balance_due || 0), 0);
                  return `${formatCurrency(total)} billed${open > 0 ? ` · ${formatCurrency(open)} open` : ""}`;
                }}
                renderRow={(invoice) => (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "120px 1fr 90px 100px 110px 110px 110px",
                      gap: 8,
                      padding: "4px 8px",
                      fontSize: 12,
                      borderBottom: "1px solid #f0f3f6",
                      alignItems: "center",
                    }}
                  >
                    <strong>{invoice.invoice_number}</strong>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {invoice.client_name}
                    </span>
                    <span><StatusBadge status={invoice.status} /></span>
                    <span style={{ color: "var(--aq-muted)" }}>{formatDate(invoice.issue_date)}</span>
                    <span style={{ textAlign: "right" }}>{formatCurrency(invoice.subtotal_amount)}</span>
                    <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>{formatCurrency(invoice.amount_paid)}</span>
                    <span
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        color: (invoice.balance_due || 0) > 0 ? "var(--aq-red)" : "var(--aq-green)",
                      }}
                    >
                      {(invoice.balance_due || 0) > 0 ? formatCurrency(invoice.balance_due) : "Paid"}
                    </span>
                  </div>
                )}
                initiallyOpen="first"
              />
            </section>
          </div>
        ) : null}

        {workspace === "payroll" ? (
          <PayrollPortal />
        ) : null}

        {workspace === "accounting" ? (
          <AccountingWorkspace canManage={capabilities.canManageProjects} />
        ) : null}

        {workspace === "bookkeeping" ? (
          <BookkeepingWorkspace />
        ) : null}

        {workspace === "reports" ? (
          <div className="aq-lite-grid aq-lite-grid-2">
            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Financial range</p>
                  <h3>Project performance</h3>
                </div>
              </div>
              <div className="aq-lite-stat-list">
                <div>
                  <span>Reporting window</span>
                  <strong>
                    {reportRange ? `${formatDate(reportRange.start)} to ${formatDate(reportRange.end)}` : "No data"}
                  </strong>
                </div>
                <div>
                  <span>Total project revenue</span>
                  <strong>{formatCurrency(projectPerformance.reduce((sum, row) => sum + row.actual_revenue, 0))}</strong>
                </div>
                <div>
                  <span>Total project profit</span>
                  <strong>{formatCurrency(projectPerformance.reduce((sum, row) => sum + row.actual_profit, 0))}</strong>
                </div>
                <div>
                  <span>Projects tracked</span>
                  <strong>{projectPerformance.length}</strong>
                </div>
              </div>
            </section>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Receivables</p>
                  <h3>Collections benchmark</h3>
                </div>
              </div>
              <div className="aq-lite-stat-list">
                <div>
                  <span>Outstanding</span>
                  <strong>{formatCurrency(invoiceStatus?.total_outstanding)}</strong>
                </div>
                <div>
                  <span>Overdue</span>
                  <strong>{formatCurrency(invoiceStatus?.overdue_total)}</strong>
                </div>
                <div>
                  <span>Open invoices</span>
                  <strong>{invoiceStatus?.invoice_count_open ?? 0}</strong>
                </div>
                <div>
                  <span>Overdue invoices</span>
                  <strong>{invoiceStatus?.overdue_invoice_count ?? 0}</strong>
                </div>
              </div>
            </section>

            <section className="aq-lite-panel aq-lite-panel-span-2">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Margin table</p>
                  <h3>Project benchmark view ({projectPerformance.length})</h3>
                </div>
              </div>
              <GroupedList
                rows={projectPerformance}
                persistKey="reports.projectPerformance"
                searchPredicate={(p, q) => (p.project_name || "").toLowerCase().includes(q)}
                searchPlaceholder="Search project"
                emptyHint="No project performance data."
                groupOptions={[
                  {
                    key: "margin_band",
                    label: "Margin band",
                    groupBy: (p) => {
                      const m = p.margin_pct || 0;
                      if (m >= 30) return "Healthy (≥ 30%)";
                      if (m >= 10) return "OK (10–30%)";
                      if (m >= 0) return "Thin (0–10%)";
                      return "Loss (< 0%)";
                    },
                    sortBuckets: (a, b) => {
                      const order = ["Healthy", "OK", "Thin", "Loss"];
                      const ai = order.findIndex((s) => a.startsWith(s));
                      const bi = order.findIndex((s) => b.startsWith(s));
                      return ai - bi;
                    },
                  },
                  { key: "all", label: "All (single bucket)", groupBy: () => "All projects" },
                ]}
                renderGroupSummary={(items) => {
                  const r = items.reduce((s, p) => s + (p.actual_revenue || 0), 0);
                  const pr = items.reduce((s, p) => s + (p.actual_profit || 0), 0);
                  return `${formatCurrency(r)} revenue · ${formatCurrency(pr)} profit`;
                }}
                renderRow={(project) => (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.4fr 110px 110px 110px 80px 80px",
                      gap: 8,
                      padding: "4px 8px",
                      fontSize: 12,
                      borderBottom: "1px solid #f0f3f6",
                    }}
                  >
                    <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {project.project_name}
                    </strong>
                    <span style={{ textAlign: "right" }}>{formatCurrency(project.actual_revenue)}</span>
                    <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>{formatCurrency(project.actual_cost)}</span>
                    <span style={{ textAlign: "right" }}>{formatCurrency(project.actual_profit)}</span>
                    <span
                      style={{
                        textAlign: "right",
                        fontWeight: 600,
                        color:
                          (project.margin_pct || 0) >= (project.target_gross_margin_pct || 0)
                            ? "var(--aq-green)"
                            : (project.margin_pct || 0) >= 0
                              ? undefined
                              : "var(--aq-red)",
                      }}
                    >
                      {formatPercent(project.margin_pct)}
                    </span>
                    <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>
                      {formatPercent(project.target_gross_margin_pct)}
                    </span>
                  </div>
                )}
                initiallyOpen="all"
              />
            </section>
          </div>
        ) : null}

        {workspace === "costs" ? (
          <div className="aq-lite-stack">
            <PayrollExpenseSummary />
            <DedupPanel />
            <TransfersPanel />
            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Manual expense entry</p>
                    <h3>Track deductible costs by project</h3>
                  </div>
                </div>
                <form className="aq-lite-form" onSubmit={handleCreateExpense}>
                  <label>
                    Project
                    <select value={expenseForm.projectId} onChange={(event) => void handleExpenseProjectPick(event.target.value)} required>
                      <option value="">Select project</option>
                      {projects
                        .filter((project) => !project.is_overhead)
                        .map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="aq-lite-form-grid">
                    <label>
                      Expense date
                      <input
                        type="date"
                        value={expenseForm.expenseDate}
                        onChange={(event) => setExpenseForm((current) => ({ ...current, expenseDate: event.target.value }))}
                        required
                      />
                    </label>
                    <label>
                      Category
                      <input
                        value={expenseForm.category}
                        onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value }))}
                        required
                      />
                    </label>
                  </div>
                  <label>
                    Description
                    <input
                      value={expenseForm.description}
                      onChange={(event) => setExpenseForm((current) => ({ ...current, description: event.target.value }))}
                      placeholder="Adobe, mileage, permit fee, subcontractor invoice, etc."
                    />
                  </label>
                  <label>
                    Amount
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={expenseForm.amount}
                      onChange={(event) => setExpenseForm((current) => ({ ...current, amount: event.target.value }))}
                      required
                    />
                  </label>
                  <button type="submit" disabled={submitting === "expense" || !capabilities.canManageProjects}>
                    {submitting === "expense" ? "Saving…" : "Log expense"}
                  </button>
                </form>
              </section>

              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Tax visibility</p>
                    <h3>Expense category rollup ({bankCategorySummary.length})</h3>
                  </div>
                </div>
                {bankCategorySummary.length === 0 ? (
                  <p className="aq-lite-muted">
                    Bank-connected expense summaries will appear here once business transactions are synced and categorized.
                  </p>
                ) : (
                  <GroupedList
                    rows={bankCategorySummary}
                    persistKey="costs.bankCategorySummary"
                    searchPredicate={(r, q) =>
                      `${r.category || ""} ${r.expense_group || ""}`.toLowerCase().includes(q)
                    }
                    searchPlaceholder="Search category / group"
                    groupOptions={[
                      {
                        key: "group",
                        label: "Group",
                        groupBy: (r) => r.expense_group || "(none)",
                      },
                      {
                        key: "category",
                        label: "Category",
                        groupBy: (r) => r.category || "(none)",
                      },
                    ]}
                    renderGroupSummary={(items) => {
                      const t = items.reduce((s, r) => s + (r.amount_abs || 0), 0);
                      const ct = items.reduce((s, r) => s + (r.transaction_count || 0), 0);
                      return `${formatCurrency(t)} · ${ct} txns`;
                    }}
                    renderRow={(row) => (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 90px 110px",
                          gap: 8,
                          padding: "4px 8px",
                          fontSize: 12,
                          borderBottom: "1px solid #f0f3f6",
                        }}
                      >
                        <span>
                          <strong>{row.category}</strong>
                          <span style={{ color: "var(--aq-muted)" }}>
                            {" "}· {row.expense_group}
                          </span>
                        </span>
                        <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>
                          {row.transaction_count}
                        </span>
                        <span style={{ textAlign: "right", fontWeight: 600 }}>
                          {formatCurrency(row.amount_abs)}
                        </span>
                      </div>
                    )}
                    initiallyOpen="all"
                  />
                )}
              </section>
            </div>

            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Project expenses</p>
                    <h3>All project costs · group + drill</h3>
                  </div>
                </div>
                <GroupedList
                  rows={projectExpenses}
                  persistKey="costs.projectExpenses"
                  searchPredicate={(e, q) =>
                    `${e.description || ""} ${e.category || ""}`.toLowerCase().includes(q)
                  }
                  searchPlaceholder="Search description / merchant"
                  emptyHint="No project expenses logged yet."
                  groupOptions={[
                    {
                      key: "category",
                      label: "Category",
                      groupBy: (e) => e.category || "(uncategorized)",
                    },
                    {
                      key: "month",
                      label: "Month",
                      groupBy: (e) => (e.expense_date || "").slice(0, 7) || "—",
                      sortBuckets: (a, b) => b.localeCompare(a),
                    },
                    {
                      key: "year",
                      label: "Year",
                      groupBy: (e) => (e.expense_date || "").slice(0, 4) || "—",
                      sortBuckets: (a, b) => b.localeCompare(a),
                    },
                    {
                      key: "project",
                      label: "Project",
                      groupBy: (e) => {
                        const p = projects.find((proj) => proj.id === e.project_id);
                        return p?.name || `Project ${e.project_id}`;
                      },
                    },
                    {
                      key: "merchant",
                      label: "Description / merchant",
                      groupBy: (e) => e.description || "(no description)",
                    },
                  ]}
                  renderGroupSummary={(items) => {
                    const total = items.reduce((s, e) => s + (e.amount || 0), 0);
                    return formatCurrency(total);
                  }}
                  renderRow={(e) => (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "100px 140px 1fr 110px",
                        gap: 8,
                        padding: "4px 8px",
                        fontSize: 12,
                        borderBottom: "1px solid #f0f3f6",
                      }}
                    >
                      <span style={{ color: "var(--aq-muted)" }}>{formatDate(e.expense_date)}</span>
                      <span>{e.category}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.description || "—"}
                      </span>
                      <span style={{ textAlign: "right", fontWeight: 600 }}>
                        {formatCurrency(e.amount)}
                      </span>
                    </div>
                  )}
                  initiallyOpen="first"
                />
              </section>

              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Merchant pattern</p>
                    <h3>Top cost drivers ({bankMerchantSummary.length})</h3>
                  </div>
                </div>
                {bankMerchantSummary.length === 0 ? (
                  <p className="aq-lite-muted">
                    Connect or import bank data to see merchant-based tax and overhead patterns.
                  </p>
                ) : (
                  <GroupedList
                    rows={bankMerchantSummary}
                    persistKey="costs.bankMerchantSummary"
                    searchPredicate={(r, q) => (r.label || "").toLowerCase().includes(q)}
                    searchPlaceholder="Search merchant"
                    groupOptions={[
                      {
                        key: "first",
                        label: "First letter",
                        groupBy: (r) => (r.label || "?").charAt(0).toUpperCase(),
                      },
                      {
                        key: "all",
                        label: "All merchants (single bucket)",
                        groupBy: () => "All merchants",
                      },
                    ]}
                    defaultGroupKey="first"
                    renderGroupSummary={(items) => {
                      const t = items.reduce((s, r) => s + (r.amount_abs || 0), 0);
                      const ct = items.reduce((s, r) => s + (r.transaction_count || 0), 0);
                      return `${formatCurrency(t)} · ${ct} txns`;
                    }}
                    renderRow={(row) => (
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 80px 110px",
                          gap: 8,
                          padding: "4px 8px",
                          fontSize: 12,
                          borderBottom: "1px solid #f0f3f6",
                        }}
                      >
                        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.label}
                        </strong>
                        <span style={{ textAlign: "right", color: "var(--aq-muted)" }}>
                          {row.transaction_count}
                        </span>
                        <span style={{ textAlign: "right", fontWeight: 600 }}>
                          {formatCurrency(row.amount_abs)}
                        </span>
                      </div>
                    )}
                    initiallyOpen="all"
                  />
                )}
              </section>
            </div>
          </div>
        ) : null}

        {workspace === "settings" ? (
          <div className="aq-lite-grid aq-lite-grid-2">
            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Revamp posture</p>
                  <h3>What is now in scope</h3>
                </div>
              </div>
              <div className="aq-lite-note-stack">
                <div className="aq-lite-note">
                  <strong>Keep</strong>
                  <p>Projects, time capture, timesheets, invoices, receivables, and management reporting.</p>
                </div>
              <div className="aq-lite-note">
                  <strong>De-emphasize</strong>
                  <p>Enterprise ops, tax packet tooling, observability, bank reconciliation, and sidecar utilities.</p>
                </div>
                <div className="aq-lite-note">
                  <strong>Next refactor step</strong>
                  <p>Split the backend monolith into focused services for projects, time, billing, and reporting.</p>
                </div>
              </div>
            </section>

            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">User</p>
                  <h3>Session summary</h3>
                </div>
              </div>
              <div className="aq-lite-stat-list">
                <div>
                  <span>Name</span>
                  <strong>{user.full_name}</strong>
                </div>
                <div>
                  <span>Email</span>
                  <strong>{user.email}</strong>
                </div>
                <div>
                  <span>Role</span>
                  <strong>{user.role}</strong>
                </div>
                <div>
                  <span>Permissions</span>
                  <strong>{user.permissions.length}</strong>
                </div>
              </div>
            </section>

          </div>
        ) : null}

        {workspace === "imports" ? (
          <div className="aq-lite-stack">
            {/* What lives here */}
            <section className="aq-lite-panel">
              <div className="aq-lite-panel-head">
                <div>
                  <p className="aq-lite-eyebrow">Data imports</p>
                  <h3>One place for all data brought into AqtPM</h3>
                </div>
              </div>
              <p className="aq-lite-muted" style={{ fontSize: 13, marginBottom: 0 }}>
                AqtPM reads from a watched folder on disk so you don't have to upload files from the browser.
                Drop new exports into the inbox folder and click <strong>Rescan</strong>. The four data sources
                are organized below by section. <strong>Loans</strong> are the only category that's currently
                imported via one-shot scripts (Forward Financing PDF, FundBox balance letter, BOC transaction
                histories) — surfaced for reference, not editable here.
              </p>
            </section>

            {/* Cloud connections — direct API integration with FreshBooks (and later Gusto) */}
            <CloudConnectionsPanel />

            {/* v2.0 reconciliation engine — show CSV vs API drift, dedupe overlap window */}
            <ReconciliationPanel />

            {/* FreshBooks folder-based intake — the existing CSV inbox panel */}
            <div className="aq-lite-grid aq-lite-grid-1">
              <TransitionInboxPanel
                freshbooksInbox={freshbooksInbox}
                onRefresh={refresh}
                onImport={handleImportFreshBooksInbox}
                workspaceLoading={workspaceLoading}
                importBusy={submitting === "transition-import"}
                transitionRun={transitionRun}
              />
            </div>

            {/* Reference cards for other data sources */}
            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <p className="aq-lite-eyebrow">Bank + credit card</p>
                <h3>Chase 6611 / 0273 / 0434 CC</h3>
                <ul style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: "var(--aq-muted)" }}>
                  <li><strong>Chase 6611</strong> (operating) — drop CSV into the inbox folder.</li>
                  <li><strong>Chase 0273</strong> — flagged personal; only suspect business charges and
                    transfers are reviewed in Costs.</li>
                  <li><strong>Chase 0434 Business CC</strong> — PDF statements imported via{" "}
                    <code>backend/import_business_cc.py</code>. All charges treated as business.</li>
                </ul>
              </section>

              <section className="aq-lite-panel">
                <p className="aq-lite-eyebrow">Payroll</p>
                <h3>Payroll journals (Gusto CSV + Paychex PDF)</h3>
                <ul style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: "var(--aq-muted)" }}>
                  <li>Drop the year-by-year <code>aquatech-engineering-p-c-payroll-summary-YYYY-...csv</code>{" "}
                    files in the same inbox folder.</li>
                  <li>Auto-parsed by the Payroll workspace — no separate import action needed.</li>
                  <li>This is the canonical source for COGS in the P&amp;L.</li>
                </ul>
              </section>

              <section className="aq-lite-panel">
                <p className="aq-lite-eyebrow">Loans &amp; credit lines</p>
                <h3>Imported via one-shot scripts</h3>
                <ul style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: "var(--aq-muted)" }}>
                  <li><strong>Forward Financing</strong> — <code>import_forward_financing.py</code></li>
                  <li><strong>Fundbox LOC</strong> — <code>setup_loans_and_personal_account.py</code> +{" "}
                    <code>import_fundbox_history.py</code></li>
                  <li><strong>BOC Capital</strong> — <code>import_boc_actual_loans.py</code> (per-project
                    transaction history PDFs)</li>
                </ul>
                <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 8 }}>
                  When you receive a new loan statement (e.g. updated BOC transaction history), drop the PDF
                  in <code>Downloads/</code> and re-run the matching script.
                </p>
              </section>

              <section className="aq-lite-panel">
                <p className="aq-lite-eyebrow">Notes</p>
                <h3>What about cloud connectors?</h3>
                <ul style={{ marginTop: 6, fontSize: 12, lineHeight: 1.7, color: "var(--aq-muted)" }}>
                  <li>Plaid bank-feed wiring is configured but not active — current pilot uses CSV/PDF only.</li>
                  <li>FreshBooks API integration is a future step; today's data flow is folder-based.</li>
                  <li>This separation keeps the system auditable: every record traces to a file on disk.</li>
                </ul>
              </section>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
