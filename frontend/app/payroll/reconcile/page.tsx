"use client";

import { useState } from "react";

type EmpRow = {
  name: string; matched: boolean; skipped?: boolean;
  gross?: number; paychex_net?: number | null; engine_net?: number | null;
  net_delta?: number | null; ok?: boolean;
};
type CompRow = { line: string; paychex: number | null; engine: number; delta: number; ok: boolean };
type Report = {
  period: { period_start?: string; period_end?: string; check_date?: string };
  employees: EmpRow[]; company_diffs: CompRow[];
  net_engine_total: number; net_paychex_total: number | null; net_delta_total: number | null;
  discrepancies: number; verdict: string;
};

const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const TAX_LABEL: Record<string, string> = {
  fed: "Federal", ss: "Social Security", medicare: "Medicare", ny_inc: "NY State",
  nyc: "NYC", ny_sdi: "NY SDI", ny_pfl: "NY PFL", nj_inc: "NJ State", nj_sdi: "NJ SDI",
  nj_ui: "NJ UI", nj_wf: "NJ WF",
};

export default function ReconcilePage() {
  const [file, setFile] = useState<File | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!file) return;
    setBusy(true); setErr(null); setRep(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/payroll/reconcile", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      setRep(await res.json());
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 18, marginBottom: 16, background: "var(--aq-card-bg,#fff)" };
  const th: React.CSSProperties = { textAlign: "right", padding: "5px 8px", fontSize: 12, color: "#555", borderBottom: "1px solid #eee" };
  const td: React.CSSProperties = { textAlign: "right", padding: "5px 8px", fontVariantNumeric: "tabular-nums" };
  const clean = rep && rep.discrepancies === 0;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 22, fontSize: 14 }}>
      <h1 style={{ marginBottom: 2 }}>Parallel-Run Reconciliation</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Upload the Paychex export (the <b>reports .zip</b>, or the <code>PYRJRN.pdf</code>) for a pay period.
        We recompute it with our engine and diff every line — so you can prove a clean cycle before cutover.
      </p>

      <div style={card}>
        <input type="file" accept=".zip,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button disabled={!file || busy} onClick={run} style={{ marginLeft: 10, padding: "6px 16px" }}>
          {busy ? "Reconciling…" : "Reconcile"}
        </button>
        {file && <span style={{ marginLeft: 10, color: "#777", fontSize: 12 }}>{file.name}</span>}
      </div>

      {err && <div style={{ ...card, background: "#ffebee", borderColor: "#ef9a9a", whiteSpace: "pre-wrap" }}>{err}</div>}

      {rep && (
        <>
          <div style={{ ...card, background: clean ? "#e8f5e9" : "#fff8e1", borderColor: clean ? "#a5d6a7" : "#ffe082" }}>
            <b style={{ fontSize: 16 }}>{clean ? "✅ MATCH" : `⚠️ ${rep.discrepancies} line(s) to review`}</b>
            <span style={{ marginLeft: 12, color: "#555" }}>
              Period {rep.period.period_start} → {rep.period.period_end} · check {rep.period.check_date}
            </span>
            <div style={{ marginTop: 6 }}>
              Net total — engine {money(rep.net_engine_total)} vs Paychex {money(rep.net_paychex_total)}
              {rep.net_delta_total != null && <b> (Δ {money(rep.net_delta_total)})</b>}
            </div>
          </div>

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Per-employee net pay</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={{ ...th, textAlign: "left" }}>Employee</th><th style={th}>Gross</th>
                <th style={th}>Paychex net</th><th style={th}>Engine net</th><th style={th}>Δ</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {rep.employees.map((e, i) => (
                  <tr key={i} style={{ background: e.skipped ? "#fafafa" : e.ok ? "transparent" : "#fff3f3" }}>
                    <td style={{ ...td, textAlign: "left" }}>{e.name}</td>
                    <td style={td}>{money(e.gross)}</td>
                    <td style={td}>{money(e.paychex_net)}</td>
                    <td style={td}>{money(e.engine_net)}</td>
                    <td style={{ ...td, fontWeight: 600, color: e.ok ? "#2e7d32" : "#c62828" }}>{e.net_delta == null ? "—" : money(e.net_delta)}</td>
                    <td style={td}>{e.skipped ? "skipped" : e.ok ? "✓ OK" : "DIFF"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Company tax totals</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={{ ...th, textAlign: "left" }}>Line</th><th style={th}>Paychex</th>
                <th style={th}>Engine</th><th style={th}>Δ</th><th style={th}>Status</th>
              </tr></thead>
              <tbody>
                {rep.company_diffs.map((c, i) => (
                  <tr key={i} style={{ background: c.ok ? "transparent" : "#fff3f3" }}>
                    <td style={{ ...td, textAlign: "left" }}>{TAX_LABEL[c.line] || c.line}</td>
                    <td style={td}>{money(c.paychex)}</td>
                    <td style={td}>{money(c.engine)}</td>
                    <td style={{ ...td, fontWeight: 600, color: c.ok ? "#2e7d32" : "#c62828" }}>{money(c.delta)}</td>
                    <td style={td}>{c.ok ? "✓ OK" : "DIFF"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
