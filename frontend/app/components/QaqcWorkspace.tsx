"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiDelete, apiGet, apiPost, apiPut } from "../../lib/api";

// QA/QC reviews — Quality Procedure QP-01, done online.
// Part 1 details · Part 2 items checked · Part 3 findings (resolution + back-check)
// Part 4 reviewer certification · Part 5 closure. Time is linked by the record
// number at the start of the timesheet note (QA-<code>-<seq>).

type Person = { id: number; name: string };
type Proj = { id: number; name: string; active: boolean; code: string };
type Meta = {
  me: { id: number; name: string; is_pm: boolean; is_admin: boolean };
  users: Person[];
  projects: Proj[];
  certification_text: string;
  closure_text: string;
};
type TaskOpt = { id: number; name: string; qaqc_subtask: { id: number; code: string; name: string } | null };
type Summary = {
  id: number; record_no: string; project_id: number; project_name: string | null; task_id: number | null;
  title: string; status: string; preparer_name: string | null; reviewer_name: string | null;
  preparer_user_id: number | null; reviewer_user_id: number;
  opened_at: string | null; certified_at: string | null; closed_at: string | null;
  items: number; findings: number; open_major: number; open_minor: number; awaiting_backcheck: number;
};
type Item = { id: number; seq: number; item: string; source: string; value_work: string; value_source: string; result: string; finding_id: number | null; finding_seq: number | null };
type Finding = {
  id: number; seq: number; description: string; evidence: string; severity: string; action_required: string;
  assigned_user_id: number | null; assigned_name: string | null; status: string;
  resolution_note: string; resolution_version: string; resolved_by: string | null; resolved_at: string | null;
  decision_note: string; decided_by: string | null; decided_at: string | null;
  backcheck_note: string; verified_by: string | null; verified_at: string | null;
};
type Detail = {
  review: Summary & {
    project_code: string; task_name: string | null; subtask: { id: number; code: string; name: string } | null;
    version_reviewed: string; sources: string; scope: string; planned_hours: number | null;
    opened_by: string | null; certified_by: string | null; certification_text: string;
    closed_by: string | null; closed_version: string; closure_text: string;
    release_approved_by: string | null; release_approved_at: string | null; release_note: string;
  };
  items: Item[];
  findings: Finding[];
  attachments: { id: number; finding_id: number | null; finding_seq: number | null; filename: string; size_bytes: number; uploaded_by: string | null; created_at: string | null }[];
  events: { at: string | null; who: string | null; action: string; detail: string; finding_seq: number | null }[];
  time: { scope: string; hours: number; entries: { id: number; work_date: string | null; who: string | null; hours: number; note: string }[] };
  permissions: { can_edit: boolean; is_reviewer: boolean; is_preparer: boolean; is_pm: boolean; is_admin: boolean; me: number };
};
type OpenFinding = { review_id: number; record_no: string; title: string; finding_id: number; seq: number; severity: string; status: string; description: string; assigned_name: string | null; raised: string; business_days_open: number };

const RED = "#b42318";
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T12:00:00` : `${iso}Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US");
};
const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(`${iso}Z`);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
};
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.replace(/^\d{3}\s*/, "");
  try { const p = JSON.parse(j); return typeof p.detail === "string" ? p.detail : j; } catch { return j; }
};

const STATUS_BADGE: Record<string, string> = {
  open: "aq-lite-badge aq-lite-badge-info", certified: "aq-lite-badge aq-lite-badge-warn", closed: "aq-lite-badge aq-lite-badge-good",
};
const STATUS_LABEL: Record<string, string> = { open: "In review", certified: "Certified", closed: "Closed" };
const F_LABEL: Record<string, string> = {
  open: "Open", resolved: "Resolved, awaiting back-check", returned: "Returned to preparer", verified: "Verified closed", closed_by_decision: "Closed by decision",
};
const F_BADGE: Record<string, string> = {
  open: "aq-lite-badge aq-lite-badge-bad", returned: "aq-lite-badge aq-lite-badge-bad", resolved: "aq-lite-badge aq-lite-badge-warn",
  verified: "aq-lite-badge aq-lite-badge-good", closed_by_decision: "aq-lite-badge aq-lite-badge-neutral",
};
const SEV_LABEL: Record<string, string> = { major: "Major", minor: "Minor", observation: "Observation" };

const nowrap: React.CSSProperties = { whiteSpace: "nowrap" };
// Neutral outline button: reads correctly in light and dark themes.
const quiet: React.CSSProperties = { background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.5)", boxShadow: "none" };
const box: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.25)", borderRadius: 10, padding: 14, marginTop: 14 };
const h4: React.CSSProperties = { margin: "0 0 8px", fontSize: 15 };
const cell: React.CSSProperties = { verticalAlign: "top", padding: "6px 8px" };
const full: React.CSSProperties = { width: "100%", boxSizing: "border-box" };

