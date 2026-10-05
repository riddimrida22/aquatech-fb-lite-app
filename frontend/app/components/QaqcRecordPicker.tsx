"use client";

// Timesheet side of QA/QC (QP-01 section 6). Picking a QA/QC subtask starts the QA/QC
// workflow right here: choose the open record the time is for, or start a new review
// (the employee becomes the reviewer and must name whose work it is). The record number
// is written at the start of the note; the server links the entry to the record from it,
// so Day, Week and the mobile timesheet all agree.

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

type OpenRecord = {
  id: number; record_no: string; title: string; status: string;
  reviewer_name: string | null; preparer_name: string | null; mine: boolean;
};
type Person = { id: number; name: string };
type Meta = { me: { id: number; name: string }; users: Person[] };

export const QAQC_RECORD_RE = /\bQA-[A-Z0-9][A-Z0-9-]{0,22}?-\d{3,4}\b/i;
// Opening a record from the timesheet: page.tsx switches to the QA/QC workspace and
// QaqcWorkspace opens the record stored under this key.
export const QAQC_OPEN_EVENT = "aqtpm:open-qaqc";
export const QAQC_OPEN_KEY = "aqtpm.qaqc.openRecord";

export function noteHasRecord(note: string): boolean {
  return QAQC_RECORD_RE.test(note || "");
}

function withRecord(note: string, recordNo: string): string {
  const rest = (note || "").replace(QAQC_RECORD_RE, "").replace(/^[\s:;,-]+/, "");
  return recordNo ? `${recordNo}: ${rest}` : rest;
}

export function openQaqcRecord(reviewId: number) {
  try { window.sessionStorage.setItem(QAQC_OPEN_KEY, String(reviewId)); } catch { /* storage blocked */ }
  window.dispatchEvent(new CustomEvent(QAQC_OPEN_EVENT, { detail: { reviewId } }));
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 8 };
const ctl: React.CSSProperties = { display: "block", width: "100%", marginTop: 4, boxSizing: "border-box" };
const NEW = "__new__";

export default function QaqcRecordPicker({ projectId, taskId, note, onNote }: {
  projectId: number;
  taskId: number;
  note: string;
  onNote: (note: string) => void;
}) {
  const [records, setRecords] = useState<OpenRecord[] | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [starting, setStarting] = useState(false);
  const [form, setForm] = useState({ title: "", preparer: "" as number | "", sources: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: number; record_no: string } | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    apiGet<OpenRecord[]>(`/qaqc/open-records?project_id=${projectId}`)
      .then((rs) => {
        setRecords(rs);
        // Selecting the QA/QC subtask triggers QA/QC: with no open review to charge to,
        // go straight to starting one.
        if (rs.length === 0 && !noteHasRecord(note)) setStarting(true);
      })
      .catch(() => setRecords([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { apiGet<Meta>("/qaqc/meta").then(setMeta).catch(() => setMeta(null)); }, []);

  const current = (note.match(QAQC_RECORD_RE)?.[0] || "").toUpperCase();
  const currentRec = (records || []).find((r) => r.record_no === current);

  async function start() {
    setErr(null);
    if (form.title.trim().length < 3) { setErr("Say what you are checking."); return; }
    if (!form.preparer) { setErr("Name whose work you are checking (the preparer)."); return; }
    setBusy(true);
    try {
      const d = await apiPost<{ review: { id: number; record_no: string } }>("/qaqc/reviews", {
        project_id: projectId, task_id: taskId, title: form.title.trim(),
        preparer_user_id: form.preparer, sources: form.sources.trim(),
      });
      onNote(withRecord(note, d.review.record_no));
      setOpened({ id: d.review.id, record_no: d.review.record_no });
      setStarting(false);
      setForm({ title: "", preparer: "", sources: "" });
      load();
    } catch (e) {
      const m = e instanceof Error ? e.message.replace(/^\d{3}\s*/, "") : String(e);
      try { setErr(JSON.parse(m).detail || m); } catch { setErr(m); }
    } finally { setBusy(false); }
  }

  const others = (meta?.users || []).filter((u) => u.id !== meta?.me.id);

  return (
    <div style={{ marginBottom: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(22,107,119,0.35)", background: "rgba(22,107,119,0.06)" }}>
      <label style={lbl}>
        QA/QC review this time is for
        <select
          value={starting ? NEW : current}
          onChange={(e) => {
            const v = e.target.value;
            if (v === NEW) { setStarting(true); return; }
            setStarting(false);
            onNote(withRecord(note, v));
          }}
          style={ctl}
        >
          <option value="">Select QA/QC review</option>
          {(records || []).map((r) => (
            <option key={r.id} value={r.record_no}>
              {r.record_no} · {r.title}{r.reviewer_name ? ` (reviewer ${r.reviewer_name})` : ""}
            </option>
          ))}
          {current && records && !currentRec ? <option value={current}>{current}</option> : null}
          <option value={NEW}>+ Start a new QA/QC review</option>
        </select>
      </label>

      {starting ? (
        <div>
          <p style={{ fontSize: 12, margin: "0 0 6px", color: "var(--aq-muted)" }}>
            Start a QA/QC review. You will be the reviewer; you cannot review your own work.
          </p>
          <label style={lbl}>What are you checking?
            <input style={ctl} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. JA regulators 1-8: RIP drawing readings vs model" />
          </label>
          <label style={lbl}>Whose work is it? (preparer)
            <select style={ctl} value={form.preparer} onChange={(e) => setForm({ ...form, preparer: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">Select the preparer</option>
              {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label style={lbl}>Checked against (optional)
            <input style={ctl} value={form.sources} onChange={(e) => setForm({ ...form, sources: e.target.value })}
              placeholder="e.g. RIP drawings, earlier model" />
          </label>
          {err ? <p className="aq-lite-error" style={{ fontSize: 12, margin: "0 0 6px" }}>{err}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={busy} onClick={start}>{busy ? "Starting..." : "Start review"}</button>
            {(records || []).length > 0 ? (
              <button type="button" onClick={() => { setStarting(false); setErr(null); }}
                style={{ background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.5)", boxShadow: "none" }}>
                Use an open review
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {!starting && (opened || currentRec) ? (
        <p style={{ fontSize: 12, margin: "2px 0 0" }}>
          {opened ? <>{opened.record_no} opened. </> : null}
          Record what you checked and what you found in the review:{" "}
          <button type="button" onClick={() => openQaqcRecord(opened?.id ?? currentRec!.id)}
            style={{ padding: "2px 8px", fontSize: 12 }}>
            Open {opened?.record_no ?? currentRec!.record_no}
          </button>
          <span style={{ color: "var(--aq-muted)" }}> (save this time first)</span>
        </p>
      ) : null}
    </div>
  );
}
