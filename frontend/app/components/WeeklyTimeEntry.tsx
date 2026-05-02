"use client";

import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../../lib/api";
import {
  Project,
  ProjectWbs,
  Subtask,
  Task,
  TimeEntry,
  User,
  formatNumber,
} from "./workspaceShared";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const DAY_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

type RowKey = string; // `${project_id}|${task_id}|${subtask_id}`

type CellState = {
  value: string; // user input as string (allow blank, partial typing)
  existingId: number | null; // backend TimeEntry id, if any
  initialHours: number; // hours that were on the entry when row loaded
};

type RowState = {
  key: RowKey;
  project_id: number;
  task_id: number;
  subtask_id: number;
  project_name: string;
  task_name: string;
  subtask_name: string;
  cells: Record<DayKey, CellState>;
};

type StaffOption = { id: number; name: string; email: string };

type WeeklyTimeEntryProps = {
  user: User;
  projects: Project[];
  wbsByProject: Record<number, ProjectWbs>;
  timeEntries: TimeEntry[]; // initial seed; component re-fetches per week
  onProjectPick: (projectId: string) => Promise<void>;
  onSaved: () => Promise<void>;
  // Optional admin-only "view as employee" support
  staffOptions?: StaffOption[];
  isAdmin?: boolean;
};

function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function rowKeyOf(projectId: number, taskId: number, subtaskId: number): RowKey {
  return `${projectId}|${taskId}|${subtaskId}`;
}

function emptyCells(): Record<DayKey, CellState> {
  return {
    mon: { value: "", existingId: null, initialHours: 0 },
    tue: { value: "", existingId: null, initialHours: 0 },
    wed: { value: "", existingId: null, initialHours: 0 },
    thu: { value: "", existingId: null, initialHours: 0 },
    fri: { value: "", existingId: null, initialHours: 0 },
    sat: { value: "", existingId: null, initialHours: 0 },
    sun: { value: "", existingId: null, initialHours: 0 },
  };
}

function dayIndexFromIso(iso: string, weekStart: Date): number {
  const d = new Date(`${iso}T12:00:00`);
  const diff = Math.round((d.getTime() - weekStart.getTime()) / (1000 * 60 * 60 * 24));
  return diff;
}

function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const startLabel = weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

