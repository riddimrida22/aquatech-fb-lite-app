"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { deriveUserCapabilities } from "../lib/permissions";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { DailyTimeEntry } from "./components/DailyTimeEntry";
import { Toast } from "./components/Toast";
import { StatusBadge } from "./components/StatusBadge";
import { ARAgingPanel } from "./components/ARAgingPanel";
import { InvoiceMetricsPanel } from "./components/InvoiceMetricsPanel";
import { AccountsPayablePanel } from "./components/AccountsPayablePanel";
import { ProfitLossPanel, CashFlowPanel, CompReconPanel, BusinessHealth } from "./components/BusinessHealthPanel";
import { TransfersPanel } from "./components/TransfersPanel";
import { DedupPanel } from "./components/DedupPanel";
import { PayrollPortal } from "./components/PayrollPortal";
import AskAqtPM from "./components/AskAqtPM";
import DataGaps from "./components/DataGaps";
import DailyProfitabilityKPI from "./components/DailyProfitabilityKPI";
import OverheadRatePanel from "./components/OverheadRatePanel";
import DecisionsRegister from "./components/DecisionsRegister";
import { BdWorkspace } from "./components/BdWorkspace";
import { FreshnessBanner } from "./components/FreshnessBanner";
import { PayrollExpenseSummary } from "./components/PayrollExpenseSummary";
import { TimesheetsWorkspace } from "./components/TimesheetsWorkspace";
import { TimesheetSubmitAlert } from "./components/TimesheetSubmitAlert";
import { TransitionInboxPanel } from "./components/TransitionInboxPanel";
import { useAutoSortableTables } from "./components/useAutoSortableTables";
import { GroupedList } from "./components/GroupedList";
import { AccountingWorkspace, PLReport } from "./components/AccountingWorkspace";
import { BookkeepingWorkspace } from "./components/BookkeepingWorkspace";
import { CategorizationWorkspace } from "./components/CategorizationWorkspace";
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
  AccountsPayable,
  CashFlow,
  CompRecon,
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
  | "bd"
  | "time"
  | "invoices"
  | "invoicegen"
  | "costs"
  | "categorize"
  | "payroll"
  | "accounting"
  | "bookkeeping"
  | "reports"
  | "imports"
  | "settings";

type TimeTab = "enter" | "timesheets";

const DEV_AUTH_ENABLED = process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true";

// Shared cursor for drill-down (clickable dashboard figures → detail tab)
const drillStyle = { cursor: "pointer" } as const;

type NavLeaf = { key: WorkspaceKey; label: string; hint: string; requires?: string };
type NavGroup = { groupKey: string; label: string; hint: string; children: NavLeaf[] };
type NavEntry = NavLeaf | NavGroup;

function isNavGroup(entry: NavEntry): entry is NavGroup {
  return "children" in entry;
}

// Consolidated IA: 6 top-level entries (Time merges enter+timesheets; Financial &
// Settings are grouped with submenus) — down from 14 flat items.
const NAV: NavEntry[] = [
  { key: "dashboard", label: "Dashboard", hint: "Snapshot" },
  { key: "projects", label: "Projects", hint: "Pipeline + setup" },
  {
    groupKey: "bizdev",
    label: "Business Dev",
    hint: "Pursuits · clients",
    children: [
      { key: "bd", label: "Pipeline", hint: "Pursuits + go/no-go" },
      { key: "clients", label: "Clients", hint: "Relationships" },
    ],
  },
  { key: "time", label: "Time", hint: "Hours + timesheets" },
  {
    groupKey: "financial",
    label: "Financial",
    hint: "Books · payroll · billing",
    children: [
      { key: "accounting", label: "Overview", hint: "P&L · Cash Flow · Balance · Loans" },
      { key: "payroll", label: "Payroll", hint: "Journal · COGS" },
      { key: "bookkeeping", label: "Bookkeeping", hint: "Tax-remediation log" },
      { key: "categorize", label: "Categorize", hint: "Sort transactions" },
      { key: "costs", label: "Costs & Expenses", hint: "Spend + tax" },
      { key: "invoices", label: "Invoicing / A/R", hint: "Billing + receivables" },
      { key: "invoicegen", label: "Invoice Generator", hint: "Cost-plus + timesheets", requires: "canManageInvoicing" },
      { key: "reports", label: "Reports", hint: "Benchmarks" },
    ],
  },
  {
    groupKey: "admin",
    label: "Settings",
    hint: "Setup & data",
    children: [
      { key: "settings", label: "Preferences", hint: "Lean admin" },
      { key: "imports", label: "Imports", hint: "FreshBooks transition" },
    ],
  },
];

