"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

type Employee = {
  id: number; legal_name: string; pay_rate: number; work_state: string;
  nyc_resident: boolean; k401_deferral_pct: number; k401_er_match_pct: number;
};
type PreviewEmp = {
  employee_id: number; name: string; gross: number; pretax_401k: number;
  taxes: Record<string, number>; employer: Record<string, number>; net: number | null;
};
type Preview = {
  employees: PreviewEmp[];
  totals: { gross: number; ee_withholdings: number; k401_ee: number; k401_er: number; employer_taxes: number; net: number };
  journal: { account: string; debit: number; credit: number }[];
  journal_balanced: boolean;
};
type RunRow = { id: number; period_start: string; period_end: string; check_date: string; status: string; net: number | null };

const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const TAX_LABEL: Record<string, string> = {
  fed: "Federal", ss: "Soc Sec", medicare: "Medicare", ny_inc: "NY", nyc: "NYC",
  ny_sdi: "NY SDI", ny_pfl: "NY PFL", nj_inc: "NJ", nj_sdi: "NJ SDI", nj_ui: "NJ UI", nj_wf: "NJ WF",
};

export default function PayrollPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [hours, setHours] = useState<Record<number, string>>({});
  const [periodStart, setPeriodStart] = useState("2026-08-03");
  const [periodEnd, setPeriodEnd] = useState("2026-08-16");
  const [checkDate, setCheckDate] = useState("2026-08-21");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const [emps, rr] = await Promise.all([
        apiGet<Employee[]>("/payroll/employees"),
        apiGet<RunRow[]>("/payroll/runs"),
      ]);
      setEmployees(emps); setRuns(rr);
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { refresh(); }, []);

  const entries = useMemo(
    () => employees.map((e) => ({ employee_id: e.id, hours: parseFloat(hours[e.id] || "0") || 0 })),
    [employees, hours],
  );
  const body = () => ({ period_start: periodStart, period_end: periodEnd, check_date: checkDate, weeks: 2, entries });

  async function guard(fn: () => Promise<void>) {
    setBusy(true); setErr(null); setMsg(null);
    try { await fn(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  }
  const doSeed = () => guard(async () => { const r = await apiPost<any>("/payroll/employees/seed-sample", {}); setMsg(`Seeded ${r.created} employees.`); await refresh(); });
  const doPreview = () => guard(async () => { setPreview(await apiPost<Preview>("/payroll/preview", body())); setDetail(null); });
  const doCreate = () => guard(async () => { const r = await apiPost<any>("/payroll/runs", body()); setMsg(`Run #${r.id} created (draft).`); setPreview(null); await refresh(); });
  const openRun = (id: number) => guard(async () => { setDetail(await apiGet<any>(`/payroll/runs/${id}`)); setPreview(null); });
  const doApprove = (id: number) => guard(async () => { await apiPost<any>(`/payroll/runs/${id}/approve`, {}); setMsg(`Run #${id} approved.`); await openRun(id); await refresh(); });
  const doPay = (id: number) => guard(async () => { await apiPost<any>(`/payroll/runs/${id}/pay`, {}); setMsg(`Run #${id} paid — journal posted.`); await openRun(id); await refresh(); });

  const card: React.CSSProperties = { border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 16, marginBottom: 18, background: "var(--aq-card-bg, #fff)" };
  const th: React.CSSProperties = { textAlign: "right", padding: "4px 8px", fontSize: 12, color: "#555", borderBottom: "1px solid #eee" };
  const td: React.CSSProperties = { textAlign: "right", padding: "4px 8px", fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: 20, fontSize: 14 }}>
      <h1 style={{ marginBottom: 4 }}>Payroll</h1>
      <p style={{ color: "#666", marginTop: 0 }}>In-house payroll — preview, approve (dual-control), pay, and pay stubs. Owner-only.</p>
      {msg && <div style={{ ...card, background: "#e8f5e9", borderColor: "#a5d6a7" }}>{msg}</div>}
      {err && <div style={{ ...card, background: "#ffebee", borderColor: "#ef9a9a", whiteSpace: "pre-wrap" }}>{err}</div>}

      {employees.length === 0 && (
        <div style={card}>
          <b>No employees yet.</b>{" "}
          <button disabled={busy} onClick={doSeed}>Seed sample roster (6)</button>
          <div style={{ color: "#777", fontSize: 12, marginTop: 6 }}>Loads names/rates/W-4; SSN &amp; bank added later via onboarding.</div>
        </div>
      )}

      {employees.length > 0 && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>New run</h3>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <label>Period start <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label>
            <label>Period end <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
            <label>Check date <input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} /></label>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>Employee</th><th style={th}>Rate</th><th style={th}>State</th><th style={th}>Hours</th></tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...td, textAlign: "left" }}>{e.legal_name}</td>
                  <td style={td}>{money(e.pay_rate)}</td>
                  <td style={td}>{e.work_state}{e.nyc_resident ? " (NYC)" : ""}</td>
                  <td style={td}><input style={{ width: 70, textAlign: "right" }} value={hours[e.id] || ""} onChange={(ev) => setHours({ ...hours, [e.id]: ev.target.value })} placeholder="0" /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={doPreview}>Preview</button>
            <button disabled={busy || !preview} onClick={doCreate}>Create run (draft)</button>
          </div>
        </div>
      )}

      {preview && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Preview</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left" }}>Employee</th><th style={th}>Gross</th>
              <th style={th}>Fed</th><th style={th}>State</th><th style={th}>FICA</th><th style={th}>401k</th><th style={th}>Net</th>
            </tr></thead>
            <tbody>
              {preview.employees.map((p) => {
                const state = (p.taxes.ny_inc || 0) + (p.taxes.nyc || 0) + (p.taxes.nj_inc || 0);
                const fica = (p.taxes.ss || 0) + (p.taxes.medicare || 0);
                return (
                  <tr key={p.employee_id}>
                    <td style={{ ...td, textAlign: "left" }}>{p.name}</td>
                    <td style={td}>{money(p.gross)}</td><td style={td}>{money(p.taxes.fed)}</td>
                    <td style={td}>{money(state)}</td><td style={td}>{money(fica)}</td>
                    <td style={td}>{money(p.pretax_401k)}</td><td style={{ ...td, fontWeight: 600 }}>{money(p.net)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr style={{ borderTop: "2px solid #ccc" }}>
              <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>Totals</td>
              <td style={{ ...td, fontWeight: 600 }}>{money(preview.totals.gross)}</td>
              <td colSpan={3} style={{ ...td, color: "#666" }}>EE tax {money(preview.totals.ee_withholdings)} · ER tax {money(preview.totals.employer_taxes)}</td>
              <td style={td}>{money(preview.totals.k401_ee)}</td>
              <td style={{ ...td, fontWeight: 700 }}>{money(preview.totals.net)}</td>
            </tr></tfoot>
          </table>
          <div style={{ marginTop: 12 }}>
            <b>Finance journal</b>{" "}
            <span style={{ padding: "2px 8px", borderRadius: 10, background: preview.journal_balanced ? "#e8f5e9" : "#ffebee" }}>
              {preview.journal_balanced ? "balanced ✓" : "NOT balanced"}
            </span>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
              <tbody>
                {preview.journal.map((j, i) => (
                  <tr key={i}>
                    <td style={{ ...td, textAlign: "left" }}>{j.account}</td>
                    <td style={td}>{j.debit ? money(j.debit) : ""}</td>
                    <td style={td}>{j.credit ? money(j.credit) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Runs</h3>
        {runs.length === 0 && <div style={{ color: "#777" }}>No runs yet.</div>}
        {runs.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f0f0f0" }}>
            <span style={{ width: 40 }}>#{r.id}</span>
            <span style={{ flex: 1 }}>{r.period_start} → {r.period_end} · check {r.check_date}</span>
            <span style={{ padding: "2px 8px", borderRadius: 10, background: r.status === "paid" ? "#e8f5e9" : r.status === "approved" ? "#fff8e1" : "#eee" }}>{r.status}</span>
            <span style={{ width: 100, textAlign: "right" }}>{money(r.net)}</span>
            <button disabled={busy} onClick={() => openRun(r.id)}>Open</button>
          </div>
        ))}
      </div>

      {detail && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Run #{detail.id} — {detail.status}</h3>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {detail.status === "draft" && <button disabled={busy} onClick={() => doApprove(detail.id)}>Approve</button>}
            {detail.status === "approved" && <button disabled={busy} onClick={() => doPay(detail.id)}>Pay (post journal)</button>}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>Employee</th><th style={th}>Gross</th><th style={th}>401k</th><th style={th}>Net</th><th style={th}>Stub</th></tr></thead>
            <tbody>
              {detail.lines.map((l: any) => (
                <tr key={l.employee_id}>
                  <td style={{ ...td, textAlign: "left" }}>{l.name}</td>
                  <td style={td}>{money(l.gross)}</td><td style={td}>{money(l.pretax_401k)}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{money(l.net)}</td>
                  <td style={td}><a href={`/api/payroll/runs/${detail.id}/stub/${l.employee_id}`} target="_blank" rel="noreferrer">PDF</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
