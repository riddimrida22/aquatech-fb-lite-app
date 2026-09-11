"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, API_BASE } from "../../lib/api";

type Pursuit = {
  id: number; name: string; client_name: string; agency: string | null; sector: string; role: string;
  stage: string; win_probability: number; is_open: boolean; est_fee: number; weighted_value: number;
  proposal_due_date: string | null; interview_date: string | null; decision_expected_date: string | null;
  win_strategy: string; scope_summary: string; incumbent: string | null;
  gng_score: number | null; gng_recommendation: string | null; gng_scores?: Record<string, number>;
  outcome_reason?: string | null; converted_project_id?: number | null;
  bd_hours?: number; bd_cost?: number;
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
  bd_cost_total?: number; bd_hours_total?: number; bd_cost_won?: number; cost_per_win?: number | null;
  top_bd_cost?: { pursuit_id: number; name: string; stage: string; hours: number; cost: number }[];
  review_reasons?: { won?: Record<string, number>; lost?: Record<string, number>; no_go?: Record<string, number> };
};
type KitDoc = { id: number; title: string; agency: string | null; sector: string | null };
type Kit = { pursuit: { id: number; name: string; agency: string | null; sector: string | null };
  counts: Record<string, number>; resumes: KitDoc[]; project_sheets: KitDoc[];
  capability_statements: KitDoc[]; certifications: KitDoc[]; client_references: KitDoc[]; past_proposals: KitDoc[] };

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead", qualifying: "Qualifying", go_no_go: "Go / No-Go", pursuing: "Pursuing",
  proposal: "Proposal", shortlist: "Shortlist", won: "Won", lost: "Lost", no_go: "No-Go", abandoned: "Abandoned",
};
const OPEN_STAGES = ["lead", "qualifying", "go_no_go", "pursuing", "proposal", "shortlist"];
const ALL_STAGES = [...OPEN_STAGES, "won", "lost", "no_go", "abandoned"];
const ACCENT = "#21737e";
const fmt$ = (n: number | null | undefined) => "$" + Math.round(n || 0).toLocaleString();

