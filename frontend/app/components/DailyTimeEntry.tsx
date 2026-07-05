"use client";

// FreshBooks-style time entry: Day / Week / Month / All views over a per-day, multi-item
// model. Each day holds any number of items (project · task · subtask · note · hours);
// items are added via a per-day "+", edited/deleted from a hover menu. The employee
// picker is admin-only. Replaces the single-value weekly grid (WeeklyTimeEntry) with the
// model the team knows from FreshBooks.

import { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../../lib/api";
import { Project, ProjectWbs, Subtask, Task, TimeEntry, User, formatNumber } from "./workspaceShared";
import { WeeklyTimeEntry } from "./WeeklyTimeEntry"; // reused for the Week grid (rows × days)

type View = "day" | "week" | "month" | "all";
type StaffOption = { id: number; name: string; email: string };

type Props = {
  user: User;
  projects: Project[];
  wbsByProject: Record<number, ProjectWbs>;
  timeEntries: TimeEntry[];
  onProjectPick: (projectId: string) => Promise<void>;
  onSaved: () => Promise<void>;
  staffOptions?: StaffOption[];
  isAdmin?: boolean;
};

type EditorState = {
  entryId: number | null; // null = new item
  dateIso: string;
  projectId: string;
  taskId: string;
  subtaskId: string;
  hours: string;
  note: string;
};

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function DailyTimeEntry({
  user,
  projects,
  wbsByProject,
  timeEntries,
  onProjectPick,
  onSaved,
  staffOptions = [],
  isAdmin = false,
}: Props) {
  const [viewedUserId, setViewedUserId] = useState<number>(user.id);
  const viewingSelf = viewedUserId === user.id;
  const readOnly = !viewingSelf;
  const viewedName = viewingSelf
    ? user.full_name
    : staffOptions.find((s) => s.id === viewedUserId)?.name ?? "Employee";

  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  });
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(iso(new Date()));
  const [busy, setBusy] = useState(false);

  const [rangeStart, rangeEnd] = useMemo<[Date, Date]>(() => {
    if (view === "day") return [anchor, anchor];
    if (view === "week") return [startOfWeek(anchor), addDays(startOfWeek(anchor), 6)];
    if (view === "month") return [startOfMonth(anchor), endOfMonth(anchor)];
    return [new Date(2024, 0, 1), addDays(new Date(), 31)]; // all
  }, [view, anchor]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const userParam = viewingSelf ? "" : `&user_id=${viewedUserId}`;
        const data = await apiGet<TimeEntry[]>(
          `/time-entries?start=${iso(rangeStart)}&end=${iso(rangeEnd)}${userParam}`,
        );
        if (!cancelled) setEntries(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load time entries.");
          setEntries([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [rangeStart, rangeEnd, viewedUserId, viewingSelf]);

  const byDay = useMemo(() => {
    const m = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const list = m.get(e.work_date) ?? [];
      list.push(e);
      m.set(e.work_date, list);
    }
    return m;
  }, [entries]);

  const dayTotal = (dIso: string) =>
    (byDay.get(dIso) ?? []).reduce((s, e) => s + (e.hours || 0), 0);
  const rangeTotal = useMemo(
    () => entries.reduce((s, e) => s + (e.hours || 0), 0),
    [entries],
  );

  const projectsOnly = useMemo(
    () => projects.filter((p) => p.is_active && !p.is_overhead),
    [projects],
  );
  const tasksFor = (pid: number): Task[] => wbsByProject[pid]?.tasks ?? [];
  const subtasksFor = (pid: number, tid: number): Subtask[] =>
    tasksFor(pid).find((t) => t.id === tid)?.subtasks ?? [];

  async function openNew(dateIso: string) {
    if (readOnly) return;
    setEditor({ entryId: null, dateIso, projectId: "", taskId: "", subtaskId: "", hours: "", note: "" });
  }
  async function openEdit(e: TimeEntry) {
    if (readOnly) return;
    await onProjectPick(String(e.project_id)).catch(() => {});
    setEditor({
      entryId: e.id,
      dateIso: e.work_date,
      projectId: String(e.project_id),
      taskId: String(e.task_id),
      subtaskId: String(e.subtask_id),
      hours: String(e.hours),
      note: e.note ?? "",
    });
  }

  async function saveEditor() {
    if (!editor || busy) return;
    const pid = Number(editor.projectId);
    const tid = Number(editor.taskId);
    const sid = Number(editor.subtaskId);
    const hrs = parseFloat(editor.hours);
    if (!pid || !tid || !sid) {
      setError("Pick a project, task, and subtask.");
      return;
    }
    if (Number.isNaN(hrs) || hrs <= 0) {
      setError("Enter hours greater than 0.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        project_id: pid,
        task_id: tid,
        subtask_id: sid,
        work_date: editor.dateIso,
        hours: hrs,
        note: editor.note,
      };
      if (editor.entryId == null) {
        await apiPost(`/time-entries`, body);
        setInfo("Item added.");
      } else {
        await apiPut(`/time-entries/${editor.entryId}`, body);
        setInfo("Item updated.");
      }
      setEditor(null);
      await refetch();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the item.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(id: number) {
    if (readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/time-entries/${id}`);
      setInfo("Item deleted.");
      setEditor(null);
      await refetch();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the item.");
    } finally {
      setBusy(false);
    }
  }

  async function refetch() {
    const userParam = viewingSelf ? "" : `&user_id=${viewedUserId}`;
    const data = await apiGet<TimeEntry[]>(
      `/time-entries?start=${iso(rangeStart)}&end=${iso(rangeEnd)}${userParam}`,
    );
    setEntries(data);
  }

  function shift(dir: 1 | -1) {
    if (view === "day") setAnchor((a) => addDays(a, dir));
    else if (view === "week") setAnchor((a) => addDays(a, dir * 7));
    else if (view === "month") setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  }
  function goToday() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    setAnchor(t);
    setSelectedDay(iso(t));
  }

  const periodLabel = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (view === "day") return anchor.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    if (view === "week") return `${fmt(rangeStart)} – ${rangeEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    if (view === "month") return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return "All time";
  }, [view, anchor, rangeStart, rangeEnd]);

  // ---- renderers -----------------------------------------------------------
  function DayCard({ dISO }: { dISO: string }) {
    const items = (byDay.get(dISO) ?? []).slice().sort((a, b) => a.project_id - b.project_id);
    const d = parseIso(dISO);
    const isToday = dISO === iso(new Date());
    return (
      <div
        style={{
          border: "1px solid var(--aq-border)",
          borderRadius: 10,
          background: "var(--aq-card)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            background: isToday ? "var(--aq-primary-soft)" : "var(--aq-subtle, rgba(0,0,0,0.02))",
            borderBottom: "1px solid var(--aq-border)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            {d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            {isToday ? <span style={{ marginLeft: 6, color: "var(--aq-primary-dark)", fontSize: 11 }}>Today</span> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--aq-muted)", fontSize: 12 }}>
              {formatNumber(dayTotal(dISO), 2)}h
            </span>
            {!readOnly ? (
              <button
                type="button"
                onClick={() => void openNew(dISO)}
                aria-label="Add item"
                title="Add an item to this day"
                style={{ padding: "1px 8px", fontSize: 16, lineHeight: "18px" }}
              >
                +
              </button>
            ) : null}
          </div>
        </div>
        <div>
          {items.length === 0 ? (
            <div className="aq-lite-muted" style={{ padding: "10px 12px", fontSize: 12 }}>
              {readOnly ? "No items." : "No items — click + to add."}
            </div>
          ) : (
            items.map((e) => <ItemRow key={e.id} e={e} />)
          )}
        </div>
      </div>
    );
  }

  function ItemRow({ e }: { e: TimeEntry }) {
    const [hover, setHover] = useState(false);
    return (
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--aq-border)",
          borderLeft: "3px solid var(--aq-primary)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{e.project_name || `Project ${e.project_id}`}</div>
          <div className="aq-lite-muted" style={{ fontSize: 12 }}>
            {e.task_name || "Task"}
            {e.subtask_name ? ` · ${e.subtask_name}` : ""}
            {e.note ? <span style={{ fontStyle: "italic" }}> • {e.note}</span> : ""}
          </div>
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
          {formatNumber(e.hours, 2)}h
        </div>
        {!readOnly ? (
          <div style={{ display: "flex", gap: 4, opacity: hover ? 1 : 0.25, transition: "opacity .1s" }}>
            <button
              type="button"
              onClick={() => void openEdit(e)}
              aria-label="Edit item"
              title="Edit"
              style={{ padding: "2px 6px", fontSize: 12 }}
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => void deleteEntry(e.id)}
              aria-label="Delete item"
              title="Delete"
              style={{ padding: "2px 6px", fontSize: 12, color: "var(--aq-red)" }}
            >
              🗑
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function MonthCalendar() {
    const first = startOfMonth(anchor);
    const gridStart = startOfWeek(first);
    const cells: Date[] = [];
    for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));
    const monthIdx = anchor.getMonth();
    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
          {DOW.map((w) => (
            <div key={w} style={{ fontSize: 11, color: "var(--aq-muted)", fontWeight: 600, textAlign: "center", padding: 2 }}>
              {w}
            </div>
          ))}
          {cells.map((c) => {
            const cIso = iso(c);
            const inMonth = c.getMonth() === monthIdx;
            const total = dayTotal(cIso);
            const isSel = cIso === selectedDay;
            const isToday = cIso === iso(new Date());
            return (
              <button
                key={cIso}
                type="button"
                onClick={() => setSelectedDay(cIso)}
                style={{
                  textAlign: "left",
                  minHeight: 62,
                  padding: 6,
                  borderRadius: 8,
                  border: isSel ? "2px solid var(--aq-primary)" : "1px solid var(--aq-border)",
                  background: inMonth ? "var(--aq-card)" : "var(--aq-subtle, rgba(0,0,0,0.02))",
                  color: inMonth ? "inherit" : "var(--aq-muted)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 11, fontWeight: isToday ? 700 : 400 }}>{c.getDate()}</span>
                {total > 0 ? (
                  <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {formatNumber(total, 2)}h
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--aq-border)" }}>—</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 12 }}>
          <DayCard dISO={selectedDay} />
        </div>
      </div>
    );
  }

  const allDays = useMemo(() => {
    return Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));
  }, [byDay]);

  const editorRow = editor
    ? { pid: Number(editor.projectId), tid: Number(editor.taskId) }
    : { pid: 0, tid: 0 };

  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel">
        {view !== "week" && isAdmin && staffOptions.length > 1 ? (
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
              flexWrap: "wrap",
            }}
          >
            <strong style={{ fontSize: 13 }}>Admin · viewing:</strong>
            <select
              value={viewedUserId}
              onChange={(e) => setViewedUserId(Number(e.target.value))}
              style={{ minWidth: 240 }}
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
              <span style={{ fontSize: 12, color: "#8b5a1d" }}>Read-only · viewing {viewedName}</span>
            ) : null}
          </div>
        ) : null}

        {/* Toolbar: view toggle · period nav · total */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "inline-flex", border: "1px solid var(--aq-border)", borderRadius: 8, overflow: "hidden" }}>
            {(["day", "week", "month", "all"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                style={{
                  padding: "6px 14px",
                  border: "none",
                  borderRadius: 0,
                  background: view === v ? "var(--aq-primary)" : "transparent",
                  color: view === v ? "#fff" : "inherit",
                  textTransform: "capitalize",
                  boxShadow: "none",
                }}
              >
                {v}
              </button>
            ))}
          </div>

          {view !== "week" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {view !== "all" ? (
                  <>
                    <button type="button" onClick={() => shift(-1)} aria-label="Previous" style={{ padding: "4px 10px" }}>‹</button>
                    <button type="button" onClick={goToday} style={{ padding: "4px 10px" }}>Today</button>
                    <button type="button" onClick={() => shift(1)} aria-label="Next" style={{ padding: "4px 10px" }}>›</button>
                  </>
                ) : null}
                <strong style={{ fontSize: 14, minWidth: 160, textAlign: "center" }}>{periodLabel}</strong>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--aq-muted)" }}>{view === "all" ? "Total" : "Period total"}</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{formatNumber(rangeTotal, 2)}h {loading ? "…" : ""}</div>
              </div>
            </>
          ) : (
            <span style={{ fontSize: 12, color: "var(--aq-muted)" }}>Grid entry — rows × days</span>
          )}
        </div>

        {/* Body */}
        {view === "month" ? (
          <MonthCalendar />
        ) : view === "day" ? (
          <DayCard dISO={iso(anchor)} />
        ) : view === "week" ? null : (
          <div style={{ display: "grid", gap: 10 }}>
            {allDays.length === 0 ? (
              <p className="aq-lite-muted">No time entries.</p>
            ) : (
              allDays.map((dISO) => <DayCard key={dISO} dISO={dISO} />)
            )}
          </div>
        )}

        <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", minHeight: 20 }}>
          {info ? <span className="aq-lite-muted">{info}</span> : null}
          {error ? <span style={{ color: "var(--aq-red)" }}>{error}</span> : null}
          <span style={{ marginLeft: "auto" }} className="aq-lite-muted">
            {viewedName}
          </span>
        </div>
      </section>

      {/* Week = the classic grid (rows × days), reused from WeeklyTimeEntry — it brings
          its own employee picker + week navigation + Save. */}
      {view === "week" ? (
        <WeeklyTimeEntry
          user={user}
          projects={projects}
          wbsByProject={wbsByProject}
          timeEntries={timeEntries}
          onProjectPick={onProjectPick}
          onSaved={onSaved}
          isAdmin={isAdmin}
          staffOptions={staffOptions}
        />
      ) : null}

      {/* Add / edit item modal */}
      {editor ? (
        <div
          onClick={() => setEditor(null)}
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
            onClick={(ev) => ev.stopPropagation()}
            style={{
              background: "var(--aq-card)",
              border: "1px solid var(--aq-border)",
              borderRadius: 12,
              padding: 18,
              width: "min(560px, 94vw)",
              boxShadow: "0 12px 44px rgba(0,0,0,0.28)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <strong style={{ fontSize: 15 }}>{editor.entryId == null ? "Add item" : "Edit item"}</strong>
              <span className="aq-lite-muted" style={{ fontSize: 12 }}>
                {parseIso(editor.dateIso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
              </span>
            </div>

            <label style={{ display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 8 }}>
              Project
              <select
                value={editor.projectId}
                onChange={(e) => {
                  const v = e.target.value;
                  setEditor((s) => (s ? { ...s, projectId: v, taskId: "", subtaskId: "" } : s));
                  if (v) void onProjectPick(v).catch(() => {});
                }}
                style={{ display: "block", width: "100%", marginTop: 4 }}
              >
                <option value="">Select project</option>
                {projectsOnly.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>
                Task
                <select
                  value={editor.taskId}
                  onChange={(e) => setEditor((s) => (s ? { ...s, taskId: e.target.value, subtaskId: "" } : s))}
                  disabled={!editor.projectId}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                >
                  <option value="">Select task</option>
                  {tasksFor(editorRow.pid).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, color: "var(--aq-muted)" }}>
                Subtask
                <select
                  value={editor.subtaskId}
                  onChange={(e) => setEditor((s) => (s ? { ...s, subtaskId: e.target.value } : s))}
                  disabled={!editor.taskId}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                >
                  <option value="">Select subtask</option>
                  {subtasksFor(editorRow.pid, editorRow.tid).map((s) => (
                    <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <label style={{ display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 8 }}>
              Hours
              <input
                type="number"
                min={0}
                max={24}
                step={0.25}
                value={editor.hours}
                onChange={(e) => setEditor((s) => (s ? { ...s, hours: e.target.value } : s))}
                style={{ display: "block", width: 120, marginTop: 4 }}
              />
            </label>

            <label style={{ display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 8 }}>
              Notes
              <textarea
                value={editor.note}
                onChange={(e) => setEditor((s) => (s ? { ...s, note: e.target.value } : s))}
                rows={3}
                placeholder="Describe the work done for this item"
                style={{ display: "block", width: "100%", marginTop: 4, fontFamily: "inherit", fontSize: 13, resize: "vertical" }}
              />
            </label>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void saveEditor()}
                disabled={busy}
                style={{ background: "var(--aq-primary)", color: "#fff" }}
              >
                {busy ? "Saving…" : editor.entryId == null ? "Add item" : "Save"}
              </button>
              <button type="button" onClick={() => setEditor(null)}>Cancel</button>
              {editor.entryId != null ? (
                <button
                  type="button"
                  onClick={() => void deleteEntry(editor.entryId as number)}
                  disabled={busy}
                  style={{ marginLeft: "auto", color: "var(--aq-red)", border: "1px solid var(--aq-border)", background: "transparent" }}
                >
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