export function WeeklyTimeEntry({
  user,
  projects,
  wbsByProject,
  timeEntries,
  onProjectPick,
  onSaved,
  staffOptions = [],
  isAdmin = false,
}: WeeklyTimeEntryProps) {
  const [viewedUserId, setViewedUserId] = useState<number>(user.id);
  const viewingSelf = viewedUserId === user.id;
  const viewedUser = useMemo(() => {
    if (viewingSelf) return { id: user.id, name: user.full_name, email: user.email };
    const opt = staffOptions.find((s) => s.id === viewedUserId);
    return opt ? { id: opt.id, name: opt.name, email: opt.email } : { id: user.id, name: user.full_name, email: user.email };
  }, [viewingSelf, viewedUserId, user, staffOptions]);
  const readOnly = !viewingSelf;
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [rows, setRows] = useState<RowState[]>([]);
  const [weekEntries, setWeekEntries] = useState<TimeEntry[]>(viewingSelf ? timeEntries : []);
  const [loadingWeek, setLoadingWeek] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pickProjectId, setPickProjectId] = useState<string>("");
  const [pickTaskId, setPickTaskId] = useState<string>("");
  const [pickSubtaskId, setPickSubtaskId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const weekDays = useMemo(() => DAY_KEYS.map((_, i) => addDays(weekStart, i)), [weekStart]);
  const weekStartIso = useMemo(() => isoDate(weekStart), [weekStart]);
  const weekEndIso = useMemo(() => isoDate(addDays(weekStart, 6)), [weekStart]);

  // Fetch own time entries when the visible week changes — fixes empty older-week display.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingWeek(true);
      setError(null);
      try {
        const userParam = viewingSelf ? "" : `&user_id=${viewedUserId}`;
        const fetched = await apiGet<TimeEntry[]>(`/time-entries?start=${weekStartIso}&end=${weekEndIso}${userParam}`);
        if (!cancelled) setWeekEntries(fetched);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load time entries for this week.");
          setWeekEntries([]);
        }
      } finally {
        if (!cancelled) setLoadingWeek(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [weekStartIso, weekEndIso, viewedUserId, viewingSelf]);

  // Build rows from weekEntries whenever week or weekEntries change
  useEffect(() => {
    const inWeek = weekEntries.filter((entry) => entry.work_date >= weekStartIso && entry.work_date <= weekEndIso);
    const grouped = new Map<RowKey, RowState>();
    for (const entry of inWeek) {
      const key = rowKeyOf(entry.project_id, entry.task_id, entry.subtask_id);
      let row = grouped.get(key);
      if (!row) {
        row = {
          key,
          project_id: entry.project_id,
          task_id: entry.task_id,
          subtask_id: entry.subtask_id,
          project_name: entry.project_name || "Project",
          task_name: entry.task_name || "Task",
          subtask_name: entry.subtask_name || "Subtask",
          cells: emptyCells(),
        };
        grouped.set(key, row);
      }
      const dayIdx = dayIndexFromIso(entry.work_date, weekStart);
      if (dayIdx < 0 || dayIdx > 6) continue;
      const dayKey = DAY_KEYS[dayIdx];
      row.cells[dayKey] = {
        value: String(entry.hours),
        existingId: entry.id,
        initialHours: entry.hours,
      };
    }
    setRows(Array.from(grouped.values()).sort((a, b) => a.project_name.localeCompare(b.project_name)));
  }, [weekEntries, weekStart, weekStartIso, weekEndIso]);

  const dailyTotals = useMemo(() => {
    const totals: Record<DayKey, number> = { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 };
    for (const row of rows) {
      for (const day of DAY_KEYS) {
        const n = parseFloat(row.cells[day].value);
        if (!Number.isNaN(n)) totals[day] += n;
      }
    }
    return totals;
  }, [rows]);

  const weekTotal = useMemo(() => DAY_KEYS.reduce((sum, day) => sum + dailyTotals[day], 0), [dailyTotals]);

  const rowTotal = (row: RowState): number => {
    return DAY_KEYS.reduce((sum, day) => {
      const n = parseFloat(row.cells[day].value);
      return Number.isNaN(n) ? sum : sum + n;
    }, 0);
  };

  const dirty = useMemo(() => {
    for (const row of rows) {
      for (const day of DAY_KEYS) {
        const cell = row.cells[day];
        const cur = parseFloat(cell.value);
        const safe = Number.isNaN(cur) ? 0 : cur;
        if (Math.abs(safe - cell.initialHours) > 0.0001) return true;
        if (safe === 0 && cell.existingId !== null) return true;
      }
    }
    return false;
  }, [rows]);

  const taskOptionsFor = (projectId: number): Task[] => {
    if (!projectId) return [];
    return wbsByProject[projectId]?.tasks ?? [];
  };

  const subtaskOptionsFor = (projectId: number, taskId: number): Subtask[] => {
    const tasks = taskOptionsFor(projectId);
    return tasks.find((t) => t.id === taskId)?.subtasks ?? [];
  };

  function setCell(rowKey: RowKey, day: DayKey, value: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== rowKey) return row;
        return {
          ...row,
          cells: { ...row.cells, [day]: { ...row.cells[day], value } },
        };
      }),
    );
  }

  function removeRow(rowKey: RowKey) {
    // Marking all cells to 0 will trigger deletes on save; or just remove from state if all cells were never saved
    setRows((prev) => {
      const target = prev.find((r) => r.key === rowKey);
      if (!target) return prev;
      const hasAnyExisting = DAY_KEYS.some((d) => target.cells[d].existingId !== null);
      if (!hasAnyExisting) {
        return prev.filter((r) => r.key !== rowKey);
      }
      // keep the row but blank out values so save deletes them
      return prev.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              cells: DAY_KEYS.reduce(
                (acc, d) => {
                  acc[d] = { ...row.cells[d], value: "" };
                  return acc;
                },
                {} as Record<DayKey, CellState>,
              ),
            }
          : row,
      );
    });
  }

  async function handlePickProject(value: string) {
    setPickProjectId(value);
    setPickTaskId("");
    setPickSubtaskId("");
    if (value) {
      try {
        await onProjectPick(value);
      } catch (err) {
        // ignore — onProjectPick should have set error in page state if needed
      }
    }
  }

  function handleAddRow() {
    const projectId = Number(pickProjectId);
    const taskId = Number(pickTaskId);
    const subtaskId = Number(pickSubtaskId);
    if (!projectId || !taskId || !subtaskId) {
      setError("Pick project, task, and subtask before adding a line.");
      return;
    }
    const project = projects.find((p) => p.id === projectId);
    const task = taskOptionsFor(projectId).find((t) => t.id === taskId);
    const subtask = subtaskOptionsFor(projectId, taskId).find((s) => s.id === subtaskId);
    if (!project || !task || !subtask) {
      setError("Could not resolve the selected project/task/subtask.");
      return;
    }
    const key = rowKeyOf(projectId, taskId, subtaskId);
    if (rows.some((r) => r.key === key)) {
      setError("This project/task/subtask is already a row in the week.");
      return;
    }
    const newRow: RowState = {
      key,
      project_id: projectId,
      task_id: taskId,
      subtask_id: subtaskId,
      project_name: project.name,
      task_name: task.name,
      subtask_name: subtask.name,
      cells: emptyCells(),
    };
    setRows((prev) => [...prev, newRow]);
    setAdding(false);
    setPickProjectId("");
    setPickTaskId("");
    setPickSubtaskId("");
    setError(null);
    setInfo(null);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let failures = 0;
    try {
      for (const row of rows) {
        for (let i = 0; i < DAY_KEYS.length; i += 1) {
          const day = DAY_KEYS[i];
          const cell = row.cells[day];
          const cur = parseFloat(cell.value);
          const safe = Number.isNaN(cur) ? 0 : cur;
          const same = Math.abs(safe - cell.initialHours) < 0.0001;
          if (safe === 0 && cell.existingId === null) continue;
          if (same && cell.existingId !== null) continue;
          const workDate = isoDate(addDays(weekStart, i));
          try {
            if (safe === 0 && cell.existingId !== null) {
              await apiDelete(`/time-entries/${cell.existingId}`);
              deleted += 1;
            } else if (cell.existingId === null) {
              await apiPost(`/time-entries`, {
                project_id: row.project_id,
                task_id: row.task_id,
                subtask_id: row.subtask_id,
                work_date: workDate,
                hours: safe,
                note: "",
              });
              created += 1;
            } else {
              await apiPut(`/time-entries/${cell.existingId}`, {
                project_id: row.project_id,
                task_id: row.task_id,
                subtask_id: row.subtask_id,
                work_date: workDate,
                hours: safe,
                note: "",
              });
              updated += 1;
            }
          } catch (err) {
            failures += 1;
            // continue saving other cells
          }
        }
      }
      const summaryParts: string[] = [];
      if (created) summaryParts.push(`${created} created`);
      if (updated) summaryParts.push(`${updated} updated`);
      if (deleted) summaryParts.push(`${deleted} cleared`);
      if (failures) summaryParts.push(`${failures} failed`);
      setInfo(summaryParts.length ? `Saved (${summaryParts.join(", ")}).` : "Nothing to save.");
      // Refetch local week data so cells show new IDs and reset dirty state
      try {
        const refetched = await apiGet<TimeEntry[]>(`/time-entries?start=${weekStartIso}&end=${weekEndIso}`);
        setWeekEntries(refetched);
      } catch {
        // ignore — onSaved will pull at parent level
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected save error");
    } finally {
      setSaving(false);
    }
  }

  const projectsOnly = useMemo(
    () => projects.filter((project) => project.is_active && !project.is_overhead),
    [projects],
  );

  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel">
        {isAdmin && staffOptions.length > 1 ? (
          <div
            style={{
              padding: 10,
              marginBottom: 12,
              background: viewingSelf ? "var(--aq-primary-soft)" : "#fde8d2",
              border: `1px solid ${viewingSelf ? "var(--aq-border)" : "#f0d2ab"}`,
              borderRadius: 6,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <strong style={{ fontSize: 13 }}>Admin · viewing:</strong>
            <select
              value={viewedUserId}
              onChange={(e) => setViewedUserId(Number(e.target.value))}
              style={{ flex: "0 0 auto", minWidth: 240 }}
            >
              <option value={user.id}>My timesheet ({user.full_name})</option>
              <optgroup label="View other employees (read-only)">
                {staffOptions
                  .filter((s) => s.id !== user.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.email}
                    </option>
                  ))}
              </optgroup>
            </select>
            {!viewingSelf ? (
              <span style={{ fontSize: 12, color: "#8b5a1d" }}>
                Read-only · admin view of {viewedUser.name}'s timesheet
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="aq-lite-panel-head" style={{ alignItems: "center" }}>
          <div>
            <p className="aq-lite-eyebrow">Weekly time entry {loadingWeek ? "· loading…" : ""}</p>
            <h3>{formatWeekRange(weekStart)}</h3>
            {!viewingSelf ? (
              <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 2 }}>
                Viewing {viewedUser.name} ({viewedUser.email})
              </p>
            ) : null}
          </div>
          <div className="aq-lite-toolbar">
            <button type="button" onClick={() => setWeekStart((w) => addDays(w, -7))}>
              ‹ Prev week
            </button>
            <button type="button" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              This week
            </button>
            <button type="button" onClick={() => setWeekStart((w) => addDays(w, 7))}>
              Next week ›
            </button>
          </div>
        </div>

        {/* Grid */}
        <div style={{ overflowX: "auto" }}>
          <table className="aq-lite-table" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 280 }}>Project / Task / Subtask</th>
                {weekDays.map((d, i) => (
                  <th key={DAY_KEYS[i]} style={{ width: 70, textAlign: "center" }}>
                    <div style={{ fontWeight: 600 }}>{DAY_LABELS[i]}</div>
                    <div style={{ fontSize: 11, opacity: 0.7 }}>
                      {d.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
                    </div>
                  </th>
                ))}
                <th style={{ width: 70, textAlign: "center" }}>Total</th>
                <th data-disable-sort="true" style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <strong>{row.project_name}</strong>
                    <div className="aq-lite-muted" style={{ fontSize: 12 }}>
                      {row.task_name} · {row.subtask_name}
                    </div>
                  </td>
                  {DAY_KEYS.map((d) => (
                    <td key={d} style={{ padding: 4 }}>
                      <input
                        type="number"
                        min={0}
                        max={24}
                        step={0.25}
                        value={row.cells[d].value}
                        onChange={(e) => setCell(row.key, d, e.target.value)}
                        readOnly={readOnly}
                        disabled={readOnly}
                        style={{
                          width: "100%",
                          textAlign: "center",
                          padding: "6px 4px",
                          border: "1px solid var(--aq-border)",
                          borderRadius: 4,
                          background: readOnly ? "#f4f4f4" : "var(--aq-card)",
                        }}
                      />
                    </td>
                  ))}
                  <td style={{ textAlign: "center", fontWeight: 600 }}>{formatNumber(rowTotal(row), 1)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => removeRow(row.key)}
                      title="Clear this row"
                      style={{ padding: "2px 8px" }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="aq-lite-muted">
                    No lines for this week yet. Click <strong>Add line</strong> to start charging time.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ fontWeight: 600 }}>Daily totals</td>
                {DAY_KEYS.map((d) => (
                  <td key={d} style={{ textAlign: "center", fontWeight: 600 }}>
                    {formatNumber(dailyTotals[d], 1)}
                  </td>
                ))}
                <td style={{ textAlign: "center", fontWeight: 700 }}>{formatNumber(weekTotal, 1)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Add row controls */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--aq-border)" }}>
          {!adding ? (
            <button type="button" onClick={() => setAdding(true)} disabled={readOnly}>
              + Add line
            </button>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 2fr auto auto", gap: 8, alignItems: "end" }}>
              <label>
                Project
                <select value={pickProjectId} onChange={(e) => void handlePickProject(e.target.value)}>
                  <option value="">Select project</option>
                  {projectsOnly.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task
                <select
                  value={pickTaskId}
                  onChange={(e) => {
                    setPickTaskId(e.target.value);
                    setPickSubtaskId("");
                  }}
                  disabled={!pickProjectId}
                >
                  <option value="">Select task</option>
                  {taskOptionsFor(Number(pickProjectId)).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Subtask
                <select
                  value={pickSubtaskId}
                  onChange={(e) => setPickSubtaskId(e.target.value)}
                  disabled={!pickTaskId}
                >
                  <option value="">Select subtask</option>
                  {subtaskOptionsFor(Number(pickProjectId), Number(pickTaskId)).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} · {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={handleAddRow}>
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setPickProjectId("");
                  setPickTaskId("");
                  setPickSubtaskId("");
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Save bar */}
        <div
          style={{
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--aq-border)",
            display: "flex",
            gap: 12,
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={readOnly || !dirty || saving}
            style={{ background: !readOnly && dirty ? "var(--aq-primary)" : undefined, color: !readOnly && dirty ? "white" : undefined }}
          >
            {readOnly ? "Read-only (admin view)" : saving ? "Saving…" : dirty ? "Save changes" : "All saved"}
          </button>
          {info ? <span className="aq-lite-muted">{info}</span> : null}
          {error ? <span style={{ color: "var(--aq-red)" }}>{error}</span> : null}
          <span style={{ marginLeft: "auto" }} className="aq-lite-muted">
            {user.full_name} • {weekStartIso} → {weekEndIso}
          </span>
        </div>
      </section>
    </div>
  );
}
