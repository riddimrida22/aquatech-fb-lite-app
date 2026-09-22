"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

type Check = { key: string; group: string; label: string; status: "ok" | "warn" | "fail"; detail: string; value: unknown };
type Run = { id: number; run_at: string | null; trigger: string; status: "ok" | "warn" | "fail"; summary: string; checks?: Check[] };
type HealthResp = { latest: Run | null; history: Run[] };

const GREEN = "#1f7a4d";
const GOLD = "#b8860b";
const RED = "#b42318";
const STATUS_COLOR: Record<string, string> = { ok: GREEN, warn: GOLD, fail: RED };
const STATUS_LABEL: Record<string, string> = { ok: "Pass", warn: "Attention", fail: "Fail" };

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Chip({ status }: { status: string }) {
  const c = STATUS_COLOR[status] || GOLD;
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 700,
                   color: c, border: `1px solid ${c}`, background: "transparent", whiteSpace: "nowrap" }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

/** Full Data Health screen: latest audit, per-check results, run-now, recent history. */
export default function DataHealthPanel() {
  const [data, setData] = useState<HealthResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    apiGet<HealthResp>("/admin/data-health")
      .then((r) => { setData(r); setErr(null); })
      .catch((e) => setErr(e?.message || "Could not load data health"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const runNow = () => {
    setRunning(true);
    apiPost<Run>("/admin/data-health/run", {})
      .then(() => load())
      .catch((e) => setErr(e?.message || "Audit failed to run"))
      .finally(() => setRunning(false));
  };

  const latest = data?.latest;
  const checks = latest?.checks ?? [];
  const groups = Array.from(new Set(checks.map((c) => c.group)));

  return (
    <section className="aq-lite-panel" style={{ borderLeft: `3px solid ${STATUS_COLOR[latest?.status || "warn"]}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Data health · nightly audit</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>
            {latest ? latest.summary : "No audit has run yet"}
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 680 }}>
            Every night at 6:45 AM (after the bank sync and cost refresh) the app checks that its data is fresh and
            that numbers computed in different places agree. Last run {when(latest?.run_at ?? null)}
            {latest ? ` (${latest.trigger})` : ""}.
          </p>
        </div>
        <button type="button" onClick={runNow} disabled={running}>
          {running ? "Running…" : "Run audit now"}
        </button>
      </div>

      {err ? <p style={{ color: RED, marginTop: 12 }}>{err}</p> : null}

      {groups.map((g) => (
        <div key={g} style={{ marginTop: 14, overflowX: "auto" }}>
          <p className="aq-lite-eyebrow" style={{ margin: "0 0 6px" }}>{g}</p>
          <table className="aq-lite-table" style={{ width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", width: 230 }}>Check</th>
                <th style={{ textAlign: "left", width: 100 }}>Status</th>
                <th style={{ textAlign: "left" }}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {checks.filter((c) => c.group === g).map((c) => (
                <tr key={c.key}>
                  <td style={{ fontWeight: 600 }}>{c.label}</td>
                  <td><Chip status={c.status} /></td>
                  <td style={{ color: c.status === "ok" ? "var(--aq-muted)" : "inherit" }}>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {data && data.history.length > 1 ? (
        <div style={{ marginTop: 16 }}>
          <p className="aq-lite-eyebrow" style={{ margin: "0 0 6px" }}>Recent runs</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {data.history.map((r) => (
              <span key={r.id} title={`${when(r.run_at)} · ${r.summary}`}
                    style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 6,
                             border: `1px solid ${STATUS_COLOR[r.status]}`, color: STATUS_COLOR[r.status] }}>
                {when(r.run_at)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Compact dashboard banner: only renders when the latest audit needs attention. */
export function DataHealthBanner({ onOpen }: { onOpen: () => void }) {
  const [latest, setLatest] = useState<Run | null>(null);
  useEffect(() => {
    apiGet<HealthResp>("/admin/data-health?history=1").then((r) => setLatest(r.latest)).catch(() => setLatest(null));
  }, []);
  if (!latest || latest.status === "ok") return null;
  const c = STATUS_COLOR[latest.status];
  const issues = (latest.checks ?? []).filter((x) => x.status !== "ok").map((x) => x.label);
  return (
    <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
                                border: `1px solid ${c}`, borderLeft: `4px solid ${c}`, borderRadius: 8, padding: "10px 14px", margin: "0 0 14px" }}>
      <span style={{ fontSize: 13.5 }}>
        <strong style={{ color: c }}>Data health: {latest.summary}.</strong>{" "}
        <span className="aq-lite-muted">{issues.join(" · ")}</span>
      </span>
      <button type="button" onClick={onOpen}>Review</button>
    </div>
  );
}
