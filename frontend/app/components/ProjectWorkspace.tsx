"use client";

import { FormEvent, Dispatch, SetStateAction, useMemo, useState } from "react";
import {
  Invoice,
  Project,
  ProjectExpense,
  ProjectLifecycleStatus,
  ProjectPerformanceRow,
  TimeEntry,
  formatCurrency,
  formatNumber,
  formatPercent,
} from "./workspaceShared";
import { StatusBadge } from "./StatusBadge";
import { DetailDrawer } from "./DetailDrawer";
import { GroupedList } from "./GroupedList";
import { TeamPanel, StaffOption } from "./TeamPanel";
import { apiPatch } from "../../lib/api";

const LIFECYCLE_OPTIONS: { value: ProjectLifecycleStatus; label: string }[] = [
  { value: "planning", label: "Planning" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

function statusLabel(p: Project): string {
  return p.lifecycle_status || (p.is_active ? "active" : "completed");
}

type ProjectFormState = {
  name: string;
  client_name: string;
  overall_budget_fee: string;
  target_gross_margin_pct: string;
};

type ProjectWorkspaceProps = {
  projects: Project[];
  projectForm: ProjectFormState;
  setProjectForm: Dispatch<SetStateAction<ProjectFormState>>;
  onCreateProject: (event: FormEvent<HTMLFormElement>) => void;
  submitting: string | null;
  canManageProjects: boolean;
  performance?: ProjectPerformanceRow[];
  timeEntries?: TimeEntry[];
  invoices?: Invoice[];
  expenses?: ProjectExpense[];
  staffOptions?: StaffOption[];
};

export function ProjectWorkspace({
  projects,
  projectForm,
  setProjectForm,
  onCreateProject,
  submitting,
  canManageProjects,
  performance = [],
  timeEntries = [],
  invoices = [],
  expenses = [],
  staffOptions = [],
}: ProjectWorkspaceProps) {
  const [search, setSearch] = useState("");
  type StatusFilter = "active" | "completed" | "paused_planning" | "all";
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [drawerProjectId, setDrawerProjectId] = useState<number | null>(null);

  const deliveryProjects = useMemo(
    () => projects.filter((project) => !project.is_overhead),
    [projects],
  );

  const visibleProjects = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return deliveryProjects.filter((project) => {
      const status = statusLabel(project);
      const matchesStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "active"
            ? status === "active"
            : statusFilter === "completed"
              ? status === "completed"
              : status === "paused" || status === "planning" || status === "cancelled";
      const matchesSearch =
        normalizedSearch.length === 0 ||
        project.name.toLowerCase().includes(normalizedSearch) ||
        (project.client_name || "").toLowerCase().includes(normalizedSearch);
      return matchesStatus && matchesSearch;
    });
  }, [deliveryProjects, search, statusFilter]);

  const performanceById = useMemo(() => {
    const m = new Map<number, ProjectPerformanceRow>();
    for (const row of performance) m.set(row.project_id, row);
    return m;
  }, [performance]);

  const hoursByProject = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of timeEntries) m.set(e.project_id, (m.get(e.project_id) || 0) + e.hours);
    return m;
  }, [timeEntries]);

  const invoicesByProject = useMemo(() => {
    const m = new Map<number, { count: number; outstanding: number }>();
    for (const inv of invoices) {
      if (!inv.project_id) continue;
      const cur = m.get(inv.project_id) || { count: 0, outstanding: 0 };
      cur.count += 1;
      cur.outstanding += inv.balance_due || 0;
      m.set(inv.project_id, cur);
    }
    return m;
  }, [invoices]);

  const summary = useMemo(() => {
    const activeProjects = deliveryProjects.filter((project) => project.is_active);
    const clientCount = new Set(activeProjects.map((project) => project.client_name || "Unassigned")).size;
    const totalBudget = activeProjects.reduce((sum, project) => sum + project.overall_budget_fee, 0);
    const totalRevenue = performance.reduce((sum, p) => sum + (p.actual_revenue || 0), 0);
    const totalHours = Array.from(hoursByProject.values()).reduce((s, h) => s + h, 0);
    return { activeCount: activeProjects.length, clientCount, totalBudget, totalRevenue, totalHours };
  }, [deliveryProjects, performance, hoursByProject]);

  const drawerProject = useMemo(
    () => (drawerProjectId !== null ? deliveryProjects.find((p) => p.id === drawerProjectId) || null : null),
    [drawerProjectId, deliveryProjects],
  );

  return (
    <div className="aq-lite-stack">
      <div className="aq-lite-grid aq-lite-grid-3">
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Portfolio</p>
          <h3>{summary.activeCount} active projects</h3>
          <p className="aq-lite-muted">Only delivery work is shown here. Overhead stays out of the main operating path.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Client spread</p>
          <h3>{summary.clientCount} active clients</h3>
          <p className="aq-lite-muted">A small client roster is easier to manage when project setup stays standardized.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Budgeted value</p>
          <h3>{formatCurrency(summary.totalBudget)}</h3>
          <p className="aq-lite-muted">Visible fee budgets on every active project keep delivery and billing aligned.</p>
        </section>
      </div>

      <div className="aq-lite-stack">
        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Projects</p>
              <h3>Click any row for full project context</h3>
            </div>
          </div>
          <div className="aq-lite-toolbar">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search project or client"
            />
            <div className="aq-lite-segmented">
              {[
                { key: "active", label: "Active" },
                { key: "completed", label: "Completed" },
                { key: "paused_planning", label: "Other" },
                { key: "all", label: "All" },
              ].map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={statusFilter === option.key ? "active" : ""}
                  onClick={() => setStatusFilter(option.key as StatusFilter)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <table className="aq-lite-table aq-table-compact">
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Hours</th>
                <th style={{ textAlign: "right" }}>Revenue</th>
                <th style={{ textAlign: "right" }}>Cost</th>
                <th style={{ textAlign: "right" }}>Margin</th>
                <th style={{ textAlign: "right" }}>Open A/R</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.map((project) => {
                const perf = performanceById.get(project.id);
                const hours = hoursByProject.get(project.id) || 0;
                const inv = invoicesByProject.get(project.id) || { count: 0, outstanding: 0 };
                const revenue = perf?.actual_revenue || 0;
                const cost = perf?.actual_cost || 0;
                const margin = perf?.margin_pct || 0;
                return (
                  <tr
                    key={project.id}
                    onClick={() => setDrawerProjectId(project.id)}
                    style={{ cursor: "pointer" }}
                    title="Click to open project detail"
                  >
                    <td>
                      <strong>{project.name}</strong>
                    </td>
                    <td>{project.client_name || "—"}</td>
                    <td>
                      <StatusBadge status={statusLabel(project)} />
                    </td>
                    <td style={{ textAlign: "right" }}>{formatNumber(hours, 1)}</td>
                    <td style={{ textAlign: "right" }}>{formatCurrency(revenue)}</td>
                    <td style={{ textAlign: "right", color: cost > 0 ? "var(--aq-muted)" : undefined }}>
                      {formatCurrency(cost)}
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        color:
                          margin >= (project.target_gross_margin_pct || 0)
                            ? "var(--aq-green)"
                            : margin >= 0
                              ? undefined
                              : "var(--aq-red)",
                        fontWeight: 600,
                      }}
                    >
                      {revenue > 0 ? formatPercent(margin) : "—"}
                    </td>
                    <td style={{ textAlign: "right", color: inv.outstanding > 0 ? "var(--aq-red)" : undefined }}>
                      {inv.outstanding > 0 ? formatCurrency(inv.outstanding) : inv.count > 0 ? "—" : ""}
                    </td>
                  </tr>
                );
              })}
              {visibleProjects.length === 0 ? (
                <tr>
                  <td colSpan={8} className="aq-lite-muted">
                    No projects match the current filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">New project</p>
              <h3>Minimal setup</h3>
            </div>
          </div>
          <form className="aq-lite-form" onSubmit={onCreateProject}>
            <label>
              Project name
              <input
                value={projectForm.name}
                onChange={(event) => setProjectForm((current) => ({ ...current, name: event.target.value }))}
                required
              />
            </label>
            <label>
              Client name
              <input
                value={projectForm.client_name}
                onChange={(event) => setProjectForm((current) => ({ ...current, client_name: event.target.value }))}
              />
            </label>
            <div className="aq-lite-form-grid">
              <label>
                Budget fee
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={projectForm.overall_budget_fee}
                  onChange={(event) =>
                    setProjectForm((current) => ({ ...current, overall_budget_fee: event.target.value }))
                  }
                />
              </label>
              <label>
                Target margin %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={projectForm.target_gross_margin_pct}
                  onChange={(event) =>
                    setProjectForm((current) => ({ ...current, target_gross_margin_pct: event.target.value }))
                  }
                />
              </label>
            </div>
            <div className="aq-lite-note">
              <strong>Keep setup short</strong>
              <p>Only create the project, client, fee target, and margin target here. WBS detail can follow only when needed.</p>
            </div>
            <button type="submit" disabled={submitting === "project" || !canManageProjects}>
              {submitting === "project" ? "Creating…" : "Create project"}
            </button>
          </form>
        </section>
      </div>

      <DetailDrawer
        open={drawerProject !== null}
        onClose={() => setDrawerProjectId(null)}
        title={drawerProject?.name || ""}
        subtitle={drawerProject?.client_name || ""}
        width={820}
      >
        {drawerProject ? (
          <ProjectDetailDrawerBody
            project={drawerProject}
            perf={performanceById.get(drawerProject.id)}
            hours={hoursByProject.get(drawerProject.id) || 0}
            timeEntries={timeEntries.filter((e) => e.project_id === drawerProject.id)}
            invoices={invoices.filter((i) => i.project_id === drawerProject.id)}
            expenses={expenses.filter((e) => e.project_id === drawerProject.id)}
            staffOptions={staffOptions}
            canManage={canManageProjects}
            onStatusChanged={() => {
              /* Caller will refresh project list on next data load. Drawer
                 state can also close to force user back to refreshed list. */
              setDrawerProjectId(null);
            }}
          />
        ) : null}
      </DetailDrawer>
    </div>
  );
}