const NAV_LEAVES: NavLeaf[] = NAV.flatMap((entry) => (isNavGroup(entry) ? entry.children : [entry]));
const labelForWorkspace = (key: WorkspaceKey): string =>
  NAV_LEAVES.find((leaf) => leaf.key === key)?.label ?? "";

// Dashboard subtabs — show one group at a time so the page isn't a long scroll.
const DASH_TABS = [
  { key: "overview", label: "Overview" },
  { key: "financials", label: "P&L · Cash flow" },
  { key: "receivables", label: "Receivables" },
  { key: "hours", label: "Hours" },
] as const;
type DashTab = (typeof DASH_TABS)[number]["key"];

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

// Snap any YYYY-MM-DD to the Monday of its week (local), for generating a chosen week.
function mondayOfIso(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return weekStartIso();
  const dt = new Date(y, m - 1, d);
  const mondayOffset = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - mondayOffset);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

type PeriodPreset = "ytd" | "month" | "lastmonth" | "y2025" | "custom";

function periodRange(preset: PeriodPreset): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = iso(now);
  switch (preset) {
    case "month":
      return { start: iso(new Date(y, m, 1)), end: today };
    case "lastmonth":
      return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 0)) };
    case "y2025":
      return { start: "2025-01-01", end: "2025-12-31" };
    case "ytd":
    default:
      return { start: iso(new Date(y, 0, 1)), end: today };
  }
}

