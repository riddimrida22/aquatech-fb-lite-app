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
  note: string; // employee note for this entry (from FreshBooks or entered here)
  initialNote: string; // note as loaded, to detect edits
};

type RowState = {
  key: RowKey;
  project_id: number;
  task_id: number;
  subtask_id: number;
  project_name: string;
  task_name: string;
  subtask_name: string;
  note: string; // line-level note (FreshBooks-style), applied to this line's day entries
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

function emptyCell(): CellState {
  return { value: "", existingId: null, initialHours: 0, note: "", initialNote: "" };
}

function emptyCells(): Record<DayKey, CellState> {
  return {
    mon: emptyCell(),
    tue: emptyCell(),
    wed: emptyCell(),
    thu: emptyCell(),
    fri: emptyCell(),
    sat: emptyCell(),
    sun: emptyCell(),
  };
}

function dayIndexFromIso(iso: string, weekStart: Date): number {
  // Compare both dates at LOCAL midnight so the diff is a clean integer. Parsing the
  // entry at noon against a midnight weekStart left a 0.5-day gap that Math.round pushed
  // UP to the next column, shifting every saved entry one day forward on screen.
  const [y, m, d] = iso.split("-").map(Number);
  const entry = new Date(y, m - 1, d);
  const ws = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  return Math.round((entry.getTime() - ws.getTime()) / (1000 * 60 * 60 * 24));
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
  const [pickNote, setPickNote] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [noteEditor, setNoteEditor] = useState<{ rowKey: RowKey; day: DayKey } | null>(null);
  const [copyingPrior, setCopyingPrior] = useState(false);

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
          note: "",
          cells: emptyCells(),
        };
        grouped.set(key, row);
      }
      const dayIdx = dayIndexFromIso(entry.work_date, weekStart);
      if (dayIdx < 0 || dayIdx > 6) continue;
      const dayKey = DAY_KEYS[dayIdx];
      const existing = row.cells[dayKey];
      // If two entries land on the same project/task/subtask/day (rare), keep the first
      // entry's id for editing but merge notes so no note is hidden.
      const mergedNote = existing.note
        ? existing.note + (entry.note ? `\n---\n${entry.note}` : "")
        : entry.note || "";
      row.cells[dayKey] = {
        value: String(entry.hours),
        existingId: existing.existingId ?? entry.id,
        initialHours: entry.hours,
        note: mergedNote,
        initialNote: mergedNote,
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
        // a note edit on a cell that has (or will have) an entry is a change too
        if (cell.note !== cell.initialNote && (cell.existingId !== null || safe > 0)) return true;
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

  function setCellNote(rowKey: RowKey, day: DayKey, note: string) {
    setRows((prev) =>
      prev.map((row) => {
        if (row.key !== rowKey) return row;
        return { ...row, cells: { ...row.cells, [day]: { ...row.cells[day], note } } };
      }),
    );
  }

  // Copy the project/task/subtask LINES from the previous week (no hours) so the
  // employee doesn't re-pick the same projects every week — FreshBooks-style.
  async function handleCopyPriorWeek() {
    if (copyingPrior || readOnly) return;
    setCopyingPrior(true);
    setError(null);
    setInfo(null);
    try {
      const priorStart = isoDate(addDays(weekStart, -7));
      const priorEnd = isoDate(addDays(weekStart, -1));
      const userParam = viewingSelf ? "" : `&user_id=${viewedUserId}`;
      const prior = await apiGet<TimeEntry[]>(
        `/time-entries?start=${priorStart}&end=${priorEnd}${userParam}`,
      );
      const existingKeys = new Set(rows.map((r) => r.key));
      const additions = new Map<RowKey, RowState>();
      for (const entry of prior) {
        const key = rowKeyOf(entry.project_id, entry.task_id, entry.subtask_id);
        if (existingKeys.has(key) || additions.has(key)) continue;
        additions.set(key, {
          key,
          project_id: entry.project_id,
          task_id: entry.task_id,
          subtask_id: entry.subtask_id,
          project_name: entry.project_name || "Project",
          task_name: entry.task_name || "Task",
          subtask_name: entry.subtask_name || "Subtask",
          note: "",
          cells: emptyCells(),
        });
      }
      if (additions.size === 0) {
        setInfo("No new lines to copy from last week.");
      } else {
        setRows((prev) => [...prev, ...Array.from(additions.values())]);
        setInfo(`Copied ${additions.size} line${additions.size === 1 ? "" : "s"} from last week (no hours).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not copy last week's lines.");
    } finally {
      setCopyingPrior(false);
    }
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
      note: pickNote.trim(),
      cells: emptyCells(),
    };
    setRows((prev) => [...prev, newRow]);
    setAdding(false);
    setPickProjectId("");
    setPickTaskId("");
    setPickSubtaskId("");
    setPickNote("");
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
          const noteChanged = cell.note !== cell.initialNote;
          if (safe === 0 && cell.existingId === null) continue;
          // nothing changed (hours identical AND note untouched) → skip
          if (same && !noteChanged && cell.existingId !== null) continue;
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
                note: cell.note || row.note, // preserve/carry the note the employee wrote
              });
              created += 1;
            } else {
              await apiPut(`/time-entries/${cell.existingId}`, {
                project_id: row.project_id,
                task_id: row.task_id,
                subtask_id: row.subtask_id,
                work_date: workDate,
                hours: safe,
                note: cell.note || row.note, // KEEP the existing note (was being wiped to "")
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
                    {row.note ? (
                      <div
                        style={{ marginTop: 3, fontSize: 12, color: "var(--aq-muted)", fontStyle: "italic" }}
                        title={row.note}
                      >
                        {row.note}
                      </div>
                    ) : null}
                  </td>
                  {DAY_KEYS.map((d) => {
                    const cell = row.cells[d];
                    const hasHours = cell.existingId !== null || (parseFloat(cell.value) || 0) > 0;
                    const eff = cell.note || row.note;
                    const showNote = hasHours || !!eff;
                    return (
                      <td key={d} style={{ padding: 4 }}>
                        <div style={{ position: "relative" }}>
                          <input
                            type="number"
                            min={0}
                            max={24}
                            step={0.25}
                            value={cell.value}
                            onChange={(e) => setCell(row.key, d, e.target.value)}
                            readOnly={readOnly}
                            disabled={readOnly}
                            style={{
                              width: "100%",
                              textAlign: "center",
                              padding: "6px 14px 6px 4px",
                              border: "1px solid var(--aq-border)",
                              borderRadius: 4,
                              background: readOnly ? "var(--aq-subtle)" : "var(--aq-card)",
                            }}
                          />
                          {showNote ? (
                            <button
                              type="button"
                              onClick={() => setNoteEditor({ rowKey: row.key, day: d })}
                              title={eff ? eff : "Add a note"}
                              aria-label={eff ? "View or edit note" : "Add note"}
                              style={{
                                position: "absolute",
                                top: 0,
                                right: 0,
                                width: 20,
                                height: 20,
                                padding: 0,
                                lineHeight: "18px",
                                fontSize: 20,
                                fontWeight: 500,
                                border: "none",
                                background: "transparent",
                                cursor: "pointer",
                                color: eff ? "var(--aq-primary)" : "var(--aq-border)",
                              }}
                            >
                              +
                            </button>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setAdding(true)} disabled={readOnly}>
                + Add line
              </button>
              <button
                type="button"
                onClick={() => void handleCopyPriorWeek()}
                disabled={readOnly || copyingPrior}
                title="Add last week's projects/tasks as blank lines (no hours)"
              >
                {copyingPrior ? "Copying…" : "⧉ Copy last week's lines"}
              </button>
            </div>
          ) : (
            <div
              style={{
                border: "1px solid var(--aq-border)",
                borderRadius: 10,
                padding: 12,
                background: "var(--aq-subtle, rgba(0,0,0,0.02))",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
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
              </div>
              <label>
                Notes
                <textarea
                  value={pickNote}
                  onChange={(e) => setPickNote(e.target.value)}
                  rows={2}
                  placeholder="Describe the work done for this line"
                  style={{
                    width: "100%",
                    marginTop: 4,
                    padding: 8,
                    border: "1px solid var(--aq-border)",
                    borderRadius: 6,
                    background: "var(--aq-input-bg, #fff)",
                    color: "inherit",
                    fontFamily: "inherit",
                    fontSize: 13,
                    resize: "vertical",
                  }}
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={handleAddRow}>
                  Add line
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setPickProjectId("");
                    setPickTaskId("");
                    setPickSubtaskId("");
                    setPickNote("");
                    setError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
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

        {/* Note viewer / editor — opened by the ● / ○ indicator on a day cell.
            Read-only when an admin is viewing another employee (this is how historic
            FreshBooks notes are browsed). */}
        {noteEditor
          ? (() => {
              const erow = rows.find((r) => r.key === noteEditor.rowKey);
              if (!erow) return null;
              const cell = erow.cells[noteEditor.day];
              const dayIdx = DAY_KEYS.indexOf(noteEditor.day);
              const dateLabel = addDays(weekStart, dayIdx).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              });
              return (
                <div
                  onClick={() => setNoteEditor(null)}
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.35)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 1000,
                  }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      background: "var(--aq-card)",
                      border: "1px solid var(--aq-border)",
                      borderRadius: 8,
                      padding: 16,
                      width: "min(520px, 92vw)",
                      boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
                    }}
                  >
                    <div style={{ marginBottom: 8 }}>
                      <strong>{erow.project_name}</strong>
                      <div className="aq-lite-muted" style={{ fontSize: 12 }}>
                        {erow.task_name} · {erow.subtask_name} — {dateLabel}
                      </div>
                    </div>
                    <textarea
                      value={cell.note || erow.note}
                      onChange={(e) => setCellNote(noteEditor.rowKey, noteEditor.day, e.target.value)}
                      readOnly={readOnly}
                      autoFocus={!readOnly}
                      placeholder={readOnly ? "No note recorded." : "Describe the work done for these hours…"}
                      rows={6}
                      style={{
                        width: "100%",
                        padding: 8,
                        border: "1px solid var(--aq-border)",
                        borderRadius: 6,
                        background: readOnly ? "var(--aq-subtle)" : "var(--aq-card)",
                        resize: "vertical",
                        fontFamily: "inherit",
                        fontSize: 13,
                      }}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => setNoteEditor(null)}
                        style={{
                          background: readOnly ? undefined : "var(--aq-primary)",
                          color: readOnly ? undefined : "white",
                        }}
                      >
                        {readOnly ? "Close" : "Done"}
                      </button>
                      {!readOnly ? (
                        <span className="aq-lite-muted" style={{ fontSize: 12 }}>
                          Close, then <strong>Save changes</strong> to store the note.
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })()
          : null}
      </section>
    </div>
  );
}
