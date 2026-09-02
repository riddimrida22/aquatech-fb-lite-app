"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut } from "../../../lib/api";

type Profile = {
  linked: boolean; id?: number; legal_name?: string; work_state?: string; nyc_resident?: boolean;
  pay_rate?: number; k401_deferral_pct?: number; k401_is_roth?: boolean; k401_er_match_pct?: number;
  fed_filing_status?: string; fed_multiple_jobs?: boolean; fed_dependents_amt?: number;
  fed_extra_withholding?: number; state_allowances?: number;
};

export default function MyTaxProfilePage() {
  const [p, setP] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Profile>("/payroll/me/tax-profile").then(setP).catch((e) => setErr(String(e.message || e)));
  }, []);

  function set<K extends keyof Profile>(k: K, v: Profile[K]) {
    setP((cur) => (cur ? { ...cur, [k]: v } : cur));
  }

  async function save() {
    if (!p) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await apiPut("/payroll/me/tax-profile", {
        k401_deferral_pct: Number(p.k401_deferral_pct) || 0,
        k401_is_roth: !!p.k401_is_roth,
        fed_filing_status: p.fed_filing_status || "single",
        fed_multiple_jobs: !!p.fed_multiple_jobs,
        fed_dependents_amt: Number(p.fed_dependents_amt) || 0,
        fed_extra_withholding: Number(p.fed_extra_withholding) || 0,
        state_allowances: Number(p.state_allowances) || 0,
      });
      setMsg("Saved. Changes apply to your next paycheck.");
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  }

  const card: React.CSSProperties = { border: "1px solid rgba(0,0,0,0.12)", borderRadius: 10, padding: 18, marginBottom: 16, maxWidth: 620, background: "var(--aq-card-bg,#fff)" };
  const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", gap: 12, borderBottom: "1px solid #f2f2f2" };
  const lbl: React.CSSProperties = { fontSize: 13 };
  const hint: React.CSSProperties = { fontSize: 11, color: "#888" };

  if (err && !p) return <div style={{ padding: 24 }}><div style={{ ...card, background: "#ffebee" }}>{err}</div></div>;
  if (!p) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!p.linked)
    return (
      <div style={{ padding: 24 }}>
        <h1>My Pay Settings</h1>
        <div style={{ ...card, background: "#fff8e1" }}>Your payroll record isn’t linked to your account yet. Ask the owner to link you, then refresh.</div>
      </div>
    );

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: 24, fontSize: 14 }}>
      <h1 style={{ marginBottom: 2 }}>My Pay Settings</h1>
      <p style={{ color: "#666", marginTop: 0 }}>{p.legal_name} · {p.work_state}{p.nyc_resident ? " (NYC)" : ""} · rate ${p.pay_rate?.toFixed(2)}/hr</p>
      {msg && <div style={{ ...card, background: "#e8f5e9", borderColor: "#a5d6a7" }}>{msg}</div>}
      {err && <div style={{ ...card, background: "#ffebee", borderColor: "#ef9a9a" }}>{err}</div>}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>401(k) contribution</h3>
        <div style={row}>
          <div><div style={lbl}>Deferral (% of gross pay)</div><div style={hint}>Employer match: {p.k401_er_match_pct}% of pay</div></div>
          <div><input type="number" min={0} max={90} step={1} value={p.k401_deferral_pct ?? 0} onChange={(e) => set("k401_deferral_pct", Number(e.target.value))} style={{ width: 80, textAlign: "right" }} /> %</div>
        </div>
        <div style={row}>
          <div><div style={lbl}>Contribution type</div><div style={hint}>Traditional (pre-tax) or Roth (after-tax)</div></div>
          <label><input type="checkbox" checked={!!p.k401_is_roth} onChange={(e) => set("k401_is_roth", e.target.checked)} /> Roth</label>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Federal W-4</h3>
        <div style={row}>
          <div style={lbl}>Filing status</div>
          <select value={p.fed_filing_status} onChange={(e) => set("fed_filing_status", e.target.value)}>
            <option value="single">Single or Married filing separately</option>
            <option value="mfj">Married filing jointly</option>
            <option value="hoh">Head of household</option>
          </select>
        </div>
        <div style={row}>
          <div><div style={lbl}>Multiple jobs / spouse works</div><div style={hint}>W-4 Step 2 checkbox</div></div>
          <label><input type="checkbox" checked={!!p.fed_multiple_jobs} onChange={(e) => set("fed_multiple_jobs", e.target.checked)} /> Yes</label>
        </div>
        <div style={row}>
          <div><div style={lbl}>Dependents credit ($/yr)</div><div style={hint}>W-4 Step 3</div></div>
          <input type="number" min={0} step={500} value={p.fed_dependents_amt ?? 0} onChange={(e) => set("fed_dependents_amt", Number(e.target.value))} style={{ width: 110, textAlign: "right" }} />
        </div>
        <div style={row}>
          <div><div style={lbl}>Extra withholding ($/paycheck)</div><div style={hint}>W-4 Step 4(c)</div></div>
          <input type="number" min={0} step={5} value={p.fed_extra_withholding ?? 0} onChange={(e) => set("fed_extra_withholding", Number(e.target.value))} style={{ width: 110, textAlign: "right" }} />
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>State ({p.work_state})</h3>
        <div style={row}>
          <div><div style={lbl}>Withholding allowances</div><div style={hint}>{p.work_state === "NJ" ? "NJ-W4" : "IT-2104"} allowances</div></div>
          <input type="number" min={0} step={1} value={p.state_allowances ?? 0} onChange={(e) => set("state_allowances", Number(e.target.value))} style={{ width: 80, textAlign: "right" }} />
        </div>
      </div>

      <button disabled={busy} onClick={save} style={{ padding: "8px 18px", fontSize: 15 }}>{busy ? "Saving…" : "Save my settings"}</button>
    </div>
  );
}
