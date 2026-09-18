"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPut } from "../../lib/api";

type Project = { id: number; name: string };
type SubtaskRow = { subtask_id: number; subtask_name: string; code: string; task_id: number; task_name: string };
type UserRow = { user_id: number; name: string };
type EstRow = { subtask_id: number; user_id: number; est_hours: number };
type GridResp = { rows: EstRow[]; subtasks?: SubtaskRow[]; users?: UserRow[] };

const GOLD = "#b8860b";
const RED = "#b42318";

export default function HourEstimatesWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [grid, setGrid] = useState<GridResp | null>(null);
  const [est, setEst] = useState<Record<string, number>>({}); // `${subtask_id}:${user_id}` -> hours
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Project[]>("/projects")
      .then((ps) => {
        setProjects(ps);
        if (ps.length && projectId == null) {
          const nr = ps.find((p) => /north river/i.test(p.name)) || ps[0];
          setProjectId(nr.id);
        }
      })
      .catch((e) => setErr(e?.message || "Could not load projects"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    if (projectId == null) return;
    setLoading(true);
    setErr(null);
    apiGet<GridResp>(`/admin/subtask-hour-estimates?project_id=${projectId}`)
      .then((r) => {
        setGrid(r);
        const m: Record<string, number> = {};
        for (const row of r.rows) m[`${row.subtask_id}:${row.user_id}`] = row.est_hours;
        setEst(m);
        setLoading(false);
      })
      .catch((e) => { setErr(e?.message || "Could not load estimates"); setLoading(false); });
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const subtasks = grid?.subtasks ?? [];
  const users = grid?.users ?? [];

  const save = useCallback((subtaskId: number, userId: number, value: number) => {
    const key = `${subtaskId}:${userId}`;
    setEst((prev) => ({ ...prev, [key]: value }));
    setSaving(key);
    apiPut(`/admin/subtask-hour-estimates`, { subtask_id: subtaskId, user_id: userId, est_hours: value })
      .then(() => setSaving(null))
      .catch((e) => { setErr(e?.message || "Save failed"); setSaving(null); });
  }, []);

  const colTotals = useMemo(() => {
    const t: Record<number, number> = {};
    for (const s of subtasks) for (const u of users) t[u.user_id] = (t[u.user_id] || 0) + (est[`${s.subtask_id}:${u.user_id}`] || 0);
    return t;
  }, [subtasks, users, est]);
  const grand = useMemo(() => Object.values(colTotals).reduce((a, b) => a + b, 0), [colTotals]);
  const rowTotal = (sid: number) => users.reduce((a, u) => a + (est[`${sid}:${u.user_id}`] || 0), 0);

  return (
    <section className="aq-lite-panel" style={{ borderLeft: `3px solid ${GOLD}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0, color: GOLD }}>Admin · Budgeted LOE</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>Hour Estimates</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 620 }}>
            Budgeted hours per employee per subtask, from the fee proposal. Admin‑only — never shown on the employee timesheet. Edit a cell to save.
          </p>
        </div>
        <label className="aq-lite-muted" style={{ fontSize: 12 }}>
          Project{" "}
          <select value={projectId ?? ""} onChange={(e) => setProjectId(Number(e.target.value))} style={{ marginLeft: 4, maxWidth: 260 }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>

      {err ? <p style={{ color: RED, marginTop: 12 }}>{err}</p> : null}
      {loading ? <p className="aq-lite-muted" style={{ marginTop: 12 }}>Loading…</p> : null}

      {!loading && grid ? (
        subtasks.length === 0 ? (
          <p className="aq-lite-muted" style={{ marginTop: 14 }}>No subtasks on this project yet.</p>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <table className="aq-lite-table" style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", minWidth: 240 }}>Subtask</th>
                  {users.map((u) => <th key={u.user_id} style={{ textAlign: "right", minWidth: 74 }}>{u.name.split(" ")[0]}</th>)}
                  <th style={{ textAlign: "right", minWidth: 60 }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {subtasks.map((s) => (
                  <tr key={s.subtask_id}>
                    <td>
                      <span className="aq-lite-muted" style={{ fontSize: 11 }}>{s.task_name}</span><br />
                      {s.subtask_name}
                    </td>
                    {users.map((u) => {
                      const key = `${s.subtask_id}:${u.user_id}`;
                      return (
                        <td key={u.user_id} style={{ textAlign: "right" }}>
                          <input
                            type="number" min={0} step={1}
                            value={est[key] ?? 0}
                            onChange={(e) => setEst((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                            onBlur={(e) => save(s.subtask_id, u.user_id, Number(e.target.value))}
                            style={{ width: 60, textAlign: "right", border: saving === key ? `1px solid ${GOLD}` : "1px solid rgba(128,128,128,0.35)", borderRadius: 4, padding: "2px 4px", background: "transparent", color: "inherit" }}
                          />
                        </td>
                      );
                    })}
                    <td style={{ textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{rowTotal(s.subtask_id)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: "2px solid rgba(128,128,128,0.4)" }}>
                  <td>Total budgeted hours</td>
                  {users.map((u) => <td key={u.user_id} style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{colTotals[u.user_id] || 0}</td>)}
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{grand}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
