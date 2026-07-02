"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type CatGroup = { group: string; categories: string[] };
type QueueRow = {
  bank_transaction_id: number;
  account_name: string | null;
  posted_date: string | null;
  description: string;
  amount: number;
  merchant_name: string | null;
  is_business: boolean;
  expense_group: string | null;
  category: string | null;
};
type QueueOut = { rows: QueueRow[]; total: number; limit: number; offset: number };

function isUncategorized(r: QueueRow): boolean {
  const c = (r.category || "").trim().toLowerCase();
  return !c || c === "uncategorized";
}

// Review and categorize credit-card / checking transactions. Mirrors the FreshBooks
// Expenses flow: pick a category, optionally learn it for the merchant, or bulk
// auto-categorize from learned rules. Every assignment flows straight into the P&L.
export function CategorizationWorkspace() {
  const [groups, setGroups] = useState<CatGroup[]>([]);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uncatOnly, setUncatOnly] = useState(true);
  const [pending, setPending] = useState<Record<number, string>>({});
  const [learn, setLearn] = useState<Record<number, boolean>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [savedIds, setSavedIds] = useState<Record<number, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCat, setBulkCat] = useState("");
  const [bulkLearn, setBulkLearn] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiGet<CatGroup[]>("/bank/categories"),
      apiGet<QueueOut>("/bank/reconciliation/queue-page?limit=500&include_personal=false"),
    ])
      .then(([g, q]) => { setGroups(g || []); setRows(q?.rows || []); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => (uncatOnly ? rows.filter(isUncategorized) : rows), [rows, uncatOnly]);
  const uncatCount = useMemo(() => rows.filter(isUncategorized).length, [rows]);

  const groupForCategory = useCallback((cat: string): string => {
    for (const g of groups) if (g.categories.includes(cat)) return g.group;
    return "OH";
  }, [groups]);

  const saveRow = useCallback(async (r: QueueRow) => {
    const sel = pending[r.bank_transaction_id];
    if (!sel) return;
    const [group, category] = sel.split("||");
    if (!category) return;
    setSavingId(r.bank_transaction_id);
    try {
      await apiPost(`/bank/transactions/${r.bank_transaction_id}/categorize`, {
        expense_group: group, category, learn_for_merchant: !!learn[r.bank_transaction_id],
      });
      setRows((prev) => prev.map((x) =>
        x.bank_transaction_id === r.bank_transaction_id ? { ...x, expense_group: group, category } : x));
      setSavedIds((p) => ({ ...p, [r.bank_transaction_id]: true }));
      setPending((p) => { const n = { ...p }; delete n[r.bank_transaction_id]; return n; });
      setMsg(null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }, [pending, learn]);

  const autoCategorize = useCallback(async () => {
    setMsg("Auto-categorizing from learned rules…");
    try {
      const res = await apiPost<{ applied?: number; updated?: number }>(
        "/bank/reconciliation/apply-category-recommendations", { min_confidence: 0.85 });
      const n = res?.applied ?? res?.updated;
      setMsg(`Auto-categorized${n != null ? ` ${n}` : ""} transactions from learned rules + suggestions.`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Auto-categorize failed");
    }
  }, [load]);

  const toggleSel = (id: number) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const applyBulk = useCallback(async () => {
    if (!bulkCat || selected.size === 0) return;
    const [group, category] = bulkCat.split("||");
    if (!category) return;
    setBulkBusy(true);
    try {
      const res = await apiPost<{ updated?: number }>("/bank/transactions/categorize-bulk", {
        transaction_ids: Array.from(selected), expense_group: group, category, learn_for_merchant: bulkLearn,
      });
      setMsg(`Categorized ${res?.updated ?? selected.size} transaction(s)${bulkLearn ? " + learned merchant rules" : ""}.`);
      setSelected(new Set()); setBulkCat(""); setBulkLearn(false);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Bulk categorize failed");
    } finally {
      setBulkBusy(false);
    }
  }, [bulkCat, bulkLearn, selected, load]);

  if (loading) return <section className="aq-lite-panel"><p className="aq-lite-muted">Loading transactions…</p></section>;
  if (err) return <section className="aq-lite-panel"><p style={{ color: "var(--aq-red)" }}>{err}</p></section>;

  return (
    <div className="aq-lite-stack">
      <section className="aq-lite-panel" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Categorize transactions</p>
            <h3 style={{ margin: "4px 0 0" }}>
              {uncatCount} need a category
              <span style={{ color: "var(--aq-muted)", fontSize: 13, fontWeight: 400 }}> · {rows.length} total</span>
            </h3>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--aq-muted)", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={uncatOnly} onChange={(e) => setUncatOnly(e.target.checked)} /> Uncategorized only
            </label>
            <button type="button" onClick={autoCategorize}>Auto-categorize</button>
          </div>
        </div>
        {msg ? <p style={{ marginTop: 8, fontSize: 12, color: "var(--aq-primary-dark)" }}>{msg}</p> : null}
      </section>

      {selected.size > 0 ? (
        <section className="aq-lite-panel" style={{ position: "sticky", top: 0, zIndex: 5, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", paddingTop: 10, paddingBottom: 10 }}>
          <strong>{selected.size} selected</strong>
          <select value={bulkCat} onChange={(e) => setBulkCat(e.target.value)} style={{ minWidth: 220 }}>
            <option value="">— set category for all —</option>
            {groups.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.categories.map((c) => <option key={c} value={`${g.group}||${c}`}>{c}</option>)}
              </optgroup>
            ))}
          </select>
          <label style={{ fontSize: 12, color: "var(--aq-muted)", display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={bulkLearn} onChange={(e) => setBulkLearn(e.target.checked)} /> learn merchants
          </label>
          <button type="button" disabled={!bulkCat || bulkBusy} onClick={applyBulk} style={{ fontWeight: 600 }}>
            {bulkBusy ? "Applying…" : `Apply to ${selected.size}`}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} style={{ background: "transparent", border: "1px solid var(--aq-border)", boxShadow: "none" }}>Clear</button>
        </section>
      ) : null}

      <section className="aq-lite-panel" style={{ overflowX: "auto" }}>
        <table className="aq-lite-table">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  checked={visible.length > 0 && visible.every((r) => selected.has(r.bank_transaction_id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((r) => r.bank_transaction_id)) : new Set())}
                  title="Select all shown"
                />
              </th>
              <th style={{ textAlign: "left" }}>Date</th>
              <th style={{ textAlign: "left" }}>Merchant / Description</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th style={{ textAlign: "left" }}>Account</th>
              <th style={{ textAlign: "left" }}>Category</th>
              <th style={{ textAlign: "left" }}>Same merchant</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={8} style={{ color: "var(--aq-muted)", padding: 16 }}>
                {uncatOnly ? "🎉 Nothing left to categorize." : "No transactions."}
              </td></tr>
            ) : null}
            {visible.map((r) => {
              const id = r.bank_transaction_id;
              const current = r.category ? `${r.expense_group || groupForCategory(r.category)}||${r.category}` : "";
              const sel = pending[id] ?? current;
              const dirty = pending[id] != null && pending[id] !== current;
              return (
                <tr key={id} style={savedIds[id] ? { background: "var(--aq-row-head)" } : undefined}>
                  <td><input type="checkbox" checked={selected.has(id)} onChange={() => toggleSel(id)} /></td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--aq-muted)" }}>{r.posted_date || "—"}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.merchant_name || "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--aq-muted)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description}</div>
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap", color: r.amount < 0 ? "inherit" : "var(--aq-green)" }}>{formatCurrency(Math.abs(r.amount))}</td>
                  <td style={{ fontSize: 12, color: "var(--aq-muted)", whiteSpace: "nowrap" }}>{r.account_name || "—"}</td>
                  <td>
                    <select value={sel} onChange={(e) => setPending((p) => ({ ...p, [id]: e.target.value }))} style={{ minWidth: 200 }}>
                      <option value="">— choose —</option>
                      {groups.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                          {g.categories.map((c) => <option key={c} value={`${g.group}||${c}`}>{c}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input type="checkbox" checked={!!learn[id]} onChange={(e) => setLearn((p) => ({ ...p, [id]: e.target.checked }))} title="Apply this category to all transactions from this merchant" />
                  </td>
                  <td>
                    <button type="button" disabled={!dirty || savingId === id} onClick={() => saveRow(r)}
                      style={{ padding: "4px 12px", fontSize: 12 }}>
                      {savingId === id ? "Saving…" : savedIds[id] && !dirty ? "Saved ✓" : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