function ProjectDetailDrawerBody({
  project,
  perf,
  hours,
  timeEntries,
  invoices,
  expenses,
  staffOptions,
  canManage,
  onStatusChanged,
}: {
  project: Project;
  perf: ProjectPerformanceRow | undefined;
  hours: number;
  timeEntries: TimeEntry[];
  invoices: Invoice[];
  expenses: ProjectExpense[];
  staffOptions: StaffOption[];
  canManage: boolean;
  onStatusChanged?: () => void;
}) {
  const targetMargin = project.target_gross_margin_pct || 0;
  const actualMargin = perf?.margin_pct || 0;
  const totalExpense = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const currentStatus = (project.lifecycle_status || (project.is_active ? "active" : "completed")) as ProjectLifecycleStatus;
  const [statusBusy, setStatusBusy] = useState(false);

  async function changeStatus(next: ProjectLifecycleStatus) {
    if (next === currentStatus) return;
    setStatusBusy(true);
    try {
      await apiPatch(`/projects/${project.id}/status`, { lifecycle_status: next });
      onStatusChanged?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update status");
    } finally {
      setStatusBusy(false);
    }
  }

  return (
    <div className="aq-lite-stack" style={{ gap: 16 }}>
      {/* Stage selector */}
      <section
        className="aq-lite-panel"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Stage</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <StatusBadge status={currentStatus} />
            {project.completed_date ? (
              <span style={{ fontSize: 11, color: "var(--aq-muted)" }}>
                Completed {project.completed_date}
              </span>
            ) : null}
          </div>
        </div>
        {canManage ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--aq-muted)" }}>Set status:</span>
            <select
              value={currentStatus}
              onChange={(e) => void changeStatus(e.target.value as ProjectLifecycleStatus)}
              disabled={statusBusy}
              style={{ padding: "4px 8px", fontSize: 13 }}
            >
              {LIFECYCLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      {/* Header KPIs */}
      <div className="aq-lite-grid aq-lite-grid-3">
        <article className="aq-lite-kpi">
          <span>Budget fee</span>
          <strong>{formatCurrency(project.overall_budget_fee)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Revenue</span>
          <strong>{formatCurrency(perf?.actual_revenue || 0)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Margin</span>
          <strong style={{ color: actualMargin >= targetMargin ? "var(--aq-green)" : actualMargin >= 0 ? undefined : "var(--aq-red)" }}>
            {(perf?.actual_revenue || 0) > 0 ? formatPercent(actualMargin) : "—"}
          </strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Cost</span>
          <strong>{formatCurrency(perf?.actual_cost || 0)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Expenses</span>
          <strong>{formatCurrency(totalExpense)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Hours</span>
          <strong>{formatNumber(hours, 1)}</strong>
        </article>
      </div>

      {/* Team */}
      <section className="aq-lite-panel">
        <TeamPanel projectId={project.id} canManage={canManage} staffOptions={staffOptions} />
      </section>

      {/* Time entries — groupable */}
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Time entries ({timeEntries.length})</p>
        <GroupedList
          rows={timeEntries}
          persistKey={`proj-${project.id}-time`}
          searchPredicate={(e, q) => `${e.task_name || ""} ${e.note}`.toLowerCase().includes(q)}
          searchPlaceholder="Search task / note"
          emptyHint="No time logged on this project yet."
          groupOptions={[
            {
              key: "month",
              label: "Month",
              groupBy: (e) => (e.work_date || "").slice(0, 7) || "—",
              sortBuckets: (a, b) => b.localeCompare(a), // newest first
            },
            {
              key: "task",
              label: "Task",
              groupBy: (e) => e.task_name || "(no task)",
            },
            {
              key: "user",
              label: "Person",
              groupBy: (e) => {
                const u = staffOptions.find((s) => s.id === e.user_id);
                return u?.full_name || `User ${e.user_id}`;
              },
            },
          ]}
          renderGroupSummary={(items) => {
            const h = items.reduce((s, e) => s + (e.hours || 0), 0);
            const $ = items.reduce((s, e) => s + (e.hours || 0) * (e.bill_rate_applied || 0), 0);
            return `${formatNumber(h, 1)}h · ${formatCurrency($)}`;
          }}
          renderRow={(e) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 80px 110px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
              }}
            >
              <span style={{ color: "var(--aq-muted)" }}>{e.work_date}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.task_name || "—"}
                {e.note ? <span style={{ color: "var(--aq-muted)" }}> · {e.note}</span> : null}
              </span>
              <span style={{ textAlign: "right" }}>{formatNumber(e.hours, 1)}h</span>
              <span style={{ textAlign: "right" }}>
                {formatCurrency((e.hours || 0) * (e.bill_rate_applied || 0))}
              </span>
            </div>
          )}
          initiallyOpen="first"
        />
      </section>

      {/* Invoices — groupable */}
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Invoices ({invoices.length})</p>
        <GroupedList
          rows={invoices}
          persistKey={`proj-${project.id}-inv`}
          searchPredicate={(i, q) => `${i.invoice_number} ${i.status}`.toLowerCase().includes(q)}
          searchPlaceholder="Search invoice # / status"
          emptyHint="No invoices for this project."
          groupOptions={[
            {
              key: "status",
              label: "Status",
              groupBy: (i) => i.status || "(no status)",
            },
            {
              key: "month",
              label: "Issue month",
              groupBy: (i) => (i.issue_date || "").slice(0, 7) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "year",
              label: "Issue year",
              groupBy: (i) => (i.issue_date || "").slice(0, 4) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
          ]}
          renderGroupSummary={(items) => {
            const total = items.reduce((s, i) => s + (i.subtotal_amount || 0), 0);
            const open = items.reduce((s, i) => s + (i.balance_due || 0), 0);
            return `${formatCurrency(total)} billed${open > 0 ? ` · ${formatCurrency(open)} open` : ""}`;
          }}
          renderRow={(inv) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr 90px 110px 110px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
              }}
            >
              <strong>{inv.invoice_number}</strong>
              <span style={{ color: "var(--aq-muted)" }}>{inv.issue_date} · {inv.client_name || ""}</span>
              <span><StatusBadge status={inv.status} /></span>
              <span style={{ textAlign: "right" }}>{formatCurrency(inv.subtotal_amount)}</span>
              <span
                style={{
                  textAlign: "right",
                  color: (inv.balance_due || 0) > 0 ? "var(--aq-red)" : "var(--aq-green)",
                  fontWeight: 600,
                }}
              >
                {(inv.balance_due || 0) > 0 ? formatCurrency(inv.balance_due) : "Paid"}
              </span>
            </div>
          )}
          initiallyOpen="first"
        />
      </section>

      {/* Expenses — groupable by Category, Date, Description */}
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">Expenses ({expenses.length})</p>
        <GroupedList
          rows={expenses}
          persistKey={`proj-${project.id}-exp`}
          searchPredicate={(e, q) => `${e.description || ""} ${e.category || ""}`.toLowerCase().includes(q)}
          searchPlaceholder="Search description / merchant"
          emptyHint="No expenses booked to this project."
          groupOptions={[
            { key: "category", label: "Category", groupBy: (e) => e.category || "(uncategorized)" },
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
            { key: "merchant", label: "Merchant / Description", groupBy: (e) => e.description || "(no description)" },
          ]}
          renderGroupSummary={(items) => {
            const total = items.reduce((s, e) => s + (e.amount || 0), 0);
            return formatCurrency(total);
          }}
          renderRow={(e) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 130px 1fr 110px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
              }}
            >
              <span style={{ color: "var(--aq-muted)" }}>{e.expense_date}</span>
              <span>{e.category}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.description || "—"}
              </span>
              <span style={{ textAlign: "right", fontWeight: 600 }}>{formatCurrency(e.amount)}</span>
            </div>
          )}
          initiallyOpen="first"
        />
      </section>
    </div>
  );
}