const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "ytd", label: "YTD" },
  { key: "month", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "y2025", label: "2025" },
  { key: "custom", label: "Custom" },
];

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function AquatechPmHome() {
  useAutoSortableTables();

  const [workspace, setWorkspace] = useState<WorkspaceKey>("dashboard");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [timeTab, setTimeTab] = useState<TimeTab>("enter");
  const [dashTab, setDashTab] = useState<DashTab>("overview");
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [companyMonthHours, setCompanyMonthHours] = useState<number | null>(null);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [adminTimesheets, setAdminTimesheets] = useState<AdminTimesheet[]>([]);
  const [staffList, setStaffList] = useState<User[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [reportRange, setReportRange] = useState<ProjectPerformanceRange | null>(null);
  const [projectPerformance, setProjectPerformance] = useState<ProjectPerformanceRow[]>([]);
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceRevenueStatus | null>(null);
  const [businessHealth, setBusinessHealth] = useState<BusinessHealth | null>(null);
  const [cashflow, setCashflow] = useState<CashFlow | null>(null);
  const [compRecon, setCompRecon] = useState<CompRecon | null>(null);
  const [ownerAnnualSalary, setOwnerAnnualSalary] = useState<number>(206398.4);
  const [finPeriod, setFinPeriod] = useState<{ preset: PeriodPreset; start: string; end: string }>(() => ({ preset: "ytd", ...periodRange("ytd") }));
  const [accountingBasis, setAccountingBasis] = useState<"cash" | "accrual">("cash");
  const [netAfterSalary, setNetAfterSalary] = useState<boolean>(false);
  // Headline net-income view: "book" (owner draws counted as distributions, matches the
  // S-corp filing) vs "after salary" (the owner's reasonable comp expensed, prorated to the
  // displayed period). Uses the SAME math as ProfitLossPanel's adjNet so the headline card
  // and the P&L panel below it always agree.
  const _bhPeriodDays = businessHealth
    ? Math.max(0, Math.round((new Date(businessHealth.period.end).getTime() - new Date(businessHealth.period.start).getTime()) / 86400000) + 1)
    : 0;
  const ownerSalaryThisPeriod = (ownerAnnualSalary || 0) * (_bhPeriodDays / 365);
  const _bookNet = businessHealth?.waterfall.net_income ?? 0;
  const _bookRev = businessHealth?.waterfall.revenue ?? 0;
  const shownNetIncome = netAfterSalary ? _bookNet - ownerSalaryThisPeriod : _bookNet;
  const shownNetMargin = netAfterSalary ? (_bookRev ? shownNetIncome / _bookRev : null) : (businessHealth?.waterfall.net_margin ?? null);
  useEffect(() => {
    if (!user || !deriveUserCapabilities(user).canViewFinancials) return;
    if (!finPeriod.start || !finPeriod.end) return;
    const qs = `?start=${finPeriod.start}&end=${finPeriod.end}&basis=${accountingBasis}`;
    apiGet<BusinessHealth>(`/accounting/business-health${qs}`)
      .then((d) => setBusinessHealth(d)).catch(() => setBusinessHealth(null));
    apiGet<InvoiceRevenueStatus>(`/reports/invoice-revenue-status?start=${finPeriod.start}&end=${finPeriod.end}`)
      .then((d) => setInvoiceStatus(d)).catch(() => undefined);
    apiGet<CashFlow>(`/accounting/cashflow?start=${finPeriod.start}&end=${finPeriod.end}`)
      .then((d) => setCashflow(d)).catch(() => setCashflow(null));
    apiGet<CompRecon>(`/accounting/comp-reconciliation?start=${finPeriod.start}&end=${finPeriod.end}`)
      .then((d) => setCompRecon(d)).catch(() => setCompRecon(null));
    apiGet<AccountsPayable>(`/reports/accounts-payable`)
      .then((d) => setPayable(d)).catch(() => setPayable(null));
  }, [finPeriod.start, finPeriod.end, accountingBasis, user]);
  const [payable, setPayable] = useState<AccountsPayable | null>(null);
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

  // Back-office = anyone with an admin/manager capability. A pure employee has none.
  const isBackOffice =
    capabilities.canViewFinancials ||
    capabilities.canApproveTimesheets ||
    capabilities.canManageProjects ||
    capabilities.canManageInvoicing ||
    capabilities.canManageUsers;

  // The launchpad "timekeeping beta" link lands on /?timesheet_only=1. That forces the
  // focused time-only view even for admins. A non-admin employee always gets it.
  const [forceTimeOnly, setForceTimeOnly] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setForceTimeOnly(params.get("timesheet_only") === "1");
  }, []);
  const timeOnly = forceTimeOnly || (!!user && !isBackOffice);

  // Drop time-only users straight onto their own timesheet instead of the Dashboard.
  useEffect(() => {
    if (timeOnly) setWorkspace("time");
  }, [timeOnly]);

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
      if (canApproveTimesheetsLocal || deriveUserCapabilities(activeUser).canViewFinancials) {
        // Company-wide hours this month for the dashboard tile (whole team, not just the viewer).
        const msIso = startOfMonthIso();
        apiGet<TimeEntry[]>(`/time-entries?start=${msIso}&end=${monthEnd}&team=true`)
          .then((rows) => setCompanyMonthHours((rows || []).reduce((s, r) => s + (r.hours || 0), 0)))
          .catch(() => setCompanyMonthHours(null));
      }
      if (deriveUserCapabilities(activeUser).canViewFinancials) {
        // Fire-and-forget YTD P&L for the dashboard net-income / margin tiles.
        // P&L + Business Health are period-driven; fetched by the finPeriod effect below.
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

  async function handleGenerateTimesheet(weekStart?: string) {
    // Snap any picked date to that week's Monday so future/prior weeks generate cleanly.
    const ws = weekStart ? mondayOfIso(weekStart) : weekStartIso();
    setSubmitting("timesheet-generate");
    setFlash(null);
    setError(null);
    try {
      await apiPost<Timesheet>(`/timesheets/generate?week_start=${ws}`);
      setFlash(ws === weekStartIso() ? "This week’s timesheet is ready." : "Timesheet ready for the selected week.");
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
            onClick={() => {
              const el = document.documentElement;
              const dark = el.getAttribute("data-theme") === "dark";
              if (dark) el.removeAttribute("data-theme");
              else el.setAttribute("data-theme", "dark");
              try {
                localStorage.setItem("aqt-theme", dark ? "light" : "dark");
              } catch {}
            }}
            title="Toggle light / dark mode"
          >
            ◑ Theme
          </button>
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
          {(timeOnly ? NAV.filter((entry) => !isNavGroup(entry) && (entry as NavLeaf).key === "time") : NAV).map((entry) => {
            if (!isNavGroup(entry)) {
              if (entry.requires && !(capabilities as Record<string, boolean>)[entry.requires]) return null;
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={classNames("aq-lite-nav-item", workspace === entry.key && "active")}
                  onClick={() => setWorkspace(entry.key)}
                >
                  <span>{entry.label}</span>
                  <small>{entry.hint}</small>
                </button>
              );
            }
            const childKeys = entry.children.map((c) => c.key);
            const containsActive = childKeys.includes(workspace);
            const open = entry.groupKey in openGroups ? openGroups[entry.groupKey] : containsActive;
            return (
              <div key={entry.groupKey} className="aq-lite-nav-group">
                <button
                  type="button"
                  className={classNames("aq-lite-nav-item", "aq-lite-nav-group-head", containsActive && "active-parent")}
                  aria-expanded={open}
                  onClick={() => setOpenGroups((g) => ({ ...g, [entry.groupKey]: !open }))}
                >
                  <span>{entry.label}</span>
                  <small>{open ? "▾" : "▸"} {entry.hint}</small>
                </button>
                {open
                  ? entry.children
                      .filter((child) => !child.requires || (capabilities as Record<string, boolean>)[child.requires])
                      .map((child) => (
                      <button
                        key={child.key}
                        type="button"
                        className={classNames("aq-lite-nav-item", "aq-lite-nav-child", workspace === child.key && "active")}
                        onClick={() => setWorkspace(child.key)}
                      >
                        <span>{child.label}</span>
                        <small>{child.hint}</small>
                      </button>
                    ))
                  : null}
              </div>
            );
          })}
        </nav>
        {timeOnly ? (
          forceTimeOnly && isBackOffice ? (
            <div className="aq-lite-sidebar-card">
              <p className="aq-lite-sidebar-label">Focused view</p>
              <a href="/" className="aq-lite-nav-item" style={{ textDecoration: "none" }}>
                <span>Full app →</span>
                <small>Dashboard, financials, settings</small>
              </a>
            </div>
          ) : null
        ) : capabilities.canViewFinancials ? (
          <div className="aq-lite-sidebar-card">
            <p className="aq-lite-sidebar-label">Business posture</p>
            <strong>{formatCurrency(invoiceStatus?.total_outstanding)} open receivables</strong>
            <span>{headlineMetrics.activeProjects} active projects</span>
          </div>
        ) : null}
      </aside>

      <main className="aq-lite-main">
        <header className="aq-lite-topbar">
          <div>
            <p className="aq-lite-eyebrow">Small business operating system</p>
            <h1>{labelForWorkspace(workspace)}</h1>
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

        {capabilities.canViewFinancials ? <FreshnessBanner /> : null}

        {capabilities.canApproveTimesheets && workspace === "dashboard" ? (
          <TimesheetSubmitAlert
            adminTimesheets={adminTimesheets}
            onReview={() => {
              setTimeTab("timesheets");
              setWorkspace("time");
            }}
          />
        ) : null}

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
            {capabilities.canViewFinancials ? <AskAqtPM /> : null}
            {capabilities.canManageUsers ? <DataGaps /> : null}
            {capabilities.canManageUsers ? <DecisionsRegister /> : null}
            {capabilities.canViewFinancials ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
                <span style={{ opacity: 0.6, fontSize: "0.8em", marginRight: "0.2rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Period</span>
                {PERIOD_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() =>
                      p.key === "custom"
                        ? setFinPeriod((s) => ({ ...s, preset: "custom" }))
                        : setFinPeriod({ preset: p.key, ...periodRange(p.key) })
                    }
                    style={{
                      padding: "0.3rem 0.85rem",
                      borderRadius: "999px",
                      cursor: "pointer",
                      fontSize: "0.82em",
                      transition: "background 0.12s ease, border-color 0.12s ease, color 0.12s ease",
                      border: finPeriod.preset === p.key ? "1px solid #7d97ff" : "1px solid #6b8198",
                      background: finPeriod.preset === p.key ? "#4f63c9" : "#37485c",
                      color: finPeriod.preset === p.key ? "#ffffff" : "#eef3fa",
                      fontWeight: finPeriod.preset === p.key ? 700 : 600,
                      boxShadow: finPeriod.preset === p.key ? "0 0 0 2px rgba(125,151,255,0.30)" : "none",
                    }}
                  >
                    {p.label}
                  </button>
                ))}
                {finPeriod.preset === "custom" ? (
                  <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                    <input type="date" value={finPeriod.start} max={finPeriod.end} onChange={(e) => setFinPeriod((s) => ({ ...s, start: e.target.value }))} style={{ fontSize: "0.82em" }} />
                    <span style={{ opacity: 0.6 }}>→</span>
                    <input type="date" value={finPeriod.end} min={finPeriod.start} onChange={(e) => setFinPeriod((s) => ({ ...s, end: e.target.value }))} style={{ fontSize: "0.82em" }} />
                  </span>
                ) : null}
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
                  <span style={{ fontSize: "0.72em", textTransform: "uppercase", letterSpacing: "0.04em", color: "#9fb2c8", fontWeight: 700 }} title="Show net income with your reasonable owner salary expensed, or as booked (draws = distributions)">Net</span>
                  {([false, true] as const).map((after) => (
                    <button
                      key={after ? "after" : "book"}
                      type="button"
                      onClick={() => setNetAfterSalary(after)}
                      title={after ? `Expense your reasonable owner salary (${formatCurrency(ownerAnnualSalary)}/yr · ${formatCurrency(ownerSalaryThisPeriod)} this period) → true operating profit` : "Book net income — owner draws counted as distributions (matches your S-corp filing)"}
                      style={{
                        padding: "0.22rem 0.65rem",
                        borderRadius: "999px",
                        cursor: "pointer",
                        fontSize: "0.78em",
                        transition: "background 0.12s ease, border-color 0.12s ease, color 0.12s ease",
                        border: netAfterSalary === after ? "1px solid #57c4a6" : "1px solid #6b8198",
                        background: netAfterSalary === after ? "#2f8f76" : "#37485c",
                        color: netAfterSalary === after ? "#ffffff" : "#eef3fa",
                        fontWeight: netAfterSalary === after ? 700 : 600,
                        boxShadow: netAfterSalary === after ? "0 0 0 2px rgba(87,196,166,0.28)" : "none",
                      }}
                    >
                      {after ? "After salary" : "Book"}
                    </button>
                  ))}
                  <span aria-hidden style={{ width: 1, height: 16, background: "rgba(150,160,190,0.4)", margin: "0 0.25rem" }} />
                  {(["cash", "accrual"] as const).map((b) => (
                    <button
                      key={b}
                      type="button"
                      onClick={() => setAccountingBasis(b)}
                      title={b === "cash" ? "Cash basis — revenue recognized when collected (matches your tax filing)" : "Accrual basis — revenue recognized when invoiced"}
                      style={{
                        padding: "0.22rem 0.65rem",
                        borderRadius: "999px",
                        cursor: "pointer",
                        fontSize: "0.78em",
                        transition: "background 0.12s ease, border-color 0.12s ease, color 0.12s ease",
                        border: accountingBasis === b ? "1px solid #d9a14f" : "1px solid #6b8198",
                        background: accountingBasis === b ? "#b9803c" : "#37485c",
                        color: accountingBasis === b ? "#ffffff" : "#eef3fa",
                        fontWeight: accountingBasis === b ? 700 : 600,
                        boxShadow: accountingBasis === b ? "0 0 0 2px rgba(217,161,79,0.28)" : "none",
                      }}
                    >
                      {b === "cash" ? "Cash" : "Accrual"}
                    </button>
                  ))}
                  <span style={{ opacity: 0.5, fontSize: "0.78em" }}>{finPeriod.start} → {finPeriod.end}</span>
                </span>
              </div>
            ) : null}
            <div className="aq-lite-hero">
              <div>
                <p className="aq-lite-eyebrow">Overview</p>
                <h2>{`Welcome back${headlineMetrics.activeProjects ? `, ${headlineMetrics.activeProjects} active project${headlineMetrics.activeProjects === 1 ? "" : "s"}` : ""}.`}</h2>
                <p>
                  Project delivery, time, billing, collections, and reporting — all on one screen.
                </p>
              </div>
              <div className="aq-lite-hero-grid">
                <article className="aq-lite-kpi" style={drillStyle} title="View projects →" onClick={() => setWorkspace("projects")}>
                  <span>Active projects ↗</span>
                  <strong>{headlineMetrics.activeProjects}</strong>
                </article>
                <article className="aq-lite-kpi" style={drillStyle} title="View timesheets →" onClick={() => { setTimeTab("timesheets"); setWorkspace("time"); }}>
                  <span>Month hours logged ↗</span>
                  <strong>{formatNumber(companyMonthHours ?? headlineMetrics.monthHours, 1)}</strong>
                </article>
                <article className="aq-lite-kpi" style={drillStyle} title="View invoices →" onClick={() => setWorkspace("invoices")}>
                  <span>{accountingBasis === "cash" ? "Collected" : "Invoiced"} ({PERIOD_PRESETS.find((p) => p.key === finPeriod.preset)?.label ?? "period"}) ↗</span>
                  <strong>{formatCurrency(accountingBasis === "cash" ? invoiceStatus?.collected_period : invoiceStatus?.invoiced_period)}</strong>
                </article>
                <article className="aq-lite-kpi" style={drillStyle} title="View invoices →" onClick={() => setWorkspace("invoices")}>
                  <span>Open invoices (now) ↗</span>
                  <strong>{headlineMetrics.openInvoices}</strong>
                </article>
                <article
                  className="aq-lite-kpi"
                  style={drillStyle}
                  title={`Billable hours entered but not yet on any invoice${
                    unbilledHours?.billable.totals.value != null
                      ? ` · ${formatCurrency(unbilledHours.billable.totals.value)} unbilled value`
                      : ""
                  } — View invoices →`}
                  onClick={() => setWorkspace("invoices")}
                >
                  <span>Unbilled hours (now) ↗</span>
                  <strong>{formatNumber(unbilledHours?.billable.totals.hours ?? 0, 1)}</strong>
                </article>
                {businessHealth ? (
                  <>
                    <article className="aq-lite-kpi" style={drillStyle} title={netAfterSalary ? "Net income after your reasonable owner salary is expensed — View P&L →" : "Book net income (owner draws as distributions) — View P&L →"} onClick={() => setWorkspace("accounting")}>
                      <span>Net income ({PERIOD_PRESETS.find((p) => p.key === finPeriod.preset)?.label ?? "period"}){netAfterSalary ? " · after salary" : ""} ↗</span>
                      <strong>{formatCurrency(shownNetIncome)}</strong>
                    </article>
                    <article className="aq-lite-kpi" style={drillStyle} title={netAfterSalary ? "Net margin after your reasonable owner salary is expensed — View P&L →" : "Book net margin — View P&L →"} onClick={() => setWorkspace("accounting")}>
                      <span>Net margin ({PERIOD_PRESETS.find((p) => p.key === finPeriod.preset)?.label ?? "period"}){netAfterSalary ? " · after salary" : ""} ↗</span>
                      <strong>{shownNetMargin != null ? `${(shownNetMargin * 100).toFixed(1)}%` : "—"}</strong>
                    </article>
                  </>
                ) : null}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0 2px" }}>
              {DASH_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setDashTab(t.key)}
                  style={{
                    border: "none", cursor: "pointer", borderRadius: 999, padding: "7px 16px",
                    fontSize: 13, fontWeight: 600,
                    background: dashTab === t.key ? "#21737e" : "var(--aq-input-bg, rgba(0,0,0,0.06))",
                    color: dashTab === t.key ? "#fff" : "inherit",
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {dashTab === "financials" ? (
              <>
                <DailyProfitabilityKPI />
                <OverheadRatePanel />
                <ProfitLossPanel data={businessHealth} ownerAnnualSalary={ownerAnnualSalary} onOwnerSalaryChange={setOwnerAnnualSalary} onNavigate={(k) => { if (k === "timesheets") { setTimeTab("timesheets"); setWorkspace("time"); } else { setWorkspace(k as WorkspaceKey); } }} />
                <CashFlowPanel data={cashflow} debt={businessHealth?.debt_outstanding ?? null} onNavigate={(k) => { if (k === "timesheets") { setTimeTab("timesheets"); setWorkspace("time"); } else { setWorkspace(k as WorkspaceKey); } }} />
                <CompReconPanel data={compRecon} onNavigate={(k) => { if (k === "timesheets") { setTimeTab("timesheets"); setWorkspace("time"); } else { setWorkspace(k as WorkspaceKey); } }} />
              </>
            ) : null}

            {dashTab === "receivables" ? (
            <div className="aq-lite-grid aq-lite-grid-2">
              <section className="aq-lite-panel">
                <div className="aq-lite-panel-head">
                  <div>
                    <p className="aq-lite-eyebrow">Billing</p>
                    <h3>Invoice pipeline</h3>
                  </div>
                </div>
                <div className="aq-lite-stat-list">
                  <div style={{ opacity: 0.55, fontSize: "0.72em", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid rgba(128,128,128,0.2)", paddingBottom: "0.2rem" }}>
                    <span>This period — {PERIOD_PRESETS.find((p) => p.key === finPeriod.preset)?.label ?? "period"}</span>
                  </div>
                  <div>
                    <span>Invoiced (billed)</span>
                    <strong>{formatCurrency(invoiceStatus?.invoiced_period)}</strong>
                  </div>
                  <div>
                    <span>Collected (paid)</span>
                    <strong>{formatCurrency(invoiceStatus?.collected_period)}</strong>
                  </div>
                  <div style={{ opacity: 0.55, fontSize: "0.72em", textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid rgba(128,128,128,0.2)", paddingBottom: "0.2rem", marginTop: "0.5rem" }}>
                    <span>As of today — balances</span>
                  </div>
                  <div>
                    <span>Outstanding (all open)</span>
                    <strong>{formatCurrency(invoiceStatus?.total_outstanding)}</strong>
                  </div>
                  {invoiceStatus?.boc_financed_advances ? (
                    <>
                      <div style={{ opacity: 0.6 }}>
                        <span>− BOC advances (financed invoices)</span>
                        <strong>({formatCurrency(invoiceStatus?.boc_financed_advances)})</strong>
                      </div>
                      <div style={{ borderTop: "1px solid rgba(128,128,128,0.28)", paddingTop: "0.35rem", fontWeight: 700 }}>
                        <span>= Net receivable (truly owed to you)</span>
                        <strong>{formatCurrency(invoiceStatus?.outstanding_net_of_boc)}</strong>
                      </div>
                    </>
                  ) : null}
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
            ) : null}

            {dashTab === "overview" ? (
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
                    <div key={project.project_id} className="aq-lite-list-row" style={drillStyle} title="View projects →" onClick={() => setWorkspace("projects")}>
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
                    <div key={client.name} className="aq-lite-list-row" style={drillStyle} title="View clients →" onClick={() => setWorkspace("clients")}>
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
            ) : null}

            {dashTab === "hours" ? (
            <>
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
                      <div key={row.user_id} className="aq-lite-list-row" style={drillStyle} title="View timesheets →" onClick={() => { setTimeTab("timesheets"); setWorkspace("time"); }}>
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
                      <div key={row.project_id} className="aq-lite-list-row" style={drillStyle} title="View invoices →" onClick={() => setWorkspace("invoices")}>
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
                      <div key={row.user_id} className="aq-lite-list-row" style={drillStyle} title="View timesheets →" onClick={() => { setTimeTab("timesheets"); setWorkspace("time"); }}>
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
                      <div key={row.project_id} className="aq-lite-list-row" style={drillStyle} title="View projects →" onClick={() => setWorkspace("projects")}>
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
                  <div key={entry.id} className="aq-lite-list-row" style={drillStyle} title="View time →" onClick={() => { setTimeTab("enter"); setWorkspace("time"); }}>
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
            </>
            ) : null}
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
                  <tr key={client.name} style={{ cursor: "pointer" }} title="View projects →" onClick={() => setWorkspace("projects")}>
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

        {workspace === "bd" ? <BdWorkspace /> : null}

        {workspace === "invoicegen" && capabilities.canManageInvoicing ? (
          <section className="aq-lite-panel">
            <div className="aq-lite-panel-head">
              <h2>Invoice Generator</h2>
              <span className="aq-lite-chip">Admin only</span>
            </div>
            <p className="aq-lite-muted">
              Generates the NYCDEP cost-plus sub-consultant invoices (HDR / LTCP4, Stantec,
              JBCON) with the FreshBooks-style backup and the pixel-perfect weekly timesheets,
              from live time data — the FreshBooks backup is reconciled to the spreadsheet total.
              The complete package is saved into the correct Drive invoice folder.
            </p>
            <p className="aq-lite-muted">
              It runs on your PC (it needs Excel and the Aquatech Drive). Make sure the local
              app is running, then open it:
            </p>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
              <a
                href="http://127.0.0.1:8765"
                target="_blank"
                rel="noreferrer"
                className="aq-lite-btn aq-lite-btn-primary"
              >
                Open Invoice Generator ↗
              </a>
              <span className="aq-lite-muted" style={{ fontSize: 12 }}>
                Not running? Double-click <code>Run Invoicing.bat</code> in the AqtPM-Invoicing
                folder, then click here.
              </span>
            </div>
          </section>
        ) : null}

        {workspace === "time" ? (
          <div className="aq-lite-stack">
            <div
              style={{
                display: "inline-flex",
                gap: 4,
                background: "var(--aq-input-bg, rgba(0,0,0,0.06))",
                borderRadius: 999,
                padding: 3,
                marginBottom: 4,
              }}
            >
              {(["enter", "timesheets"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTimeTab(t)}
                  style={{
                    border: "none",
                    cursor: "pointer",
                    borderRadius: 999,
                    padding: "6px 16px",
                    fontSize: 13,
                    fontWeight: 600,
                    background: timeTab === t ? "#21737e" : "transparent",
                    color: timeTab === t ? "#fff" : "inherit",
                  }}
                >
                  {t === "enter" ? "Enter time" : "Timesheets"}
                </button>
              ))}
            </div>
            {timeTab === "enter" && user ? (
              <DailyTimeEntry
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
            {timeTab === "timesheets" ? (
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
          </div>
        ) : null}

        {workspace === "invoices" ? (
          <div className="aq-lite-stack">
            <div className="aq-lite-grid aq-lite-grid-2">
              <InvoiceMetricsPanel invoices={invoices} />
              <AccountsPayablePanel payable={payable} owedToYou={invoiceStatus?.total_outstanding ?? 0} />
            </div>
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
                    {(() => {
                      const bal = invoice.balance_due || 0; // already net of any financing advance
                      const pct = Math.min(Math.max(invoice.financed_pct || 0, 0), 1);
                      const advanced = (invoice.subtotal_amount || 0) * pct;
                      if (bal <= 0.01) {
                        return <span style={{ textAlign: "right", fontWeight: 600, color: "var(--aq-green)" }}>Paid</span>;
                      }
                      return (
                        <span style={{ textAlign: "right", fontWeight: 600, color: "var(--aq-red)" }}>
                          {formatCurrency(bal)}
                          {pct > 0 ? (
                            <span
                              title={`${formatCurrency(advanced)} (${Math.round(pct * 100)}%) already advanced by ${invoice.financed_source || "financier"}; ${formatCurrency(bal)} holdback still owed`}
                              style={{ display: "block", fontSize: 9.5, fontWeight: 500, color: "#1f8a5b" }}
                            >
                              {Math.round(pct * 100)}% advanced
                            </span>
                          ) : null}
                        </span>
                      );
                    })()}
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
          <div className="aq-lite-stack">
          <PLReport />
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
          </div>
        ) : null}

        {workspace === "categorize" ? <CategorizationWorkspace /> : null}

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
