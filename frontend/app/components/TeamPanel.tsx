"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../../lib/api";

export type ProjectMemberOut = {
  id: number;
  project_id: number;
  user_id: number;
  user_name: string;
  user_email: string;
  role: string;
  allocation_pct: number;
  start_date: string | null;
  end_date: string | null;
  notes: string;
};

export type StaffOption = { id: number; full_name: string; email: string };

const ROLE_OPTIONS = ["Lead", "PM", "Engineer", "QA/QC", "Reviewer", "Admin Support", "Other"];

type TeamPanelProps = {
  projectId: number;
  canManage: boolean;
  staffOptions: StaffOption[];
  /** Called any time members change so parent can refresh other panels (PM badge etc.). */
  onChange?: () => void;
};

export function TeamPanel({ projectId, canManage, staffOptions, onChange }: TeamPanelProps) {
  const [members, setMembers] = useState<ProjectMemberOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    user_id: "",
    role: "Engineer",
    allocation_pct: "",
    notes: "",
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const rows = await apiGet<ProjectMemberOut[]>(`/projects/${projectId}/members`);
      setMembers(rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.user_id) return;
    setSubmitting(true);
    try {
      await apiPost<ProjectMemberOut>(`/projects/${projectId}/members`, {
        user_id: Number(form.user_id),
        role: form.role,
        allocation_pct: Number(form.allocation_pct) || 0,
        notes: form.notes,
      });
      setForm({ user_id: "", role: "Engineer", allocation_pct: "", notes: "" });
      setShowAdd(false);
      await load();
      onChange?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add member");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateRole(m: ProjectMemberOut, newRole: string) {
    try {
      await apiPut<ProjectMemberOut>(`/projects/${projectId}/members/${m.id}`, {
        role: newRole,
        allocation_pct: m.allocation_pct,
        start_date: m.start_date,
        end_date: m.end_date,
        notes: m.notes,
      });
      await load();
      onChange?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function remove(m: ProjectMemberOut) {
    if (!confirm(`Remove ${m.user_name} (${m.role}) from this project?`)) return;
    try {
      await apiDelete(`/projects/${projectId}/members/${m.id}`);
      await load();
      onChange?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Team & roles</p>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowAdd((s) => !s)}
            style={{ padding: "4px 10px", fontSize: 12 }}
          >
            {showAdd ? "Cancel" : "+ Add member"}
          </button>
        ) : null}
      </div>

      {showAdd && canManage ? (
        <form
          onSubmit={add}
          style={{
            border: "1px solid var(--aq-border)",
            borderRadius: 8,
            padding: 10,
            marginBottom: 8,
            background: "var(--aq-subtle)",
            display: "grid",
            gridTemplateColumns: "1fr 1fr 90px",
            gap: 8,
            alignItems: "end",
          }}
        >
          <label style={{ fontSize: 11, color: "var(--aq-muted)" }}>
            Person
            <select
              value={form.user_id}
              onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
              required
              style={{ width: "100%" }}
            >
              <option value="">— pick —</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, color: "var(--aq-muted)" }}>
            Role
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              style={{ width: "100%" }}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={submitting} style={{ padding: "6px 8px" }}>
            {submitting ? "…" : "Add"}
          </button>
          <label style={{ fontSize: 11, color: "var(--aq-muted)", gridColumn: "1 / span 3" }}>
            Notes (optional)
            <input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="e.g. Roger does QA on deliverables"
              style={{ width: "100%" }}
            />
          </label>
        </form>
      ) : null}

      {loading ? (
        <p className="aq-lite-muted" style={{ fontSize: 12 }}>Loading…</p>
      ) : err ? (
        <p style={{ fontSize: 12, color: "var(--aq-red)" }}>{err}</p>
      ) : members.length === 0 ? (
        <p className="aq-lite-muted" style={{ fontSize: 12 }}>No team members assigned yet.</p>
      ) : (
        <table className="aq-lite-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Notes</th>
              {canManage ? <th data-disable-sort="true" style={{ width: 90 }}></th> : null}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.user_name}</strong>
                  <div style={{ fontSize: 10, color: "var(--aq-muted)" }}>{m.user_email}</div>
                </td>
                <td>
                  {canManage ? (
                    <select
                      value={m.role}
                      onChange={(e) => updateRole(m, e.target.value)}
                      style={{ padding: "2px 6px", fontSize: 12 }}
                    >
                      {ROLE_OPTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{m.role}</span>
                  )}
                </td>
                <td style={{ color: "var(--aq-muted)" }}>{m.notes || "—"}</td>
                {canManage ? (
                  <td>
                    <button
                      type="button"
                      onClick={() => remove(m)}
                      style={{
                        padding: "2px 10px",
                        fontSize: 11,
                        background: "transparent",
                        color: "var(--aq-red)",
                        border: "1px solid var(--aq-border)",
                        boxShadow: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Remove
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