export default function QaqcWorkspace() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [view, setView] = useState<"records" | "findings" | "new" | "detail">("records");
  const [list, setList] = useState<Summary[]>([]);
  const [filterProject, setFilterProject] = useState<number | "">("");
  const [filterStatus, setFilterStatus] = useState("");
  const [mine, setMine] = useState(false);
  const [openFindings, setOpenFindings] = useState<OpenFinding[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { apiGet<Meta>("/qaqc/meta").then(setMeta).catch((e) => setErr(errText(e))); }, []);

  const loadList = useCallback(() => {
    const q = new URLSearchParams();
    if (filterProject) q.set("project_id", String(filterProject));
    if (filterStatus) q.set("status", filterStatus);
    if (mine) q.set("mine", "true");
    apiGet<Summary[]>(`/qaqc/reviews?${q.toString()}`).then(setList).catch((e) => setErr(errText(e)));
  }, [filterProject, filterStatus, mine]);
  useEffect(() => { if (view === "records") loadList(); }, [view, loadList]);
  useEffect(() => {
    if (view === "findings") apiGet<OpenFinding[]>("/qaqc/findings/open").then(setOpenFindings).catch((e) => setErr(errText(e)));
  }, [view]);

  const openRecord = useCallback((id: number) => {
    setErr(null); setMsg(null);
    apiGet<Detail>(`/qaqc/reviews/${id}`).then((d) => { setDetail(d); setView("detail"); }).catch((e) => setErr(errText(e)));
  }, []);

  // Every action returns the full record; one helper keeps the view in step.
  const act = useCallback(async (fn: () => Promise<Detail>, ok?: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { const d = await fn(); setDetail(d); if (ok) setMsg(ok); return true; }
    catch (e) { setErr(errText(e)); return false; }
    finally { setBusy(false); }
  }, []);

  if (!meta) return <section className="aq-lite-panel"><p className="aq-lite-muted">{err || "Loading QA/QC..."}</p></section>;

  return (
    <section className="aq-lite-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Quality Procedure QP-01</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>QA/QC Reviews</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 680 }}>
            Each review records what was checked, what was found and who certifies it. Findings stay open until the
            reviewer back-checks the corrected work. Charge review time to the task&apos;s QA/QC subtask and start the
            timesheet note with the record number.
          </p>
        </div>
        <div className="aq-lite-segmented">
          <button type="button" className={view === "records" || view === "detail" ? "active" : ""} onClick={() => setView("records")}>Records</button>
          <button type="button" className={view === "findings" ? "active" : ""} onClick={() => setView("findings")}>Open findings</button>
          <button type="button" className={view === "new" ? "active" : ""} onClick={() => { setErr(null); setView("new"); }}>Open a new review</button>
        </div>
      </div>

      {err ? <p className="aq-lite-error-banner" style={{ marginTop: 10, marginBottom: 0, padding: "8px 12px" }}>{err}</p> : null}
      {msg ? <p className="aq-lite-flash" style={{ marginTop: 10, marginBottom: 0, padding: "8px 12px" }}>{msg}</p> : null}

      {view === "records" ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <select value={filterProject} onChange={(e) => setFilterProject(e.target.value ? Number(e.target.value) : "")} style={{ maxWidth: 300 }}>
              <option value="">All projects</option>
              {meta.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">Any status</option><option value="open">In review</option>
              <option value="certified">Certified (findings being worked)</option><option value="closed">Closed</option>
            </select>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only records I am on
            </label>
          </div>
          {list.length === 0 ? <p className="aq-lite-muted">No QA/QC records yet. Use &quot;Open a new review&quot; to start one.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
                <thead><tr>
                  <th style={{ textAlign: "left" }}>Record</th><th style={{ textAlign: "left" }}>Project</th>
                  <th style={{ textAlign: "left", minWidth: 280 }}>Work product reviewed</th><th style={{ textAlign: "left" }}>Reviewer</th>
                  <th style={{ textAlign: "left" }}>Preparer</th><th style={{ textAlign: "left" }}>Status</th>
                  <th style={{ textAlign: "left" }}>Findings</th><th style={{ textAlign: "left" }}>Opened</th>
                </tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} onClick={() => openRecord(r.id)} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{r.record_no}</td>
                      <td>{r.project_name}</td><td>{r.title}</td><td>{r.reviewer_name}</td><td>{r.preparer_name || ""}</td>
                      <td><span className={STATUS_BADGE[r.status]} style={nowrap}>{STATUS_LABEL[r.status]}</span></td>
                      <td style={{ whiteSpace: "nowrap", color: r.open_major ? RED : undefined }}>
                        {r.findings}
                        {r.open_major + r.open_minor > 0 ? ` (${r.open_major + r.open_minor} open${r.open_major ? `, ${r.open_major} major` : ""})` : ""}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.opened_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {view === "findings" ? (
        <div style={{ marginTop: 14 }}>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, marginTop: 0 }}>
            Every Major or Minor finding not yet verified closed, oldest first. Findings open more than 10 business days are raised with the Principal.
          </p>
          {openFindings.length === 0 ? <p className="aq-lite-muted">No open findings.</p> : (
            <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
              <thead><tr>
                <th style={{ textAlign: "left" }}>Record</th><th style={{ textAlign: "left" }}>No.</th><th style={{ textAlign: "left" }}>Severity</th>
                <th style={{ textAlign: "left" }}>Finding</th><th style={{ textAlign: "left" }}>Assigned to</th>
                <th style={{ textAlign: "left" }}>Status</th><th style={{ textAlign: "left" }}>Raised</th><th style={{ textAlign: "right" }}>Business days open</th>
              </tr></thead>
              <tbody>
                {openFindings.map((f) => (
                  <tr key={f.finding_id} onClick={() => openRecord(f.review_id)} style={{ cursor: "pointer" }}>
                    <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{f.record_no}</td><td>{f.seq}</td><td>{SEV_LABEL[f.severity]}</td>
                    <td>{f.description}</td><td>{f.assigned_name || ""}</td>
                    <td><span className={F_BADGE[f.status]} style={nowrap}>{F_LABEL[f.status]}</span></td>
                    <td>{fmtDate(f.raised)}</td>
                    <td style={{ textAlign: "right", fontWeight: f.business_days_open > 10 ? 700 : 400, color: f.business_days_open > 10 ? RED : undefined }}>{f.business_days_open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {view === "new" ? (
        <NewReview meta={meta} onCreated={(d) => { setDetail(d); setView("detail"); setMsg(`${d.review.record_no} opened.`); }} onError={setErr} />
      ) : null}

      {view === "detail" && detail ? (
        <RecordView d={detail} meta={meta} busy={busy} act={act} onBack={() => { setView("records"); setDetail(null); }} />
      ) : null}
    </section>
  );
}

// ----------------------------------------------------------------- new review (Part 1)
function NewReview({ meta, onCreated, onError }: { meta: Meta; onCreated: (d: Detail) => void; onError: (m: string | null) => void }) {
  const [projectId, setProjectId] = useState<number | "">("");
  const [tasks, setTasks] = useState<TaskOpt[]>([]);
  const [f, setF] = useState({ task_id: "" as number | "", title: "", version_reviewed: "", preparer_user_id: "" as number | "",
    reviewer_user_id: meta.me.id as number | "", sources: "", scope: "", planned_hours: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!projectId) { setTasks([]); return; }
    apiGet<TaskOpt[]>(`/qaqc/projects/${projectId}/tasks`).then((t) => {
      setTasks(t);
      setF((s) => ({ ...s, task_id: t.length === 1 ? t[0].id : "" }));
    }).catch((e) => onError(errText(e)));
  }, [projectId, onError]);
  const task = tasks.find((t) => t.id === f.task_id);
  const project = meta.projects.find((p) => p.id === projectId);
  const submit = async () => {
    onError(null);
    if (!projectId || !f.task_id || f.title.trim().length < 3) { onError("Pick the project and task, and describe the work product reviewed."); return; }
    setSaving(true);
    try {
      const d = await apiPost<Detail>("/qaqc/reviews", {
        project_id: projectId, task_id: f.task_id, title: f.title, version_reviewed: f.version_reviewed,
        preparer_user_id: f.preparer_user_id || null, reviewer_user_id: f.reviewer_user_id || null,
        sources: f.sources, scope: f.scope, planned_hours: f.planned_hours ? Number(f.planned_hours) : null,
      });
      onCreated(d);
    } catch (e) { onError(errText(e)); } finally { setSaving(false); }
  };
  return (
    <div style={box}>
      <h4 style={h4}>Part 1. Review details</h4>
      <p className="aq-lite-muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Open the record before checking starts. The record number is assigned when you save
        {project ? <> (next for this project: <strong>QA-{project.code}-...</strong>)</> : null}.
      </p>
      <div className="aq-lite-form-grid" style={{ alignItems: "start" }}>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Project
          <select value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select project</option>
            {meta.projects.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Task
          <select value={f.task_id} onChange={(e) => setF({ ...f, task_id: e.target.value ? Number(e.target.value) : "" })} disabled={!tasks.length}>
            <option value="">Select task</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {task ? <span className="aq-lite-muted" style={{ fontSize: 12, fontWeight: 400 }}>
            {task.qaqc_subtask ? <>QA/QC time is charged to subtask &quot;{task.qaqc_subtask.name}&quot;.</> : <>A &quot;QA/QC&quot; subtask will be added to this task for review time.</>}
          </span> : null}
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Work product reviewed
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. JA regulators 1-8: RIP drawing readings vs model" />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Version or date reviewed
          <input value={f.version_reviewed} onChange={(e) => setF({ ...f, version_reviewed: e.target.value })} placeholder="e.g. Master spreadsheet 2026-09-30" />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Planned review hours
          <input type="number" min={0} step={0.25} value={f.planned_hours} onChange={(e) => setF({ ...f, planned_hours: e.target.value })} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Preparer (who produced the work)
          <select value={f.preparer_user_id} onChange={(e) => setF({ ...f, preparer_user_id: e.target.value ? Number(e.target.value) : "" })}>
            <option value="">Select</option>
            {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Reviewer
          <select value={f.reviewer_user_id} disabled={!meta.me.is_pm} onChange={(e) => setF({ ...f, reviewer_user_id: e.target.value ? Number(e.target.value) : "" })}>
            {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Sources checked against
          <textarea rows={2} value={f.sources} onChange={(e) => setF({ ...f, sources: e.target.value })} placeholder="Record drawings, client data, earlier model, standard..." />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Scope of check (all, or a sample and how it was chosen)
          <textarea rows={2} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} />
        </label>
      </div>
      {f.preparer_user_id && f.preparer_user_id === f.reviewer_user_id ? <p style={{ color: RED, fontSize: 13 }}>The reviewer cannot be the preparer of the work.</p> : null}
      <div style={{ marginTop: 12 }}><button type="button" onClick={submit} disabled={saving}>{saving ? "Opening..." : "Open record"}</button></div>
    </div>
  );
}

// ----------------------------------------------------------------- record view (Parts 1-5)
function RecordView({ d, meta, busy, act, onBack }: {
  d: Detail; meta: Meta; busy: boolean; onBack: () => void;
  act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean>;
}) {
  const r = d.review;
  const p = d.permissions;
  const rid = r.id;
  const blocking = d.findings.filter((f) => f.severity !== "observation" && !["verified", "closed_by_decision"].includes(f.status));
  const openMinor = d.findings.filter((f) => f.severity === "minor" && !["verified", "closed_by_decision"].includes(f.status));
  const openMajor = d.findings.filter((f) => f.severity === "major" && !["verified", "closed_by_decision"].includes(f.status));

  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" onClick={onBack} style={quiet}>Back to records</button>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
        <h3 style={{ margin: 0, fontSize: 20 }}>{r.record_no}</h3>
        <span className={STATUS_BADGE[r.status]} style={nowrap}>{STATUS_LABEL[r.status]}</span>
        <span className="aq-lite-muted" style={{ fontSize: 13 }}>{r.project_name}{r.task_name ? ` / ${r.task_name}` : ""}</span>
      </div>
      {r.status !== "closed" && r.subtask ? (
        <p style={{ fontSize: 13, margin: "8px 0 0", padding: "8px 10px", borderRadius: 8, background: "rgba(22,107,119,0.08)" }}>
          Timesheet: charge review and back-check time to <strong>{r.task_name} / {r.subtask.name}</strong> and start the note with <strong>{r.record_no}</strong>.
        </p>
      ) : null}

      <Part1 d={d} meta={meta} busy={busy} act={act} />
      <Part2 d={d} busy={busy} act={act} />
      <Part3 d={d} meta={meta} busy={busy} act={act} />
      <Attachments d={d} busy={busy} act={act} />

      <div style={box}>
        <h4 style={h4}>Part 4. Reviewer certification</h4>
        <p style={{ fontSize: 13, fontStyle: "italic", margin: "0 0 10px" }}>{meta.certification_text}</p>
        {r.status === "open" ? (
          p.is_reviewer ? (
            <button type="button" disabled={busy || d.items.length === 0}
              onClick={() => { if (window.confirm(`Certify ${r.record_no} as ${meta.me.name}? Parts 1-3 are locked once certified.`)) act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/certify`), "Certified. The findings are now with the preparer."); }}>
              Certify as {meta.me.name}
            </button>
          ) : <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>Awaiting certification by the reviewer, {r.reviewer_name}.</p>
        ) : (
          <p style={{ fontSize: 13, margin: 0 }}>Signed by <strong>{r.certified_by}</strong> on {fmtDateTime(r.certified_at)}.</p>
        )}
        {r.status === "open" && p.is_reviewer && d.items.length === 0 ? <p className="aq-lite-muted" style={{ fontSize: 12, marginBottom: 0 }}>List at least one item checked before certifying.</p> : null}
      </div>

      <Part5 d={d} meta={meta} busy={busy} act={act} blocking={blocking} openMinor={openMinor} openMajor={openMajor} />

      <div style={box}>
        <h4 style={h4}>Hours charged to this record {d.time.scope === "mine" ? "(your entries)" : ""}</h4>
        {d.time.entries.length === 0 ? <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>No time entries carry {r.record_no} yet.</p> : (
          <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Date</th><th style={{ textAlign: "left" }}>Who</th><th style={{ textAlign: "right" }}>Hours</th><th style={{ textAlign: "left" }}>Note</th></tr></thead>
            <tbody>
              {d.time.entries.map((e) => <tr key={e.id}><td>{fmtDate(e.work_date)}</td><td>{e.who}</td><td style={{ textAlign: "right" }}>{e.hours.toFixed(2)}</td><td>{e.note}</td></tr>)}
              <tr style={{ fontWeight: 700 }}><td>Total</td><td /><td style={{ textAlign: "right" }}>{d.time.hours.toFixed(2)}</td><td>{r.planned_hours ? `Planned ${r.planned_hours} h` : ""}</td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div style={box}>
        <h4 style={h4}>Record history</h4>
        <table className="aq-lite-table" style={{ width: "100%", fontSize: 12.5 }}>
          <tbody>
            {d.events.map((e, i) => <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(e.at)}</td><td style={{ whiteSpace: "nowrap" }}>{e.who}</td><td>{e.detail}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Part1({ d, meta, busy, act }: { d: Detail; meta: Meta; busy: boolean; act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean> }) {
  const r = d.review;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ title: r.title, version_reviewed: r.version_reviewed, preparer_user_id: r.preparer_user_id ?? "",
    reviewer_user_id: r.reviewer_user_id, sources: r.sources, scope: r.scope, planned_hours: r.planned_hours ?? "" });
  useEffect(() => {
    setF({ title: r.title, version_reviewed: r.version_reviewed, preparer_user_id: r.preparer_user_id ?? "", reviewer_user_id: r.reviewer_user_id,
      sources: r.sources, scope: r.scope, planned_hours: r.planned_hours ?? "" });
  }, [r]);
  const rows: [string, string][] = [
    ["Record number", r.record_no], ["Project / task", `${r.project_name}${r.task_name ? ` / ${r.task_name}` : ""}`],
    ["Work product reviewed", r.title], ["Version or date reviewed", r.version_reviewed],
    ["Preparer", r.preparer_name || ""], ["Reviewer", r.reviewer_name || ""],
    ["Sources checked against", r.sources], ["Scope of check", r.scope],
    ["Date opened", `${fmtDate(r.opened_at)}${r.opened_by ? ` by ${r.opened_by}` : ""}`], ["Planned review hours", r.planned_hours != null ? String(r.planned_hours) : ""],
  ];
  return (
    <div style={box}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={h4}>Part 1. Review details</h4>
        {d.permissions.can_edit && !editing ? <button type="button" onClick={() => setEditing(true)}>Edit</button> : null}
      </div>
      {!editing ? (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <tbody>
            {Array.from({ length: Math.ceil(rows.length / 2) }).map((_, i) => (
              <tr key={i}>
                {rows.slice(i * 2, i * 2 + 2).map(([k, v]) => (
                  <Fragment key={k}><td className="aq-lite-muted" style={{ ...cell, width: "16%" }}>{k}</td><td style={{ ...cell, width: "34%", whiteSpace: "pre-wrap" }}>{v}</td></Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="aq-lite-form-grid" style={{ alignItems: "start" }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Work product reviewed<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Version or date reviewed<input value={f.version_reviewed} onChange={(e) => setF({ ...f, version_reviewed: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Planned review hours<input type="number" min={0} step={0.25} value={f.planned_hours} onChange={(e) => setF({ ...f, planned_hours: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Preparer
            <select value={f.preparer_user_id} onChange={(e) => setF({ ...f, preparer_user_id: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">Select</option>{meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Reviewer
            <select value={f.reviewer_user_id} disabled={!meta.me.is_pm} onChange={(e) => setF({ ...f, reviewer_user_id: Number(e.target.value) })}>
              {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Sources checked against<textarea rows={2} value={f.sources} onChange={(e) => setF({ ...f, sources: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>Scope of check<textarea rows={2} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={busy} onClick={async () => {
              const ok = await act(() => apiPut<Detail>(`/qaqc/reviews/${r.id}`, {
                project_id: r.project_id, task_id: r.task_id, title: f.title, version_reviewed: f.version_reviewed,
                preparer_user_id: f.preparer_user_id || null, reviewer_user_id: f.reviewer_user_id, sources: f.sources,
                scope: f.scope, planned_hours: f.planned_hours === "" ? null : Number(f.planned_hours),
              }), "Part 1 saved.");
              if (ok) setEditing(false);
            }}>Save</button>
            <button type="button" onClick={() => setEditing(false)} style={quiet}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Part2({ d, busy, act }: { d: Detail; busy: boolean; act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean> }) {
  const rid = d.review.id;
  const blank = { item: "", source: "", value_work: "", value_source: "", result: "agrees", finding_id: "" as number | "" };
  const [n, setN] = useState(blank);
  const canEdit = d.permissions.can_edit;
  return (
    <div style={box}>
      <h4 style={h4}>Part 2. Items checked</h4>
      <p className="aq-lite-muted" style={{ fontSize: 12.5, marginTop: 0 }}>List every item checked, including those that agree, so the record shows what was checked even when nothing was found.</p>
      <table className="aq-lite-table" data-disable-table-sort="true" style={{ width: "100%", fontSize: 13 }}>
        <thead><tr>
          <th style={{ textAlign: "left", width: 40 }}>No.</th><th style={{ textAlign: "left" }}>Item checked (element, location)</th>
          <th style={{ textAlign: "left" }}>Source used (document, sheet, date)</th><th style={{ textAlign: "left" }}>Value in work</th>
          <th style={{ textAlign: "left" }}>Value in source</th><th style={{ textAlign: "left" }}>Result</th>{canEdit ? <th /> : null}
        </tr></thead>
        <tbody>
          {d.items.map((i) => (
            <tr key={i.id}>
              <td style={cell}>{i.seq}</td><td style={cell}>{i.item}</td><td style={cell}>{i.source}</td>
              <td style={cell}>{i.value_work}</td><td style={cell}>{i.value_source}</td>
              <td style={cell}>{i.result === "finding" ? <span style={{ color: RED }}>Finding {i.finding_seq ?? ""}</span> : "Agrees"}</td>
              {canEdit ? <td style={cell}><button type="button" disabled={busy} style={{ padding: "2px 8px", fontSize: 12 }}
                onClick={() => act(() => apiDelete<Detail>(`/qaqc/reviews/${rid}/items/${i.id}`))}>Remove</button></td> : null}
            </tr>
          ))}
          {canEdit ? (
            <tr>
              <td style={cell}>{d.items.length + 1}</td>
              <td style={cell}><input style={full} value={n.item} onChange={(e) => setN({ ...n, item: e.target.value })} placeholder="e.g. JA-3 weir crest" /></td>
              <td style={cell}><input style={full} value={n.source} onChange={(e) => setN({ ...n, source: e.target.value })} placeholder="e.g. RIP JA-3 sheet 4" /></td>
              <td style={cell}><input style={full} value={n.value_work} onChange={(e) => setN({ ...n, value_work: e.target.value })} /></td>
              <td style={cell}><input style={full} value={n.value_source} onChange={(e) => setN({ ...n, value_source: e.target.value })} /></td>
              <td style={cell}>
                <select value={n.result === "finding" ? `f${n.finding_id}` : "agrees"} onChange={(e) => {
                  const v = e.target.value;
                  setN(v === "agrees" ? { ...n, result: "agrees", finding_id: "" } : { ...n, result: "finding", finding_id: Number(v.slice(1)) || "" });
                }}>
                  <option value="agrees">Agrees</option>
                  {d.findings.map((f) => <option key={f.id} value={`f${f.id}`}>Finding {f.seq}</option>)}
                </select>
              </td>
              <td style={cell}><button type="button" disabled={busy || !n.item.trim()} onClick={async () => {
                const ok = await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/items`, { ...n, finding_id: n.finding_id || null }));
                if (ok) setN(blank);
              }}>Add</button></td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {canEdit ? <p className="aq-lite-muted" style={{ fontSize: 12, marginBottom: 0 }}>To mark an item as a finding, log the finding in Part 3 first, then pick it in the Result column.</p> : null}
    </div>
  );
}

function Part3({ d, meta, busy, act }: { d: Detail; meta: Meta; busy: boolean; act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean> }) {
  const r = d.review;
  const p = d.permissions;
  const rid = r.id;
  const blank = { description: "", evidence: "", severity: "minor", action_required: "", assigned_user_id: "" as number | "" };
  const [n, setN] = useState(blank);
  const [inputs, setInputs] = useState<Record<number, { note: string; version: string }>>({});
  const getIn = (id: number) => inputs[id] || { note: "", version: "" };
  const setIn = (id: number, v: Partial<{ note: string; version: string }>) => setInputs((s) => ({ ...s, [id]: { ...getIn(id), ...v } }));

  return (
    <div style={box}>
      <h4 style={h4}>Part 3. Findings</h4>
      {d.findings.length === 0 && !p.can_edit ? <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>No findings were recorded.</p> : null}
      {d.findings.map((f) => {
        const canResolve = r.status === "certified" && ["open", "returned"].includes(f.status) && !p.is_reviewer && (p.me === f.assigned_user_id || p.is_preparer || p.is_pm);
        const canBackcheck = r.status === "certified" && f.status === "resolved" && p.is_reviewer;
        const canDecide = r.status === "certified" && p.is_pm && !["verified", "closed_by_decision"].includes(f.status);
        const v = getIn(f.id);
        return (
          <div key={f.id} style={{ borderTop: "1px solid rgba(128,128,128,0.2)", padding: "10px 0" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <strong>Finding {f.seq}</strong>
              <span className={f.severity === "major" ? "aq-lite-badge aq-lite-badge-bad" : f.severity === "minor" ? "aq-lite-badge aq-lite-badge-warn" : "aq-lite-badge aq-lite-badge-neutral"}>{SEV_LABEL[f.severity]}</span>
              <span className={F_BADGE[f.status]} style={nowrap}>{F_LABEL[f.status]}</span>
              <span className="aq-lite-muted" style={{ fontSize: 12.5 }}>Assigned to {f.assigned_name || "(not assigned)"}</span>
              {p.can_edit ? <button type="button" disabled={busy} style={{ padding: "2px 8px", fontSize: 12, marginLeft: "auto" }}
                onClick={() => { if (window.confirm(`Remove finding ${f.seq}?`)) act(() => apiDelete<Detail>(`/qaqc/reviews/${rid}/findings/${f.id}`)); }}>Remove</button> : null}
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 13.5, whiteSpace: "pre-wrap" }}>{f.description}</p>
            {f.evidence ? <p className="aq-lite-muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>Evidence: {f.evidence}</p> : null}
            {f.action_required ? <p style={{ margin: "4px 0 0", fontSize: 12.5 }}>Action required: {f.action_required}</p> : null}
            {f.resolved_at ? <p style={{ margin: "6px 0 0", fontSize: 12.5 }}>Resolution by {f.resolved_by} on {fmtDate(f.resolved_at)}: {f.resolution_note}{f.resolution_version ? ` (version ${f.resolution_version})` : ""}</p> : null}
            {f.verified_at ? <p style={{ margin: "4px 0 0", fontSize: 12.5 }}>Back-check by {f.verified_by} on {fmtDate(f.verified_at)}: {f.status === "verified" ? "verified closed" : "returned"}{f.backcheck_note ? `. ${f.backcheck_note}` : ""}</p> : null}
            {f.decided_at ? <p style={{ margin: "4px 0 0", fontSize: 12.5 }}>Decision by {f.decided_by} on {fmtDate(f.decided_at)}: {f.decision_note}</p> : null}

            {canResolve || canBackcheck || canDecide ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <input style={{ flex: "2 1 280px" }} value={v.note} onChange={(e) => setIn(f.id, { note: e.target.value })}
                  placeholder={canBackcheck ? "Back-check note (required when returning)" : canResolve ? "What was done to resolve it" : "Decision and reason"} />
                {canResolve ? <input style={{ flex: "1 1 160px" }} value={v.version} onChange={(e) => setIn(f.id, { version: e.target.value })} placeholder="Corrected version or date" /> : null}
                {canResolve ? <button type="button" disabled={busy || v.note.trim().length < 3} onClick={async () => {
                  if (await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/findings/${f.id}/resolve`, { note: v.note, version: v.version }), `Finding ${f.seq} resolved; awaiting back-check.`)) setIn(f.id, { note: "", version: "" });
                }}>Record resolution</button> : null}
                {canBackcheck ? <>
                  <button type="button" disabled={busy} onClick={async () => {
                    if (await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/findings/${f.id}/backcheck`, { verified: true, note: v.note }), `Finding ${f.seq} verified closed.`)) setIn(f.id, { note: "" });
                  }}>Verified closed</button>
                  <button type="button" disabled={busy || v.note.trim().length < 3} style={quiet} onClick={async () => {
                    if (await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/findings/${f.id}/backcheck`, { verified: false, note: v.note }), `Finding ${f.seq} returned to the preparer.`)) setIn(f.id, { note: "" });
                  }}>Return to preparer</button>
                </> : null}
                {canDecide ? <button type="button" disabled={busy || v.note.trim().length < 3} style={quiet} onClick={async () => {
                  if (window.confirm(`Close finding ${f.seq} by decision rather than correction?`) && await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/findings/${f.id}/decide`, { note: v.note }), `Finding ${f.seq} closed by decision.`)) setIn(f.id, { note: "" });
                }}>Close by decision (PM)</button> : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {p.can_edit ? (
        <div style={{ borderTop: "1px solid rgba(128,128,128,0.2)", paddingTop: 10, alignItems: "start" }} className="aq-lite-form-grid">
          <label style={{ display: "grid", gap: 4, fontSize: 13, gridColumn: "1 / -1" }}>New finding: description and location
            <textarea rows={2} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Evidence (sheet, page, element ID)
            <input value={n.evidence} onChange={(e) => setN({ ...n, evidence: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Severity
            <select value={n.severity} onChange={(e) => setN({ ...n, severity: e.target.value })}>
              <option value="major">Major: affects a result, value or conclusion</option>
              <option value="minor">Minor: presentation or documentation only</option>
              <option value="observation">Observation: no correction needed</option>
            </select></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Action required
            <input value={n.action_required} onChange={(e) => setN({ ...n, action_required: e.target.value })} /></label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>Assigned to (defaults to the preparer)
            <select value={n.assigned_user_id} onChange={(e) => setN({ ...n, assigned_user_id: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">{r.preparer_name ? `${r.preparer_name} (preparer)` : "Select"}</option>
              {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></label>
          <div><button type="button" disabled={busy || n.description.trim().length < 3} onClick={async () => {
            if (await act(() => apiPost<Detail>(`/qaqc/reviews/${rid}/findings`, { ...n, assigned_user_id: n.assigned_user_id || null }), "Finding logged.")) setN(blank);
          }}>Log finding</button></div>
        </div>
      ) : null}
    </div>
  );
}

function Attachments({ d, busy, act }: { d: Detail; busy: boolean; act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean> }) {
  const rid = d.review.id;
  const [file, setFile] = useState<File | null>(null);
  const [findingId, setFindingId] = useState("");
  const canUpload = d.review.status !== "closed";
  const upload = async () => {
    if (!file) return;
    const ok = await act(async () => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("finding_id", findingId);
      const res = await fetch(`${API_BASE}/qaqc/reviews/${rid}/attachments`, { method: "POST", credentials: "include", body: fd });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return res.json();
    }, "Attachment added.");
    if (ok) { setFile(null); const el = document.getElementById("qaqc-file") as HTMLInputElement | null; if (el) el.value = ""; }
  };
  return (
    <div style={box}>
      <h4 style={h4}>Mark-ups and screenshots</h4>
      {d.attachments.length === 0 ? <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 0 }}>None attached.</p> : (
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13 }}>
          {d.attachments.map((a) => (
            <li key={a.id}>
              <a href={`${API_BASE}/qaqc/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.filename}</a>
              <span className="aq-lite-muted"> {a.finding_seq ? `(Finding ${a.finding_seq}) ` : ""}{(a.size_bytes / 1024).toFixed(0)} KB, {a.uploaded_by}, {fmtDate(a.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      {canUpload ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input id="qaqc-file" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <select value={findingId} onChange={(e) => setFindingId(e.target.value)}>
            <option value="">Whole record</option>
            {d.findings.map((f) => <option key={f.id} value={String(f.id)}>Finding {f.seq}</option>)}
          </select>
          <button type="button" disabled={busy || !file} onClick={upload}>Attach</button>
        </div>
      ) : null}
    </div>
  );
}

function Part5({ d, meta, busy, act, blocking, openMinor, openMajor }: {
  d: Detail; meta: Meta; busy: boolean; act: (fn: () => Promise<Detail>, ok?: string) => Promise<boolean>;
  blocking: Finding[]; openMinor: Finding[]; openMajor: Finding[];
}) {
  const r = d.review;
  const p = d.permissions;
  const [version, setVersion] = useState("");
  const [release, setRelease] = useState("");
  const summary = useMemo(() => blocking.map((f) => f.seq).join(", "), [blocking]);
  return (
    <div style={box}>
      <h4 style={h4}>Part 5. Back-check and closure</h4>
      <p style={{ fontSize: 13, fontStyle: "italic", margin: "0 0 10px" }}>{meta.closure_text}</p>
      {r.status === "closed" ? (
        <p style={{ fontSize: 13, margin: 0 }}>Closed by <strong>{r.closed_by}</strong> on {fmtDateTime(r.closed_at)}. Corrected version examined: {r.closed_version}.</p>
      ) : r.status === "open" ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>Closure follows certification and the back-check of every Major and Minor finding.</p>
      ) : (
        <>
          {blocking.length ? <p style={{ fontSize: 13, margin: "0 0 8px", color: RED }}>Not yet verified closed: finding {summary}.</p> : null}
          {p.is_reviewer ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input style={{ flex: "1 1 280px" }} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Corrected version or date examined" />
              <button type="button" disabled={busy || blocking.length > 0 || !version.trim()} onClick={() => {
                if (window.confirm(`Close ${r.record_no} as ${meta.me.name}?`)) act(() => apiPost<Detail>(`/qaqc/reviews/${r.id}/close`, { version_examined: version }), `${r.record_no} closed.`);
              }}>Close record as {meta.me.name}</button>
            </div>
          ) : <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>The reviewer, {r.reviewer_name}, closes the record after the back-check.</p>}
        </>
      )}
      {r.release_approved_at ? (
        <p style={{ fontSize: 13, margin: "10px 0 0" }}>Release with open Minor findings approved by <strong>{r.release_approved_by}</strong> on {fmtDateTime(r.release_approved_at)}: {r.release_note}</p>
      ) : r.status === "certified" && p.is_admin && openMinor.length > 0 && openMajor.length === 0 ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <input style={{ flex: "1 1 280px" }} value={release} onChange={(e) => setRelease(e.target.value)} placeholder="Reason for releasing with open Minor findings" />
          <button type="button" disabled={busy || release.trim().length < 3} onClick={() => act(() => apiPost<Detail>(`/qaqc/reviews/${r.id}/approve-release`, { note: release }), "Release approved.")}>Approve release (Principal)</button>
        </div>
      ) : null}
    </div>
  );
}
