"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../../lib/api";
import PayrollNav from "../PayrollNav";

type Emp = { id: number; legal_name: string; work_state: string; nyc_resident: boolean };
type YtdRow = { employee_id: number; ytd_gross: number; ytd_ss_wages: number | null };
type Draft = { gross: string; ss: string };

const card: React.CSSProperties = { border: "1px solid #e5e5e5", borderRadius: 10, padding: 16, marginBottom: 14, background: "#fff" };
const th: React.CSSProperties = { padding: "6px 8px", borderBottom: "2px solid #ddd", textAlign: "right", fontSize: 12, color: "#555" };
const td: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #f0f0f0", textAlign: "right" };
const inp: React.CSSProperties = { width: 120, textAlign: "right", padding: "4px 6px" };

const TAX_YEAR = 2026;

export default function YtdSeedPage() {
  const [emps, setEmps] = useState<Emp[] | null>(null);
  const [draft, setDraft] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const [e, y] = await Promise.all([
        apiGet<Emp[]>("/payroll/employees"),
        apiGet<YtdRow[]>(`/payroll/ytd?tax_year=${TAX_YEAR}`),
      ]);
      const byId: Record<number, YtdRow> = {};
      for (const r of y) byId[r.employee_id] = r;
      const d: Record<number, Draft> = {};
      for (const emp of e) {
        const r = byId[emp.id];
        d[emp.id] = {
          gross: r && r.ytd_gross ? String(r.ytd_gross) : "",
          ss: r && r.ytd_ss_wages != null && r.ytd_ss_wages !== r.ytd_gross ? String(r.ytd_ss_wages) : "",
        };
      }
      setEmps(e);
      setDraft(d);
    } catch (ex: any) {
      setErr(ex?.message || "Failed to load");
    }
  }
  useEffect(() => { load(); }, []);

  function set(id: number, field: keyof Draft, v: string) {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], [field]: v } }));
  }

  async function save() {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const items = (emps || [])
        .map((e) => {
          const d = draft[e.id] || { gross: "", ss: "" };
          const g = parseFloat(d.gross);
          if (isNaN(g)) return null; // skip rows left blank
          const s = d.ss.trim() === "" ? null : parseFloat(d.ss);
          return { employee_id: e.id, ytd_gross: g, ytd_ss_wages: (s != null && !isNaN(s)) ? s : null, tax_year: TAX_YEAR };
        })
        .filter(Boolean);
      if (items.length === 0) { setErr("Enter at least one YTD gross figure."); setBusy(false); return; }
      const res = await apiPost<{ seeded: number }>("/payroll/ytd/seed", items);
      setMsg(`Saved YTD for ${res.seeded} employee(s). Wage-base caps (SS / FUTA / UI) will now compute correctly on the next run.`);
      await load();
    } catch (ex: any) {
      setErr(ex?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <PayrollNav active="ytd" />
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 22, fontSize: 14 }}>
      <h1 style={{ marginBottom: 2 }}>Year-to-date setup ({TAX_YEAR})</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Mid-year cutover from Paychex: enter each person&apos;s <b>YTD gross</b> as of their last Paychex check
        (from the last pay stub or the Paychex YTD report). This makes wage-base caps —
        Social Security ($ base), FUTA, and NY/NJ unemployment — stop charging once someone is already over the cap for the year.
      </p>
      <p style={{ color: "#888", marginTop: -6, fontSize: 12 }}>
        Leave <b>SS wages</b> blank unless it differs from gross (it usually doesn&apos;t — 401(k) doesn&apos;t reduce FICA wages).
        Do this once, before your first real in-house run.
      </p>

      {msg && <div style={{ ...card, background: "#e8f5e9", borderColor: "#a5d6a7" }}>{msg}</div>}
      {err && <div style={{ ...card, background: "#ffebee", borderColor: "#ef9a9a", whiteSpace: "pre-wrap" }}>{err}</div>}

      {!emps && !err && <div style={{ color: "#777" }}>Loading roster…</div>}

      {emps && (
        <div style={card}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={{ ...th, textAlign: "left" }}>Employee</th>
              <th style={{ ...th, textAlign: "left" }}>State</th>
              <th style={th}>YTD gross ($)</th>
              <th style={th}>YTD SS wages ($)</th>
            </tr></thead>
            <tbody>
              {emps.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...td, textAlign: "left" }}>{e.legal_name}</td>
                  <td style={{ ...td, textAlign: "left", color: "#777" }}>{e.work_state}{e.nyc_resident ? " · NYC" : ""}</td>
                  <td style={td}>
                    <input style={inp} inputMode="decimal" placeholder="0.00"
                           value={draft[e.id]?.gross ?? ""} onChange={(ev) => set(e.id, "gross", ev.target.value)} />
                  </td>
                  <td style={td}>
                    <input style={inp} inputMode="decimal" placeholder="= gross"
                           value={draft[e.id]?.ss ?? ""} onChange={(ev) => set(e.id, "ss", ev.target.value)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
            <button disabled={busy} onClick={save} style={{ padding: "8px 18px", fontSize: 15 }}>
              {busy ? "Saving…" : "Save YTD"}
            </button>
            <span style={{ color: "#888", fontSize: 12 }}>Re-saving overwrites the stored figures for {TAX_YEAR}.</span>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
