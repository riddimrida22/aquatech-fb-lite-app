"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch } from "../../lib/api";

type Pursuit = {
  id: number; name: string; client_name: string; agency: string | null; sector: string; role: string;
  stage: string; win_probability: number; is_open: boolean; est_fee: number; weighted_value: number;
  proposal_due_date: string | null; interview_date: string | null; decision_expected_date: string | null;
  win_strategy: string; scope_summary: string; incumbent: string | null;
  gng_score: number | null; gng_recommendation: string | null; gng_scores?: Record<string, number>;
  outcome_reason?: string | null; converted_project_id?: number | null;
  activities?: Activity[];
};
type Activity = { id: number; kind: string; subject: string; body: string; due_date: string | null; completed: boolean; occurred_at: string | null };
type GngFactor = { key: string; label: string; weight: number };
type Metrics = {
  open_count: number; weighted_pipeline: number; raw_pipeline: number;
  by_stage: Record<string, { count: number; value: number; weighted: number }>;
  hit_rate_pct: number | null; won_count: number; lost_count: number;
  upcoming: { pursuit_id: number; name: string; kind: string; date: string; days_out: number }[];
  aging: { pursuit_id: number; name: string; stage: string; days_open: number }[];
  loss_reasons: Record<string, number>;
};

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead", qualifying: "Qualifying", go_no_go: "Go / No-Go", pursuing: "Pursuing",
  proposal: "Proposal", shortlist: "Shortlist", won: "Won", lost: "Lost", no_go: "No-Go", abandoned: "Abandoned",
};
const OPEN_STAGES = ["lead", "qualifying", "go_no_go", "pursuing", "proposal", "shortlist"];
const ALL_STAGES = [...OPEN_STAGES, "won", "lost", "no_go", "abandoned"];
const ACCENT = "#21737e";
const fmt$ = (n: number | null | undefined) => "$" + Math.round(n || 0).toLocaleString();

