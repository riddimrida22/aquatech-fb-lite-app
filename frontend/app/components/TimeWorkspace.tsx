"use client";

import { Dispatch, FormEvent, SetStateAction, useMemo } from "react";
import { Project, Task, Subtask, TimeEntry, formatDate, formatNumber } from "./workspaceShared";
import { GroupedList } from "./GroupedList";

type TimeFormState = {
  projectId: string;
  taskId: string;
  subtaskId: string;
  workDate: string;
  hours: string;
  note: string;
};

type TimeWorkspaceProps = {
  projects: Project[];
  timeEntries: TimeEntry[];
  timeTasks: Task[];
  timeSubtasks: Subtask[];
  timeForm: TimeFormState;
  setTimeForm: Dispatch<SetStateAction<TimeFormState>>;
  onProjectPick: (projectId: string) => Promise<void>;
  onCreateTimeEntry: (event: FormEvent<HTMLFormElement>) => void;
  submitting: string | null;
};

function currentWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = (day + 6) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - mondayOffset);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export function TimeWorkspace({
  projects,
  timeEntries,
  timeTasks,
  timeSubtasks,
  timeForm,
  setTimeForm,
  onProjectPick,
  onCreateTimeEntry,
  submitting,
}: TimeWorkspaceProps) {
  const weekStats = useMemo(() => {
    const range = currentWeekRange();
    const weeklyEntries = timeEntries.filter((entry) => {
      const workDate = new Date(`${entry.work_date}T12:00:00`);
      return workDate >= range.start && workDate <= range.end;
    });
    const billableHours = weeklyEntries.reduce(
      (sum, entry) => sum + (entry.bill_rate_applied > 0 ? entry.hours : 0),
      0,
    );
    return {
      totalHours: weeklyEntries.reduce((sum, entry) => sum + entry.hours, 0),
      billableHours,
      entryCount: weeklyEntries.length,
      projectCount: new Set(weeklyEntries.map((entry) => entry.project_id)).size,
    };
  }, [timeEntries]);

  const projectHours = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const entry of timeEntries) {
      const key = entry.project_name || "Unassigned";
      grouped.set(key, (grouped.get(key) || 0) + entry.hours);
    }
    return Array.from(grouped.entries())
      .map(([name, hours]) => ({ name, hours }))
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 6);
  }, [timeEntries]);

  const lastProjectName = useMemo(() => {
    const lastEntry = timeEntries[timeEntries.length - 1];
    return lastEntry?.project_name || "No recent project";
  }, [timeEntries]);

  return (
    <div className="aq-lite-stack">
      <div className="aq-lite-grid aq-lite-grid-4">
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">This week</p>
          <h3>{formatNumber(weekStats.totalHours, 1)} hours</h3>
          <p className="aq-lite-muted">Keep the current week current instead of filling gaps later.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Billable</p>
          <h3>{formatNumber(weekStats.billableHours, 1)} hours</h3>
          <p className="aq-lite-muted">Billable time is inferred from live rate application on each entry.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Touched projects</p>
          <h3>{weekStats.projectCount}</h3>
          <p className="aq-lite-muted">A narrower project spread usually means cleaner billing and better focus.</p>
        </section>
        <section className="aq-lite-panel">
          <p className="aq-lite-eyebrow">Last used</p>
          <h3>{lastProjectName}</h3>
          <p className="aq-lite-muted">Use recent context to keep daily entry fast.</p>
        </section>
      </div>

      <div className="aq-lite-grid aq-lite-grid-2">
        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Time entry</p>
              <h3>Fast daily capture</h3>
            </div>
          </div>
          <form className="aq-lite-form" onSubmit={onCreateTimeEntry}>
            <label>
              Project
              <select value={timeForm.projectId} onChange={(event) => void onProjectPick(event.target.value)} required>
                <option value="">Select project</option>
                {projects
                  .filter((project) => !project.is_overhead && project.is_active)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="aq-lite-form-grid">
              <label>
                Task
                <select
                  value={timeForm.taskId}
                  onChange={(event) => setTimeForm((current) => ({ ...current, taskId: event.target.value, subtaskId: "" }))}
                  required
                >
                  <option value="">Select task</option>
                  {timeTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Subtask
                <select
                  value={timeForm.subtaskId}
                  onChange={(event) => setTimeForm((current) => ({ ...current, subtaskId: event.target.value }))}
                  required
                >
                  <option value="">Select subtask</option>
                  {timeSubtasks.map((subtask) => (
                    <option key={subtask.id} value={subtask.id}>
                      {subtask.code} · {subtask.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="aq-lite-form-grid">
              <label>
                Work date
                <input
                  type="date"
                  value={timeForm.workDate}
                  onChange={(event) => setTimeForm((current) => ({ ...current, workDate: event.target.value }))}
                  required
                />
              </label>
              <label>
                Hours
                <input
                  type="number"
                  min="0.25"
                  max="24"
                  step="0.25"
                  value={timeForm.hours}
                  onChange={(event) => setTimeForm((current) => ({ ...current, hours: event.target.value }))}
                  required
                />
              </label>
            </div>
            <label>
              Note
              <textarea
                rows={4}
                value={timeForm.note}
                onChange={(event) => setTimeForm((current) => ({ ...current, note: event.target.value }))}
                placeholder="Describe the consulting work completed."
              />
            </label>
            <button type="submit" disabled={submitting === "time"}>
              {submitting === "time" ? "Saving…" : "Save time entry"}
            </button>
          </form>
        </section>

        <section className="aq-lite-panel">
          <div className="aq-lite-panel-head">
            <div>
              <p className="aq-lite-eyebrow">Allocation</p>
              <h3>Hours by project this month</h3>
            </div>
          </div>
          <div className="aq-lite-list">
            {projectHours.map((row) => (
              <div key={row.name} className="aq-lite-list-row">
                <div>
                  <strong>{row.name}</strong>
                  <span>Current month allocation</span>
                </div>
                <strong>{formatNumber(row.hours, 1)}h</strong>
              </div>
            ))}
            {projectHours.length === 0 ? <p className="aq-lite-muted">No time entries have been logged for the current month.</p> : null}
          </div>
        </section>
      </div>

      <section className="aq-lite-panel">
        <div className="aq-lite-panel-head">
          <div>
            <p className="aq-lite-eyebrow">Time entries ({timeEntries.length})</p>
            <h3>Drill by month, project, or task</h3>
          </div>
        </div>
        <GroupedList
          rows={[...timeEntries].reverse()}
          persistKey="time.entries"
          searchPredicate={(e, q) =>
            `${e.project_name || ""} ${e.task_name || ""} ${e.note || ""}`.toLowerCase().includes(q)
          }
          searchPlaceholder="Search project / task / note"
          emptyHint="No time entries yet."
          groupOptions={[
            {
              key: "month",
              label: "Month",
              groupBy: (e) => (e.work_date || "").slice(0, 7) || "—",
              sortBuckets: (a, b) => b.localeCompare(a),
            },
            {
              key: "project",
              label: "Project",
              groupBy: (e) => e.project_name || "(no project)",
            },
            {
              key: "task",
              label: "Task",
              groupBy: (e) => e.task_name || "(no task)",
            },
          ]}
          renderGroupSummary={(items) => {
            const h = items.reduce((s, e) => s + (e.hours || 0), 0);
            return `${formatNumber(h, 1)}h`;
          }}
          renderRow={(entry) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 1fr 1.4fr 70px",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
              }}
            >
              <span style={{ color: "var(--aq-muted)" }}>{formatDate(entry.work_date)}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.project_name || "Project"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--aq-muted)" }}>
                {entry.task_name || "Task"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.note || "—"}
              </span>
              <span style={{ textAlign: "right", fontWeight: 600 }}>{formatNumber(entry.hours, 1)}h</span>
            </div>
          )}
          initiallyOpen="first"
        />
      </section>
    </div>
  );
}
