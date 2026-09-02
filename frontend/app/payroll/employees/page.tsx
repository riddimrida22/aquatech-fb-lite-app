"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut } from "../../../lib/api";
import PayrollNav from "../PayrollNav";

type Emp = {
  id: number; legal_name: string; pay_rate: number; is_salary?: boolean;
  work_state: string; nyc_resident: boolean;
  k401_deferral_pct: number; k401_is_roth?: boolean; k401_er_match_pct: number;
  fed_filing_status: string; fed_multiple_jobs?: boolean; fed_dependents_amt?: number;
  fed_extra_withholding?: number; state_allowances: number;
  ny_marital?: string; nyc_marital?: string | null; nyc_allowances?: number | null;
  nj_rate_table?: string; is_active?: boolean; ssn_last4?: string | null; linked?: boolean;
};

export default function EditEmployeesPage() {
  const [list, setList] = useState<Emp[]>([]);
  const [emp, setEmp] = useState<Emp | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadList = () => apiGet<Emp[]>("/payroll/employees").then(setList).catch((e) => setErr(String(e.message || e)));
  useEffect(() => { loadList(); }, []);
  const open = (id: number) => { setMsg(null); setErr(null); apiGet<Emp>(`/payroll/employees/${id}`).then(setEmp).catch((e) => setErr(String(e.message || e))); };
  function set<K extends keyof Emp>(k: K, v: Emp[K]) { setEmp((c) => (c ? { ...c, [k]: v } : c)); }

  async function save() {
    if (!emp) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await apiPut(`/payroll/employees/${emp.id}`, {
        legal_name: emp.legal_name, pay_rate: Number(emp.pay_rate) || 0, is_salary: !!emp.is_salary,
        work_state: emp.work_state, nyc_resident: !!emp.nyc_resident,
        k401_deferral_pct: Number(emp.k401_deferral_pct) || 0, k401_is_roth: !!emp.k401_is_roth,
        k401_er_match_pct: Number(emp.k401_er_match_pct) || 0,
        fed_filing_status: emp.fed_filing_status, fed_multiple_jobs: !!emp.fed_multiple_jobs,
        fed_dependents_amt: Number(emp.fed_dependents_amt) || 0, fed_extra_withholding: Number(emp.fed_extra_withholding) || 0,
        state_allowances: Number(emp.state_allowances) || 0, ny_marital: emp.ny_marital || "single",
        nyc_marital: emp.nyc_marital || null, nyc_allowances: emp.nyc_allowances ?? null,
        nj_rate_table: emp.nj_rate_table || "A", is_active: emp.is_active !== false,
      });
      setMsg(`Saved ${emp.legal_name}.`); await loadList();
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 16, marginBottom: 16, background: "var(--aq-card-bg,#fff)" };
  const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", gap: 12, borderBottom: "1px solid #f2f2f2" };
  const lbl: React.CSSProperties = { fontSize: 13 };
  const hint: React.CSSProperties = { fontSize: 11, color: "#888" };
  const inp: React.CSSProperties = { width: 120, textAlign: "right" };

  return (
    <>
    <PayrollNav active="employees" />
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 22, fontSize: 14 }}>
      <h1 style={{ marginBottom: 2 }}>Employees — Tax Setup (owner)</h1>
      <p style={{ color: "#666", marginTop: 0 }}>Edit any employee's pay rate, W-4, state allowances, and 401(k). Changes apply to their next run.</p>
      {msg && <div style={{ ...card, background: "#e8f5e9", borderColor: "#a5d6a7" }}>{msg}</div>}
      {err && <div style={{ ...card, background: "#ffebee", borderColor: "#ef9a9a" }}>{err}</div>}

      <div style={card}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={{ textAlign: "left", padding: "4px 8px", fontSize: 12, color: "#555" }}>Employee</th><th style={{ textAlign: "right", padding: "4px 8px", fontSize: 12, color: "#555" }}>Rate</th><th style={{ textAlign: "right", padding: "4px 8px", fontSize: 12, color: "#555" }}>State</th><th style={{ textAlign: "right", padding: "4px 8px", fontSize: 12, color: "#555" }}>SSN</th><th></th></tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} style={{ borderBottom: "1px solid #f2f2f2" }}>
                <td style={{ padding: "5px 8px" }}>{e.legal_name}</td>
                <td style={{ padding: "5px 8px", textAlign: "right" }}>${e.pay_rate?.toFixed(2)}</td>
                <td style={{ padding: "5px 8px", textAlign: "right" }}>{e.work_state}{e.nyc_resident ? " (NYC)" : ""}</td>
                <td style={{ padding: "5px 8px", textAlign: "right" }}>{e.ssn_last4 ? `••${e.ssn_last4}` : "—"}</td>
                <td style={{ padding: "5px 8px", textAlign: "right" }}><button onClick={() => open(e.id)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {emp && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Editing: {emp.legal_name}</h3>

          <div style={row}><div style={lbl}>Legal name (as on W-2)</div><input style={{ width: 240 }} value={emp.legal_name} onChange={(e) => set("legal_name", e.target.value)} /></div>
          <div style={row}><div style={lbl}>Pay rate ($/hr)</div><input type="number" step={0.01} style={inp} value={emp.pay_rate} onChange={(e) => set("pay_rate", Number(e.target.value))} /></div>
          <div style={row}><div style={lbl}>Work state</div>
            <select value={emp.work_state} onChange={(e) => set("work_state", e.target.value)}><option value="NY">NY</option><option value="NJ">NJ</option></select></div>
          <div style={row}><div><div style={lbl}>NYC resident</div><div style={hint}>Withholds NYC resident tax</div></div><input type="checkbox" checked={!!emp.nyc_resident} onChange={(e) => set("nyc_resident", e.target.checked)} /></div>

          <h4 style={{ marginBottom: 4 }}>Federal W-4</h4>
          <div style={row}><div style={lbl}>Filing status</div>
            <select value={emp.fed_filing_status} onChange={(e) => set("fed_filing_status", e.target.value)}>
              <option value="single">Single / MFS</option><option value="mfj">Married filing jointly</option><option value="hoh">Head of household</option></select></div>
          <div style={row}><div><div style={lbl}>Multiple jobs</div><div style={hint}>W-4 Step 2 box</div></div><input type="checkbox" checked={!!emp.fed_multiple_jobs} onChange={(e) => set("fed_multiple_jobs", e.target.checked)} /></div>
          <div style={row}><div><div style={lbl}>Dependents credit ($/yr)</div><div style={hint}>Step 3</div></div><input type="number" step={500} style={inp} value={emp.fed_dependents_amt ?? 0} onChange={(e) => set("fed_dependents_amt", Number(e.target.value))} /></div>
          <div style={row}><div><div style={lbl}>Extra withholding ($/check)</div><div style={hint}>Step 4(c)</div></div><input type="number" step={5} style={inp} value={emp.fed_extra_withholding ?? 0} onChange={(e) => set("fed_extra_withholding", Number(e.target.value))} /></div>

          <h4 style={{ marginBottom: 4 }}>State ({emp.work_state})</h4>
          {emp.work_state === "NY" ? (
            <>
              <div style={row}><div style={lbl}>NY marital (IT-2104)</div>
                <select value={emp.ny_marital || "single"} onChange={(e) => set("ny_marital", e.target.value)}><option value="single">Single</option><option value="married">Married</option></select></div>
              <div style={row}><div style={lbl}>NY allowances</div><input type="number" style={inp} value={emp.state_allowances} onChange={(e) => set("state_allowances", Number(e.target.value))} /></div>
              {emp.nyc_resident && <>
                <div style={row}><div><div style={lbl}>NYC marital</div><div style={hint}>IT-2104 can differ from NY State</div></div>
                  <select value={emp.nyc_marital || emp.ny_marital || "single"} onChange={(e) => set("nyc_marital", e.target.value)}><option value="single">Single</option><option value="married">Married</option></select></div>
                <div style={row}><div style={lbl}>NYC allowances</div><input type="number" style={inp} value={emp.nyc_allowances ?? emp.state_allowances} onChange={(e) => set("nyc_allowances", Number(e.target.value))} /></div>
              </>}
            </>
          ) : (
            <>
              <div style={row}><div style={lbl}>NJ allowances</div><input type="number" style={inp} value={emp.state_allowances} onChange={(e) => set("state_allowances", Number(e.target.value))} /></div>
              <div style={row}><div><div style={lbl}>NJ-W4 rate table</div><div style={hint}>Wage-chart letter (engine computes Rate A today)</div></div>
                <select value={emp.nj_rate_table || "A"} onChange={(e) => set("nj_rate_table", e.target.value)}>{["A","B","C","D","E"].map((x)=><option key={x} value={x}>{x}</option>)}</select></div>
            </>
          )}

          <h4 style={{ marginBottom: 4 }}>401(k)</h4>
          <div style={row}><div style={lbl}>Deferral (% gross)</div><input type="number" style={inp} value={emp.k401_deferral_pct} onChange={(e) => set("k401_deferral_pct", Number(e.target.value))} /></div>
          <div style={row}><div style={lbl}>Roth</div><input type="checkbox" checked={!!emp.k401_is_roth} onChange={(e) => set("k401_is_roth", e.target.checked)} /></div>
          <div style={row}><div style={lbl}>Employer match (% gross)</div><input type="number" style={inp} value={emp.k401_er_match_pct} onChange={(e) => set("k401_er_match_pct", Number(e.target.value))} /></div>

          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button disabled={busy} onClick={save} style={{ padding: "8px 18px", fontSize: 15 }}>{busy ? "Saving…" : "Save"}</button>
            <button disabled={busy} onClick={() => setEmp(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