export function BdWorkspace() {
  const [tab, setTab] = useState<"dashboard" | "pipeline">("dashboard");
  const [pursuits, setPursuits] = useState<Pursuit[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [factors, setFactors] = useState<GngFactor[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  function refresh() {
    apiGet<{ items: Pursuit[] }>("/pursuits").then((r) => setPursuits(r.items || [])).catch(() => {});
    apiGet<Metrics>("/bd/metrics").then(setMetrics).catch(() => {});
  }
  useEffect(() => {
    refresh();
    apiGet<{ gng_factors: GngFactor[] }>("/bd/config").then((c) => setFactors(c.gng_factors || [])).catch(() => {});
  }, []);

  return (
    <div className="aq-lite-stack">
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", gap: 4, background: "var(--aq-input-bg, rgba(0,0,0,0.06))", borderRadius: 999, padding: 3 }}>
          {(["dashboard", "pipeline"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              style={{ border: "none", cursor: "pointer", borderRadius: 999, padding: "6px 16px", fontSize: 13, fontWeight: 600,
                background: tab === t ? ACCENT : "transparent", color: tab === t ? "#fff" : "inherit" }}>
              {t === "dashboard" ? "Dashboard" : "Pipeline"}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setCreating(true)}
          style={{ border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", background: "#3b82f6", color: "#fff" }}>
          + New pursuit
        </button>
      </div>

      {tab === "dashboard" && <Dashboard metrics={metrics} onOpen={setSelId} />}
      {tab === "pipeline" && <Pipeline pursuits={pursuits} onOpen={setSelId} />}

      {creating && <CreateModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />}
      {selId != null && (
        <DetailModal id={selId} factors={factors} onClose={() => setSelId(null)} onChanged={refresh} />
      )}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: "14px 16px", borderRadius: 14, background: "linear-gradient(180deg,#ffffff,#f4f7f8)", border: "1px solid #dbe4e8", minWidth: 150 }}>
      <div style={{ fontSize: 12, color: "#60717a", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "#173241", marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#60717a", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Dashboard({ metrics, onOpen }: { metrics: Metrics | null; onOpen: (id: number) => void }) {
  if (!metrics) return <div className="aq-lite-panel">Loading pipeline…</div>;
  const maxStage = Math.max(1, ...OPEN_STAGES.map((s) => metrics.by_stage[s]?.value || 0));
  return (
    <div className="aq-lite-stack">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px,1fr))", gap: 12 }}>
        <Kpi label="Weighted pipeline" value={fmt$(metrics.weighted_pipeline)} sub={`${fmt$(metrics.raw_pipeline)} unweighted`} />
        <Kpi label="Open pursuits" value={String(metrics.open_count)} />
        <Kpi label="Hit rate" value={metrics.hit_rate_pct != null ? `${metrics.hit_rate_pct}%` : "—"} sub={`${metrics.won_count}W / ${metrics.lost_count}L`} />
        <Kpi label="Deadlines (60d)" value={String(metrics.upcoming.length)} />
      </div>

      <div className="aq-lite-panel">
        <h3 style={{ marginTop: 0 }}>Pipeline by stage</h3>
        {OPEN_STAGES.map((s) => {
          const b = metrics.by_stage[s] || { count: 0, value: 0, weighted: 0 };
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 110, fontSize: 13, color: "#60717a" }}>{STAGE_LABEL[s]}</div>
              <div style={{ flex: 1, background: "rgba(0,0,0,0.05)", borderRadius: 6, height: 22, position: "relative" }}>
                <div style={{ width: `${((b.value || 0) / maxStage) * 100}%`, background: ACCENT, height: "100%", borderRadius: 6, minWidth: b.value ? 2 : 0 }} />
              </div>
              <div style={{ width: 150, textAlign: "right", fontSize: 13 }}>{fmt$(b.value)} <span style={{ opacity: 0.5 }}>({b.count})</span></div>
            </div>
          );
        })}
      </div>

      <div className="aq-lite-grid aq-lite-grid-2">
        <div className="aq-lite-panel">
          <h3 style={{ marginTop: 0 }}>Upcoming deadlines</h3>
          {metrics.upcoming.length === 0 ? <p className="aq-lite-muted">Nothing in the next 60 days.</p> :
            metrics.upcoming.map((u, i) => (
              <div key={i} onClick={() => onOpen(u.pursuit_id)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))" }}>
                <span>{u.kind}: {u.name.slice(0, 34)}</span>
                <span style={{ color: u.days_out <= 7 ? "#ef4444" : "inherit", fontWeight: 600 }}>{u.date} ({u.days_out}d)</span>
              </div>
            ))}
        </div>
        <div className="aq-lite-panel">
          <h3 style={{ marginTop: 0 }}>Stalled (45d+ open)</h3>
          {metrics.aging.length === 0 ? <p className="aq-lite-muted">No stalled pursuits.</p> :
            metrics.aging.map((a, i) => (
              <div key={i} onClick={() => onOpen(a.pursuit_id)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))" }}>
                <span>{a.name.slice(0, 34)} <span style={{ opacity: 0.5 }}>· {STAGE_LABEL[a.stage]}</span></span>
                <span style={{ fontWeight: 600 }}>{a.days_open}d</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function Pipeline({ pursuits, onOpen }: { pursuits: Pursuit[]; onOpen: (id: number) => void }) {
  const grouped = useMemo(() => {
    const g: Record<string, Pursuit[]> = {};
    for (const p of pursuits) (g[p.stage] ||= []).push(p);
    return g;
  }, [pursuits]);
  return (
    <div className="aq-lite-stack">
      {ALL_STAGES.filter((s) => (grouped[s] || []).length).map((s) => {
        const rows = grouped[s];
        const val = rows.reduce((a, p) => a + (p.est_fee || 0), 0);
        return (
          <div key={s} className="aq-lite-panel">
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>{STAGE_LABEL[s]} <span style={{ opacity: 0.5, fontWeight: 400 }}>({rows.length})</span></h3>
              <span style={{ color: "#60717a" }}>{fmt$(val)}</span>
            </div>
            {rows.map((p) => (
              <div key={p.id} onClick={() => onOpen(p.id)} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.6 }}>{[p.client_name, p.agency, p.proposal_due_date ? `due ${p.proposal_due_date}` : null].filter(Boolean).join(" · ")}</div>
                </div>
                <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <div style={{ fontWeight: 700 }}>{fmt$(p.est_fee)}</div>
                  <div style={{ fontSize: 12, opacity: 0.6 }}>{Math.round((p.win_probability || 0) * 100)}% · {fmt$(p.weighted_value)}</div>
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {pursuits.length === 0 && <div className="aq-lite-panel"><p className="aq-lite-muted">No pursuits yet — click “+ New pursuit”.</p></div>}
    </div>
  );
}

function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "5vh 16px", zIndex: 1000, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="aq-lite-panel" style={{ width: "100%", maxWidth: wide ? 720 : 480, background: "var(--aq-panel-bg,#fff)" }}>
        {children}
      </div>
    </div>
  );
}

const inputStyle = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "var(--aq-input-bg,#fff)", color: "inherit", fontSize: 14, marginTop: 4 } as const;
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block", marginBottom: 10, fontSize: 12.5, fontWeight: 600, color: "#60717a" }}>{label}{children}</label>;
}

function CreateModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: "", client_name: "", agency: "", sector: "public", est_fee: "", proposal_due_date: "", stage: "lead" });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  async function save() {
    if (!f.name.trim() || busy) return;
    setBusy(true);
    try {
      await apiPost("/pursuits", { ...f, est_fee: parseFloat(f.est_fee) || 0 });
      onSaved();
    } catch { setBusy(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>New pursuit</h3>
      <Field label="Name *"><input style={inputStyle} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="DEP – Newtown Creek CSO H&H" /></Field>
      <div className="aq-lite-grid aq-lite-grid-2">
        <Field label="Client"><input style={inputStyle} value={f.client_name} onChange={(e) => set("client_name", e.target.value)} /></Field>
        <Field label="Agency"><input style={inputStyle} value={f.agency} onChange={(e) => set("agency", e.target.value)} placeholder="DEP / DDC / DOT" /></Field>
        <Field label="Est. fee ($)"><input style={inputStyle} type="number" value={f.est_fee} onChange={(e) => set("est_fee", e.target.value)} /></Field>
        <Field label="Proposal due"><input style={inputStyle} type="date" value={f.proposal_due_date} onChange={(e) => set("proposal_due_date", e.target.value)} /></Field>
        <Field label="Sector"><select style={inputStyle} value={f.sector} onChange={(e) => set("sector", e.target.value)}><option value="public">Public</option><option value="private">Private</option><option value="federal">Federal</option></select></Field>
        <Field label="Stage"><select style={inputStyle} value={f.stage} onChange={(e) => set("stage", e.target.value)}>{OPEN_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></Field>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <button type="button" onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "transparent", cursor: "pointer" }}>Cancel</button>
        <button type="button" onClick={save} disabled={!f.name.trim() || busy} style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontWeight: 600, cursor: "pointer" }}>{busy ? "Saving…" : "Create"}</button>
      </div>
    </Modal>
  );
}

function DetailModal({ id, factors, onClose, onChanged }: { id: number; factors: GngFactor[]; onClose: () => void; onChanged: () => void }) {
  const [p, setP] = useState<Pursuit | null>(null);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [actSubject, setActSubject] = useState("");
  function load() { apiGet<Pursuit>(`/pursuits/${id}`).then((d) => { setP(d); setScores(d.gng_scores || {}); }).catch(() => {}); }
  useEffect(load, [id]);

  const liveScore = useMemo(() => {
    let t = 0;
    for (const f of factors) { const s = scores[f.key]; if (s) t += f.weight * (s / 5) * 100; }
    return Math.round(t * 10) / 10;
  }, [scores, factors]);
  const rec = liveScore >= 70 ? "GO" : liveScore >= 50 ? "CONDITIONAL" : "NO-GO";
  const recColor = liveScore >= 70 ? "#10b981" : liveScore >= 50 ? "#f59e0b" : "#ef4444";

  async function setStage(stage: string) { await apiPatch(`/pursuits/${id}`, { stage }); load(); onChanged(); }
  async function saveGng() { await apiPost(`/pursuits/${id}/gng`, { scores }); load(); onChanged(); }
  async function convert() { if (!confirm("Convert this won pursuit into a Project?")) return; try { await apiPost(`/pursuits/${id}/convert`); load(); onChanged(); } catch (e) { alert("Convert failed: " + (e as Error).message); } }
  async function addTask() { if (!actSubject.trim()) return; await apiPost(`/pursuits/${id}/activities`, { kind: "task", subject: actSubject }); setActSubject(""); load(); }

  if (!p) return <Modal onClose={onClose} wide>Loading…</Modal>;
  return (
    <Modal onClose={onClose} wide>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>{p.name}</h3>
          <div style={{ fontSize: 13, opacity: 0.65 }}>{[p.client_name, p.agency, `${fmt$(p.est_fee)}`, `${Math.round(p.win_probability * 100)}% → ${fmt$(p.weighted_value)}`].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 22, cursor: "pointer", opacity: 0.5 }}>×</button>
      </div>

      <div style={{ margin: "12px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "#60717a" }}>Stage:</span>
        <select value={p.stage} onChange={(e) => setStage(e.target.value)} style={{ ...inputStyle, width: "auto", marginTop: 0, padding: "6px 10px" }}>
          {ALL_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        {p.stage === "won" && !p.converted_project_id && (
          <button type="button" onClick={convert} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontWeight: 600, cursor: "pointer" }}>Convert to Project →</button>
        )}
        {p.converted_project_id && <span style={{ fontSize: 12.5, color: "#10b981" }}>✓ Project #{p.converted_project_id}</span>}
      </div>

      <div className="aq-lite-panel" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4 style={{ margin: "0 0 6px" }}>Go / No-Go</h4>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: recColor }}>{liveScore}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: recColor, marginLeft: 8 }}>{rec}</span>
          </div>
        </div>
        {factors.map((f) => (
          <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ flex: 1, fontSize: 13 }}>{f.label} <span style={{ opacity: 0.4 }}>({Math.round(f.weight * 100)}%)</span></div>
            <div style={{ display: "inline-flex", gap: 3 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setScores((s) => ({ ...s, [f.key]: n }))}
                  style={{ width: 26, height: 26, borderRadius: 6, cursor: "pointer", border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", fontSize: 12, fontWeight: 600, background: scores[f.key] === n ? ACCENT : "transparent", color: scores[f.key] === n ? "#fff" : "inherit" }}>{n}</button>
              ))}
            </div>
          </div>
        ))}
        <button type="button" onClick={saveGng} style={{ marginTop: 8, padding: "7px 16px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Save score</button>
      </div>

      <div className="aq-lite-panel">
        <h4 style={{ margin: "0 0 6px" }}>Activity & tasks</h4>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input style={{ ...inputStyle, marginTop: 0 }} value={actSubject} onChange={(e) => setActSubject(e.target.value)} placeholder="Add a task / note…" onKeyDown={(e) => e.key === "Enter" && addTask()} />
          <button type="button" onClick={addTask} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Add</button>
        </div>
        {(p.activities || []).length === 0 ? <p className="aq-lite-muted">No activity yet.</p> :
          (p.activities || []).map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))", fontSize: 13.5 }}>
              <span>{a.kind === "task" ? "☐ " : ""}{a.subject}</span>
              <span style={{ opacity: 0.5, fontSize: 12 }}>{a.due_date ? `due ${a.due_date}` : (a.occurred_at || "").slice(0, 10)}</span>
            </div>
          ))}
      </div>
    </Modal>
  );
}