export function BdWorkspace() {
  const [tab, setTab] = useState<"dashboard" | "pipeline" | "library">("dashboard");
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
          {(["dashboard", "pipeline", "library"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              style={{ border: "none", cursor: "pointer", borderRadius: 999, padding: "6px 16px", fontSize: 13, fontWeight: 600,
                background: tab === t ? ACCENT : "transparent", color: tab === t ? "#fff" : "inherit" }}>
              {t === "dashboard" ? "Dashboard" : t === "pipeline" ? "Pipeline" : "Vault"}
            </button>
          ))}
        </div>
        {tab !== "library" ? (
          <button type="button" onClick={() => setCreating(true)}
            style={{ border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", background: "#3b82f6", color: "#fff" }}>
            + New pursuit
          </button>
        ) : null}
      </div>

      {tab === "dashboard" && <Dashboard metrics={metrics} onOpen={setSelId} />}
      {tab === "pipeline" && <Pipeline pursuits={pursuits} onOpen={setSelId} />}
      {tab === "library" && <Library />}

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

type Calibration = {
  sample_size: number; calibrated: boolean; overall_win_rate: number | null;
  bands: { band: string; lo: number; hi: number; n: number; wins: number; win_rate: number | null }[];
  factor_lift: { key: string; label: string; lift: number; avg_won: number; avg_lost: number }[];
  thresholds: { go: number; conditional: number };
};

function GngCalibration() {
  const [cal, setCal] = useState<Calibration | null>(null);
  useEffect(() => { apiGet<Calibration>("/bd/gng/calibration").then(setCal).catch(() => {}); }, []);
  if (!cal) return null;
  const label = { fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: 0.4, opacity: 0.6, marginBottom: 6 };
  return (
    <div className="aq-lite-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Go / No-Go calibration</h3>
        <span style={{ fontSize: 12.5, opacity: 0.6 }}>
          {cal.calibrated ? `learned from ${cal.sample_size} decided pursuits · recommend GO at ${cal.thresholds.go}+` : `${cal.sample_size} decided pursuits (need 8+ to calibrate)`}
        </span>
      </div>
      {!cal.calibrated ? (
        <p className="aq-lite-muted" style={{ marginBottom: 0 }}>Score pursuits and record their outcomes; the win rate by score and the factors that predict wins will calibrate to your own history.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 10 }}>
          <div>
            <div style={label}>Win rate by score band</div>
            {cal.bands.filter((b) => b.n > 0).map((b) => (
              <div key={b.band} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                <div style={{ width: 66, fontSize: 12.5, fontFamily: "monospace" }}>{b.band}</div>
                <div style={{ flex: 1, background: "rgba(0,0,0,0.05)", borderRadius: 5, height: 18 }}>
                  <div style={{ width: `${(b.win_rate || 0) * 100}%`, background: (b.win_rate || 0) >= 0.5 ? "#10b981" : "#f59e0b", height: "100%", borderRadius: 5, minWidth: 2 }} />
                </div>
                <div style={{ width: 82, textAlign: "right", fontSize: 12.5 }}>{b.win_rate != null ? `${Math.round(b.win_rate * 100)}%` : "—"} <span style={{ opacity: 0.5 }}>({b.n})</span></div>
              </div>
            ))}
          </div>
          <div>
            <div style={label}>What separates wins from losses</div>
            {cal.factor_lift.slice(0, 5).map((f) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, fontSize: 12.5 }}>
                <div style={{ flex: 1 }}>{f.label}</div>
                <div style={{ fontFamily: "monospace", color: f.lift > 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>{f.lift > 0 ? "+" : ""}{f.lift.toFixed(1)}</div>
                <div style={{ width: 96, textAlign: "right", opacity: 0.55 }}>won {f.avg_won} · lost {f.avg_lost}</div>
              </div>
            ))}
          </div>
        </div>
      )}
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
        <Kpi label="Cost per win" value={metrics.cost_per_win != null ? fmt$(metrics.cost_per_win) : "—"} sub={metrics.bd_cost_total != null ? `${fmt$(metrics.bd_cost_total)} BD labor` : undefined} />
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

      <GngCalibration />

      {metrics.top_bd_cost && metrics.top_bd_cost.length > 0 && (
        <div className="aq-lite-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Cost of chasing work</h3>
            <span style={{ fontSize: 12.5, opacity: 0.6 }}>{fmt$(metrics.bd_cost_total)} BD labor · {metrics.bd_hours_total}h · {fmt$(metrics.cost_per_win)}/win</span>
          </div>
          <div style={{ marginTop: 8 }}>
            {metrics.top_bd_cost.map((t) => {
              const lost = t.stage === "lost" || t.stage === "no_go";
              return (
                <div key={t.pursuit_id} onClick={() => onOpen(t.pursuit_id)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))" }}>
                  <span style={{ flex: 1, fontSize: 13 }}>{t.name.slice(0, 46)}</span>
                  <span style={{ width: 78, textAlign: "right", fontSize: 11, textTransform: "uppercase", fontWeight: 700, color: t.stage === "won" ? "#10b981" : lost ? "#ef4444" : "#60717a" }}>{STAGE_LABEL[t.stage] || t.stage}</span>
                  <span style={{ width: 54, textAlign: "right", fontSize: 12.5, opacity: 0.65 }}>{t.hours}h</span>
                  <span style={{ width: 84, textAlign: "right", fontSize: 13, fontWeight: 600 }}>{fmt$(t.cost)}</span>
                </div>
              );
            })}
          </div>
          <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>Red = effort spent on pursuits that did not convert.</p>
        </div>
      )}

      {metrics.review_reasons && (Object.keys(metrics.review_reasons.won || {}).length > 0 || Object.keys(metrics.review_reasons.lost || {}).length > 0) && (
        <div className="aq-lite-panel">
          <h3 style={{ marginTop: 0 }}>Why pursuits are won and lost</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, marginTop: -4 }}>Tallied from win/loss reviews.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            {(["won", "lost"] as const).map((k) => (
              <div key={k}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: k === "won" ? "#10b981" : "#ef4444", marginBottom: 6 }}>{k === "won" ? "Wins" : "Losses"}</div>
                {Object.entries(metrics.review_reasons?.[k] || {}).sort((a, b) => b[1] - a[1]).map(([tag, n]) => (
                  <div key={tag} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <div style={{ flex: 1 }}>{tag}</div>
                    <div style={{ width: 110, background: "rgba(0,0,0,0.05)", borderRadius: 4, height: 12 }}>
                      <div style={{ width: `${Math.min(100, n * 14)}%`, background: k === "won" ? "#10b981" : "#ef4444", height: "100%", borderRadius: 4 }} />
                    </div>
                    <div style={{ width: 20, textAlign: "right", opacity: 0.6 }}>{n}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

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
  const [expWin, setExpWin] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [logHrs, setLogHrs] = useState("");
  const [kit, setKit] = useState<Kit | null>(null);
  const [review, setReview] = useState<{ outcome: string; price_competitive: number | null; reasons: string[]; reuse_notes: string } | null>(null);
  const [actSubject, setActSubject] = useState("");
  function load() {
    apiGet<Pursuit>(`/pursuits/${id}`).then((d) => { setP(d); setScores(d.gng_scores || {}); }).catch(() => {});
    apiGet<any>(`/pursuits/${id}/review`).then((r) => { if (r?.exists) setReview({ outcome: r.outcome, price_competitive: r.price_competitive, reasons: r.reasons || [], reuse_notes: r.reuse_notes || "" }); }).catch(() => {});
  }
  useEffect(load, [id]);

  const liveScore = useMemo(() => {
    let t = 0;
    for (const f of factors) { const s = scores[f.key]; if (s) t += f.weight * (s / 5) * 100; }
    return Math.round(t * 10) / 10;
  }, [scores, factors]);
  const rec = liveScore >= 70 ? "GO" : liveScore >= 50 ? "CONDITIONAL" : "NO-GO";
  const recColor = liveScore >= 70 ? "#10b981" : liveScore >= 50 ? "#f59e0b" : "#ef4444";

  async function setStage(stage: string) { await apiPatch(`/pursuits/${id}`, { stage }); load(); onChanged(); }
  async function saveGng() { const r: any = await apiPost(`/pursuits/${id}/gng`, { scores }); if (r?.expected_win_rate != null) setExpWin(r.expected_win_rate); load(); onChanged(); }
  async function suggest() {
    try {
      const r: any = await apiPost(`/pursuits/${id}/gng/suggest`, {});
      if (r?.scores) setScores(r.scores);
      setNotes(r?.notes || {});
      setExpWin(r?.expected_win_rate ?? null);
    } catch { /* ignore */ }
  }
  async function convert() { if (!confirm("Convert this won pursuit into a Project?")) return; try { await apiPost(`/pursuits/${id}/convert`); load(); onChanged(); } catch (e) { alert("Convert failed: " + (e as Error).message); } }
  async function addTask() { if (!actSubject.trim()) return; await apiPost(`/pursuits/${id}/activities`, { kind: "task", subject: actSubject }); setActSubject(""); load(); }
  async function logTime() { const h = parseFloat(logHrs); if (!h || h <= 0) return; await apiPost(`/pursuits/${id}/time`, { hours: h }); setLogHrs(""); load(); onChanged(); }
  async function assemble() { try { setKit(await apiGet<Kit>(`/pursuits/${id}/assemble`)); } catch { /* ignore */ } }
  function kitDownload(docId: number) { fetch(`${API_BASE}/library/${docId}/download`, { credentials: "include" }).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.click(); URL.revokeObjectURL(u); }).catch(() => {}); }
  const rev = review || { outcome: (p && ["won", "lost", "no_go"].includes(p.stage)) ? p.stage : "lost", price_competitive: null, reasons: [] as string[], reuse_notes: "" };
  function setRev(patch: Partial<typeof rev>) { setReview({ ...rev, ...patch }); }
  function toggleReason(tag: string) { setRev({ reasons: rev.reasons.includes(tag) ? rev.reasons.filter((x) => x !== tag) : [...rev.reasons, tag] }); }
  async function saveReview() { await apiPost(`/pursuits/${id}/review`, { outcome: rev.outcome, price_competitive: rev.price_competitive, reasons: rev.reasons.join(","), reuse_notes: rev.reuse_notes }); onChanged(); }
  const REASON_TAGS = ["relationship", "price", "past-performance", "teaming", "incumbent", "timing", "scope", "local-knowledge"];

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
            {expWin != null && (
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                {Math.round(expWin * 100)}% win rate at this score historically
              </div>
            )}
          </div>
        </div>
        {factors.map((f) => (
          <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              {f.label} <span style={{ opacity: 0.4 }}>({Math.round(f.weight * 100)}%)</span>
              {notes[f.key] ? <span style={{ opacity: 0.55, fontSize: 11.5, marginLeft: 6 }}>· {notes[f.key]}</span> : null}
            </div>
            <div style={{ display: "inline-flex", gap: 3 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setScores((s) => ({ ...s, [f.key]: n }))}
                  style={{ width: 26, height: 26, borderRadius: 6, cursor: "pointer", border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", fontSize: 12, fontWeight: 600, background: scores[f.key] === n ? ACCENT : "transparent", color: scores[f.key] === n ? "#fff" : "inherit" }}>{n}</button>
              ))}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button type="button" onClick={suggest} style={{ padding: "7px 16px", borderRadius: 8, border: `1px solid ${ACCENT}`, background: "transparent", color: ACCENT, fontWeight: 600, cursor: "pointer" }}>Suggest from data</button>
          <button type="button" onClick={saveGng} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Save score</button>
        </div>
      </div>

      <div className="aq-lite-panel" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h4 style={{ margin: 0 }}>BD effort on this pursuit</h4>
          <div style={{ fontSize: 14 }}>
            <strong>{p.bd_hours ?? 0}h</strong> <span style={{ opacity: 0.55 }}>·</span> <strong>{fmt$(p.bd_cost ?? 0)}</strong> <span style={{ opacity: 0.55, fontSize: 12.5 }}>loaded cost</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <input type="number" min="0" step="0.5" value={logHrs} onChange={(e) => setLogHrs(e.target.value)} placeholder="hrs" style={{ ...inputStyle, marginTop: 0, width: 90 }} onKeyDown={(e) => e.key === "Enter" && logTime()} />
          <button type="button" onClick={logTime} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontWeight: 600, cursor: "pointer" }}>Log BD hours</button>
          <span className="aq-lite-muted" style={{ fontSize: 12 }}>booked as overhead at your loaded cost rate</span>
        </div>
      </div>

      <div className="aq-lite-panel" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h4 style={{ margin: 0 }}>Proposal kit</h4>
          <button type="button" onClick={assemble} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontWeight: 600, cursor: "pointer" }}>Assemble for this RFP</button>
        </div>
        {!kit ? (
          <p className="aq-lite-muted" style={{ fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>Pull the matching resumes, project sheets, capability statement, certs and references for {p.sector || "this sector"} / {p.agency || "this agency"} in one click.</p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {([["resumes", "Resumes"], ["project_sheets", "Project sheets"], ["capability_statements", "Capability statements"], ["certifications", "Certifications"], ["client_references", "Client references"], ["past_proposals", "Past proposals"]] as const).map(([key, label]) => {
              const docs = (kit as any)[key] as KitDoc[];
              if (!docs || docs.length === 0) return null;
              return (
                <div key={key} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, marginBottom: 2 }}>{label} ({docs.length})</div>
                  {docs.slice(0, 5).map((d) => (
                    <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0", fontSize: 13 }}>
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</span>
                      {d.agency ? <span style={{ fontSize: 11, opacity: 0.5 }}>{d.agency}</span> : null}
                      <button type="button" onClick={() => kitDownload(d.id)} style={{ padding: "2px 10px", fontSize: 12, borderRadius: 6, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "transparent", cursor: "pointer", color: "inherit" }}>Download</button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {["won", "lost", "no_go"].includes(p.stage) && (
        <div className="aq-lite-panel" style={{ marginBottom: 12 }}>
          <h4 style={{ margin: "0 0 6px" }}>Win / loss review</h4>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {REASON_TAGS.map((t) => (
              <button key={t} type="button" onClick={() => toggleReason(t)} style={{ padding: "4px 10px", borderRadius: 999, fontSize: 12, cursor: "pointer", border: `1px solid ${rev.reasons.includes(t) ? ACCENT : "var(--aq-border,rgba(0,0,0,0.15))"}`, background: rev.reasons.includes(t) ? ACCENT : "transparent", color: rev.reasons.includes(t) ? "#fff" : "inherit" }}>{t}</button>
            ))}
          </div>
          <textarea value={rev.reuse_notes} onChange={(e) => setRev({ reuse_notes: e.target.value })} placeholder="What to reuse next time — win themes, what worked, what to fix…" style={{ ...inputStyle, marginTop: 0, width: "100%", minHeight: 54 }} />
          <button type="button" onClick={saveReview} style={{ marginTop: 8, padding: "7px 16px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Save review</button>
        </div>
      )}

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

// ============================ Proposal content vault ============================
type LibDoc = {
  id: number; category: string; title: string; description: string; tags: string[];
  status: string | null; filename: string; size_bytes: number; created_at: string | null;
  sector: string | null; agency: string | null; discipline: string | null;
  is_current: boolean; expires_on: string | null; days_to_expiry: number | null;
};
type LibCat = { key: string; label: string };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Library() {
  const [cats, setCats] = useState<LibCat[]>([]);
  const [docs, setDocs] = useState<LibDoc[]>([]);
  const [expiring, setExpiring] = useState<LibDoc[]>([]);
  // filters
  const [q, setQ] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [currentOnly, setCurrentOnly] = useState(false);
  // upload fields
  const [upCat, setUpCat] = useState("project");
  const [upTitle, setUpTitle] = useState("");
  const [upTags, setUpTags] = useState("");
  const [upStatus, setUpStatus] = useState("current");
  const [upAgency, setUpAgency] = useState("");
  const [upSector, setUpSector] = useState("");
  const [upDiscipline, setUpDiscipline] = useState("");
  const [upExpires, setUpExpires] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  function refresh() {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (filterCat) p.set("category", filterCat);
    if (currentOnly) p.set("current", "true");
    const qs = p.toString();
    apiGet<{ items: LibDoc[] }>(`/library${qs ? `?${qs}` : ""}`).then((r) => setDocs(r.items || [])).catch(() => {});
  }
  useEffect(() => {
    apiGet<{ categories: LibCat[] }>("/library/config").then((c) => setCats(c.categories || [])).catch(() => {});
    apiGet<{ items: LibDoc[] }>("/library/expiring").then((r) => setExpiring(r.items || [])).catch(() => {});
  }, []);
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [q, filterCat, currentOnly]);

  async function upload() {
    if (!file || busy) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", upCat);
      fd.append("title", upTitle || file.name);
      fd.append("tags", upTags);
      if (upCat === "rfp") fd.append("status", upStatus);
      if (upAgency.trim()) fd.append("agency", upAgency.trim());
      if (upSector.trim()) fd.append("sector", upSector.trim());
      if (upDiscipline.trim()) fd.append("discipline", upDiscipline.trim());
      if (upExpires.trim()) fd.append("expires_on", upExpires.trim());
      const res = await fetch(`${API_BASE}/library`, { method: "POST", credentials: "include", body: fd });
      if (!res.ok) throw new Error(await res.text());
      setMsg(`Uploaded “${upTitle || file.name}”.`);
      setFile(null); setUpTitle(""); setUpTags(""); setUpAgency(""); setUpSector(""); setUpDiscipline(""); setUpExpires("");
      const el = document.getElementById("lib-file") as HTMLInputElement | null;
      if (el) el.value = "";
      refresh();
      apiGet<{ items: LibDoc[] }>("/library/expiring").then((r) => setExpiring(r.items || [])).catch(() => {});
    } catch (e) {
      setMsg(e instanceof Error ? e.message.slice(0, 200) : "Upload failed");
    } finally { setBusy(false); }
  }

  async function download(d: LibDoc) {
    try {
      const res = await fetch(`${API_BASE}/library/${d.id}/download`, { credentials: "include" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = d.filename || d.title; a.click();
      URL.revokeObjectURL(url);
    } catch { setMsg("Download failed"); }
  }

  async function remove(d: LibDoc) {
    if (!confirm(`Delete “${d.title}”?`)) return;
    setDocs((x) => x.filter((y) => y.id !== d.id));
    try { await apiDelete(`/library/${d.id}`); } catch { refresh(); }
  }

  const inp = { padding: "9px 11px", borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "var(--aq-input-bg,#fff)", color: "inherit", fontSize: 14 } as const;
  const chip = { fontSize: 11, padding: "1px 7px", borderRadius: 999, border: "1px solid var(--aq-border,rgba(0,0,0,0.12))", opacity: 0.85 } as const;
  const showExpiry = upCat === "certificate";
  const showTaxonomy = ["project", "capability_statement", "past_proposal", "rfp", "client_reference"].includes(upCat);

  function expiryBadge(d: LibDoc) {
    if (d.days_to_expiry == null) return null;
    const c = d.days_to_expiry < 0 ? "#ef4444" : d.days_to_expiry <= 60 ? "#d97706" : "#16a34a";
    const label = d.days_to_expiry < 0 ? "expired" : `${d.days_to_expiry}d to expiry`;
    return <span style={{ ...chip, color: c, borderColor: c }}>{label}</span>;
  }

  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Proposal content vault</p>
        <h3 style={{ margin: "2px 0 10px" }}>Base data for responding to RFPs fast</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input id="lib-file" type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: 13 }} />
          <select value={upCat} onChange={(e) => setUpCat(e.target.value)} style={inp}>
            {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {upCat === "rfp" ? (
            <select value={upStatus} onChange={(e) => setUpStatus(e.target.value)} style={inp}>
              <option value="new">New</option><option value="current">Current</option><option value="previous">Previous</option>
            </select>
          ) : null}
          <input value={upTitle} onChange={(e) => setUpTitle(e.target.value)} placeholder="Title (optional)" style={{ ...inp, flex: 1, minWidth: 150 }} />
          <input value={upTags} onChange={(e) => setUpTags(e.target.value)} placeholder="tags, comma-sep" style={{ ...inp, width: 150 }} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
          {showTaxonomy || upCat === "certificate" ? (
            <input value={upAgency} onChange={(e) => setUpAgency(e.target.value)} placeholder="Agency (DEP, PANYNJ, NYCHA…)" style={{ ...inp, width: 210 }} />
          ) : null}
          {showTaxonomy ? (
            <input value={upSector} onChange={(e) => setUpSector(e.target.value)} placeholder="Sector (water, transportation…)" style={{ ...inp, width: 210 }} />
          ) : null}
          {upCat === "resume" || upCat === "project" ? (
            <input value={upDiscipline} onChange={(e) => setUpDiscipline(e.target.value)} placeholder="Discipline (civil, CPM…)" style={{ ...inp, width: 180 }} />
          ) : null}
          {showExpiry ? (
            <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
              Expires <input type="date" value={upExpires} onChange={(e) => setUpExpires(e.target.value)} style={inp} />
            </label>
          ) : null}
          <button type="button" onClick={upload} disabled={!file || busy}
            style={{ border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 600, cursor: !file || busy ? "default" : "pointer", background: !file || busy ? "rgba(33,115,126,0.5)" : ACCENT, color: "#fff" }}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
        {msg ? <p style={{ marginTop: 8, fontSize: 12.5, color: ACCENT }}>{msg}</p> : null}
        <p className="aq-lite-muted" style={{ marginTop: 8, fontSize: 12 }}>Stored in your database (backed up nightly, survives deploys). 30 MB max per file.</p>
      </section>

      {expiring.length > 0 ? (
        <section className="aq-lite-panel" style={{ borderLeft: "3px solid #d97706" }}>
          <h3 style={{ margin: "0 0 6px" }}>Certifications needing attention <span style={{ opacity: 0.5, fontWeight: 400 }}>({expiring.length})</span></h3>
          {expiring.map((d) => (
            <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{d.title}</span>
              {d.agency ? <span style={chip}>{d.agency}</span> : null}
              {expiryBadge(d)}
              <span style={{ opacity: 0.55, fontSize: 12 }}>{d.expires_on}</span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="aq-lite-panel">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, tag, agency…" style={{ ...inp, flex: 1, minWidth: 200 }} />
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={inp}>
            <option value="">All categories</option>
            {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} /> Current only
          </label>
          <span style={{ opacity: 0.55, fontSize: 12.5, marginLeft: "auto" }}>{docs.length} document{docs.length === 1 ? "" : "s"}</span>
        </div>
      </section>

      {cats.map((c) => {
        const items = docs.filter((d) => d.category === c.key);
        if (items.length === 0) return null;
        return (
          <section key={c.key} className="aq-lite-panel">
            <h3 style={{ margin: "0 0 6px" }}>{c.label} <span style={{ opacity: 0.5, fontWeight: 400 }}>({items.length})</span></h3>
            <div className="aq-lite-scroll">
              {items.map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--aq-border,rgba(0,0,0,0.06))" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.title}{d.status ? <span style={{ marginLeft: 8, fontSize: 11, textTransform: "uppercase", opacity: 0.6 }}>{d.status}</span> : null}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 3 }}>
                      {d.agency ? <span style={chip}>{d.agency}</span> : null}
                      {d.sector ? <span style={chip}>{d.sector}</span> : null}
                      {d.discipline ? <span style={chip}>{d.discipline}</span> : null}
                      {d.tags.map((t) => <span key={t} style={{ ...chip, opacity: 0.6 }}>{t}</span>)}
                      {expiryBadge(d)}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.55, marginTop: 3 }}>
                      {[d.filename, fmtSize(d.size_bytes), (d.created_at || "").slice(0, 10)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, whiteSpace: "nowrap" }}>
                    <button type="button" onClick={() => download(d)} style={{ padding: "5px 12px", fontSize: 12.5, borderRadius: 8, border: "1px solid var(--aq-border,rgba(0,0,0,0.15))", background: "transparent", cursor: "pointer", color: "inherit" }}>Download</button>
                    <button type="button" onClick={() => remove(d)} title="Delete" style={{ padding: "5px 10px", fontSize: 12.5, borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", color: "#ef4444", opacity: 0.7 }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {docs.length === 0 ? <section className="aq-lite-panel"><p className="aq-lite-muted">No documents match. Upload RFPs, resumes, past project sheets, capability statements, certs, and client references to reuse in proposals.</p></section> : null}
    </div>
  );
}
