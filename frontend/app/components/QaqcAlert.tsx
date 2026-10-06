"use client";

// QA/QC to-do banner on the Time page (owner 2026-10-05: "an in-app alert they will see
// whenever they enter the time app"). Shows what is waiting on the signed-in person:
// findings to fix, fixes awaiting their back-check, reviews they can close. It comes
// back every time the Time page opens until the items are dealt with; "Hide for now"
// only hides it until the next visit. Email is off in prod, so this is the live path.

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { openQaqcRecord } from "./QaqcRecordPicker";

type FindingAction = { review_id: number; record_no: string; seq: number; severity: string; description: string; status: string };
type CloseAction = { review_id: number; record_no: string; title: string };
type MyActions = { to_fix: FindingAction[]; to_backcheck: FindingAction[]; to_close: CloseAction[]; to_complete?: CloseAction[] };

const SEV: Record<string, string> = { major: "Major", minor: "Minor", observation: "Observation" };
const quiet: React.CSSProperties = { background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.5)", boxShadow: "none" };
const openBtn: React.CSSProperties = { padding: "2px 10px", fontSize: 12, whiteSpace: "nowrap" };

export function QaqcAlert() {
  const [a, setA] = useState<MyActions | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    apiGet<MyActions>("/qaqc/my-actions").then(setA).catch(() => setA(null));
  }, []);
  if (hidden || !a) return null;
  const toComplete = a.to_complete || [];
  const total = a.to_fix.length + a.to_backcheck.length + a.to_close.length + toComplete.length;
  if (!total) return null;

  const line = (key: string, text: string, reviewId: number) => (
    <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 13 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <button type="button" style={openBtn} onClick={() => openQaqcRecord(reviewId)}>Open</button>
    </div>
  );

  return (
    <div role="alert" className="aq-lite-panel"
      style={{ borderLeft: "4px solid #b8860b", background: "rgba(184,134,11,0.10)", marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>QA/QC: {total} item{total === 1 ? "" : "s"} waiting on you</strong>
          {a.to_fix.length ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, color: "var(--aq-muted)" }}>Findings to fix and record (assigned to you)</div>
              {a.to_fix.map((f) => line(`fix-${f.review_id}-${f.seq}`,
                `${f.record_no} finding ${f.seq} (${SEV[f.severity] || f.severity}${f.status === "returned" ? ", returned to you" : ""}): ${f.description}`,
                f.review_id))}
            </div>
          ) : null}
          {a.to_backcheck.length ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, color: "var(--aq-muted)" }}>Fixes waiting for your back-check</div>
              {a.to_backcheck.map((f) => line(`bc-${f.review_id}-${f.seq}`,
                `${f.record_no} finding ${f.seq}: ${f.description}`, f.review_id))}
            </div>
          ) : null}
          {toComplete.length ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, color: "var(--aq-muted)" }}>Records to complete (made from your earlier timesheet notes)</div>
              {toComplete.map((r) => line(`tc-${r.review_id}`, `${r.record_no}: ${r.title}`, r.review_id))}
            </div>
          ) : null}
          {a.to_close.length ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12, color: "var(--aq-muted)" }}>Reviews ready for you to close</div>
              {a.to_close.map((r) => line(`close-${r.review_id}`, `${r.record_no}: ${r.title}`, r.review_id))}
            </div>
          ) : null}
        </div>
        <button type="button" style={{ ...quiet, flexShrink: 0 }} onClick={() => setHidden(true)}>Hide for now</button>
      </div>
    </div>
  );
}
