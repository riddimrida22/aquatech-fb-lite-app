"use client";

// Timesheet helper for QA/QC subtasks (QP-01 section 6): pick the QA/QC record the time is
// for, and the record number is written at the start of the note. The server links the
// entry to the record from that number, so Day, Week and the mobile timesheet all agree.

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";

type OpenRecord = { id: number; record_no: string; title: string; status: string };

export const QAQC_RECORD_RE = /\bQA-[A-Z0-9][A-Z0-9-]{0,22}?-\d{3,4}\b/i;

export function noteHasRecord(note: string): boolean {
  return QAQC_RECORD_RE.test(note || "");
}

function withRecord(note: string, recordNo: string): string {
  const rest = (note || "").replace(QAQC_RECORD_RE, "").replace(/^[\s:;,-]+/, "");
  return recordNo ? `${recordNo}: ${rest}` : rest;
}

export default function QaqcRecordPicker({ projectId, note, onNote }: {
  projectId: number;
  note: string;
  onNote: (note: string) => void;
}) {
  const [records, setRecords] = useState<OpenRecord[] | null>(null);
  useEffect(() => {
    if (!projectId) return;
    apiGet<OpenRecord[]>(`/qaqc/open-records?project_id=${projectId}`).then(setRecords).catch(() => setRecords([]));
  }, [projectId]);
  const current = (note.match(QAQC_RECORD_RE)?.[0] || "").toUpperCase();
  return (
    <label style={{ display: "block", fontSize: 12, color: "var(--aq-muted)", marginBottom: 8 }}>
      QA/QC record this time is for
      <select
        value={current}
        onChange={(e) => onNote(withRecord(note, e.target.value))}
        style={{ display: "block", width: "100%", marginTop: 4 }}
      >
        <option value="">Select QA/QC record</option>
        {(records || []).map((r) => (
          <option key={r.id} value={r.record_no}>{r.record_no} · {r.title}</option>
        ))}
        {current && records && !records.some((r) => r.record_no === current) ? <option value={current}>{current}</option> : null}
      </select>
      {records && records.length === 0 ? (
        <span style={{ display: "block", marginTop: 4, color: "#8b5a1d" }}>
          No open QA/QC record on this project. Open one under QA/QC first, then charge the time to it.
        </span>
      ) : null}
    </label>
  );
}
