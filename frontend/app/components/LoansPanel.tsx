"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

export type Loan = {
  id: number;
  name: string;
  lender: string;
  loan_type: string;
  account_last4: string | null;
  principal_original: number;
  principal_current: number;
  interest_rate_apr: number;
  payment_amount: number;
  payment_frequency: string;
  origination_date: string | null;
  maturity_date: string | null;
  description_match: string;
  notes: string;
  is_active: boolean;
  payments_count: number;
  payments_total: number;
  interest_total: number;
  principal_total: number;
};

export type LoanPayment = {
  id: number;
  loan_id: number;
  payment_date: string;
  total_amount: number;
  principal_amount: number;
  interest_amount: number;
  fees_amount: number;
  bank_transaction_id: number | null;
  notes: string;
};

const TYPES = [
  { value: "term_loan", label: "Term loan" },
  { value: "line_of_credit", label: "Line of credit" },
  { value: "credit_card", label: "Credit card (as debt)" },
  { value: "owner_loan", label: "Owner loan" },
  { value: "sba", label: "SBA loan" },
  { value: "other", label: "Other" },
];

const FREQS = [
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "irregular", label: "Irregular" },
];

const EMPTY_FORM = {
  name: "",
  lender: "",
  loan_type: "term_loan",
  account_last4: "",
  principal_original: "",
  principal_current: "",
  interest_rate_apr: "",
  payment_amount: "",
  payment_frequency: "monthly",
  origination_date: "",
  maturity_date: "",
  description_match: "",
  notes: "",
  is_active: true,
};

export function LoansPanel({ canManage }: { canManage: boolean }) {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Loan | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [openLoanId, setOpenLoanId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setLoans(await apiGet<Loan[]>("/loans?include_inactive=true"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load loans");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function startAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowAdd(true);
  }

  function startEdit(loan: Loan) {
    setEditing(loan);
    setForm({
      name: loan.name,
      lender: loan.lender || "",
      loan_type: loan.loan_type,
      account_last4: loan.account_last4 || "",
      principal_original: String(loan.principal_original || ""),
      principal_current: String(loan.principal_current || ""),
      interest_rate_apr: String(loan.interest_rate_apr || ""),
      payment_amount: String(loan.payment_amount || ""),
      payment_frequency: loan.payment_frequency,
      origination_date: loan.origination_date || "",
      maturity_date: loan.maturity_date || "",
      description_match: loan.description_match || "",
      notes: loan.notes || "",
      is_active: loan.is_active,
    });
    setShowAdd(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const body = {
        name: form.name.trim(),
        lender: form.lender.trim(),
        loan_type: form.loan_type,
        account_last4: form.account_last4.trim() || null,
        principal_original: Number(form.principal_original) || 0,
        principal_current:
          form.principal_current === ""
            ? Number(form.principal_original) || 0
            : Number(form.principal_current),
        interest_rate_apr: Number(form.interest_rate_apr) || 0,
        payment_amount: Number(form.payment_amount) || 0,
        payment_frequency: form.payment_frequency,
        origination_date: form.origination_date || null,
        maturity_date: form.maturity_date || null,
        description_match: form.description_match.trim(),
        notes: form.notes.trim(),
        is_active: form.is_active,
      };
      if (editing) await apiPut<Loan>(`/loans/${editing.id}`, body);
      else await apiPost<Loan>("/loans", body);
      setShowAdd(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to save loan");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(loan: Loan) {
    if (!confirm(`Delete loan '${loan.name}'? (Loans with payments must be deactivated, not deleted.)`)) return;
    try {
      await apiDelete(`/loans/${loan.id}`);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const totals = useMemo(() => {
    let outstanding = 0;
    let totalInterestPaid = 0;
    let totalPrincipalPaid = 0;
    for (const l of loans) {
      if (l.is_active) outstanding += l.principal_current;
      totalInterestPaid += l.interest_total;
      totalPrincipalPaid += l.principal_total;
    }
    return { outstanding, totalInterestPaid, totalPrincipalPaid };
  }, [loans]);

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head" style={{ alignItems: "center" }}>
        <div>
          <p className="aq-lite-eyebrow">Liabilities</p>
          <h3>Loans &amp; lines of credit</h3>
        </div>
        {canManage ? (
          <button type="button" onClick={startAdd}>+ Add loan / LOC</button>
        ) : null}
      </div>

      <div className="aq-lite-grid aq-lite-grid-3" style={{ marginBottom: 12 }}>
        <article className="aq-lite-kpi">
          <span>Outstanding principal</span>
          <strong>{formatCurrency(totals.outstanding)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Lifetime interest paid</span>
          <strong>{formatCurrency(totals.totalInterestPaid)}</strong>
        </article>
        <article className="aq-lite-kpi">
          <span>Lifetime principal paid</span>
          <strong>{formatCurrency(totals.totalPrincipalPaid)}</strong>
        </article>
      </div>

      {showAdd && canManage ? (
        <form
          onSubmit={save}
          style={{
            border: "1px solid var(--aq-border)", borderRadius: 10, padding: 14,
            marginBottom: 12, background: "var(--aq-subtle)", display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr", gap: 10,
          }}
        >
          <label>Name<input value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Lender<input value={form.lender} onChange={(e) => setForm({ ...form, lender: e.target.value })} /></label>
          <label>Type
            <select value={form.loan_type} onChange={(e) => setForm({ ...form, loan_type: e.target.value })}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label>Account last4<input value={form.account_last4} onChange={(e) => setForm({ ...form, account_last4: e.target.value })} placeholder="0434" /></label>
          <label>Original principal<input type="number" step="0.01" value={form.principal_original} onChange={(e) => setForm({ ...form, principal_original: e.target.value })} /></label>
          <label>Current balance<input type="number" step="0.01" value={form.principal_current} onChange={(e) => setForm({ ...form, principal_current: e.target.value })} placeholder="(default = original)" /></label>
          <label>Interest APR (%)<input type="number" step="0.01" value={form.interest_rate_apr} onChange={(e) => setForm({ ...form, interest_rate_apr: e.target.value })} /></label>
          <label>Payment amount<input type="number" step="0.01" value={form.payment_amount} onChange={(e) => setForm({ ...form, payment_amount: e.target.value })} /></label>
          <label>Frequency
            <select value={form.payment_frequency} onChange={(e) => setForm({ ...form, payment_frequency: e.target.value })}>
              {FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          <label>Origination<input type="date" value={form.origination_date} onChange={(e) => setForm({ ...form, origination_date: e.target.value })} /></label>
          <label>Maturity<input type="date" value={form.maturity_date} onChange={(e) => setForm({ ...form, maturity_date: e.target.value })} /></label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Active
          </label>
          <label style={{ gridColumn: "1 / span 3" }}>
            Description match (keywords seen in bank statements — e.g. "FUNDBOX", "SBA")
            <input value={form.description_match} onChange={(e) => setForm({ ...form, description_match: e.target.value })} />
          </label>
          <label style={{ gridColumn: "1 / span 3" }}>
            Notes<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
          </label>
          <div style={{ gridColumn: "1 / span 3", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" style={{ background: "transparent", color: "var(--aq-primary-dark)", border: "1px solid var(--aq-border)", boxShadow: "none" }} onClick={() => { setShowAdd(false); setEditing(null); }}>Cancel</button>
            <button type="submit" disabled={submitting}>{submitting ? "Saving…" : (editing ? "Save changes" : "Create loan")}</button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <p className="aq-lite-muted">Loading…</p>
      ) : err ? (
        <p style={{ color: "var(--aq-red)" }}>{err}</p>
      ) : loans.length === 0 ? (
        <p className="aq-lite-muted">No loans tracked yet. Add a term loan, line of credit, owner loan, or other liability to keep loan payments out of the expense bucket.</p>
      ) : (
        <table className="aq-lite-table">
          <thead>
            <tr>
              <th>Loan</th>
              <th>Type</th>
              <th>Lender</th>
              <th style={{ textAlign: "right" }}>Original</th>
              <th style={{ textAlign: "right" }}>Current</th>
              <th style={{ textAlign: "right" }}>APR</th>
              <th style={{ textAlign: "right" }}>Payment</th>
              <th style={{ textAlign: "right" }}>Paid (Int / Princ)</th>
              {canManage ? <th data-disable-sort="true" style={{ width: 130 }}></th> : null}
            </tr>
          </thead>
          <tbody>
            {loans.map((l) => (
              <>
                <tr
                  key={l.id}
                  onClick={() => setOpenLoanId((cur) => (cur === l.id ? null : l.id))}
                  style={{ cursor: "pointer", opacity: l.is_active ? 1 : 0.6 }}
                >
                  <td><strong>{l.name}</strong>{l.account_last4 ? <div style={{ fontSize: 10, color: "var(--aq-muted)" }}>•••• {l.account_last4}</div> : null}</td>
                  <td style={{ fontSize: 12 }}>{TYPES.find((t) => t.value === l.loan_type)?.label || l.loan_type}</td>
                  <td style={{ fontSize: 12 }}>{l.lender || "—"}</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(l.principal_original)}</td>
                  <td style={{ textAlign: "right", fontWeight: 600, color: l.principal_current > 0 ? "var(--aq-red)" : "var(--aq-green)" }}>{formatCurrency(l.principal_current)}</td>
                  <td style={{ textAlign: "right" }}>{l.interest_rate_apr.toFixed(2)}%</td>
                  <td style={{ textAlign: "right" }}>{formatCurrency(l.payment_amount)}</td>
                  <td style={{ textAlign: "right", fontSize: 12, color: "var(--aq-muted)" }}>
                    {formatCurrency(l.interest_total)} / {formatCurrency(l.principal_total)}
                  </td>
                  {canManage ? (
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                      <button type="button" onClick={() => startEdit(l)} style={{ padding: "2px 8px", fontSize: 11, marginRight: 4 }}>Edit</button>
                      <button type="button" onClick={() => remove(l)} style={{ padding: "2px 8px", fontSize: 11, background: "transparent", color: "var(--aq-red)", border: "1px solid var(--aq-border)", boxShadow: "none", whiteSpace: "nowrap" }}>Delete</button>
                    </td>
                  ) : null}
                </tr>
                {openLoanId === l.id ? (
                  <tr>
                    <td colSpan={canManage ? 9 : 8} style={{ padding: 0, background: "var(--aq-primary-soft)" }}>
                      <LoanPaymentsInline loanId={l.id} canManage={canManage} onChange={() => void load()} />
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}


function LoanPaymentsInline({ loanId, canManage, onChange }: { loanId: number; canManage: boolean; onChange: () => void }) {
  const [items, setItems] = useState<LoanPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showDraw, setShowDraw] = useState(false);
  const [drawForm, setDrawForm] = useState({ draw_date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
  const [form, setForm] = useState({
    payment_date: new Date().toISOString().slice(0, 10),
    total_amount: "",
    principal_amount: "",
    interest_amount: "",
    fees_amount: "",
    notes: "",
  });

  async function load() {
    setLoading(true);
    try {
      setItems(await apiGet<LoanPayment[]>(`/loans/${loanId}/payments`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [loanId]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await apiPost<LoanPayment>(`/loans/${loanId}/payments`, {
        payment_date: form.payment_date,
        total_amount: Number(form.total_amount) || 0,
        principal_amount: Number(form.principal_amount) || 0,
        interest_amount: Number(form.interest_amount) || 0,
        fees_amount: Number(form.fees_amount) || 0,
        notes: form.notes,
      });
      setShowAdd(false);
      setForm({ payment_date: new Date().toISOString().slice(0, 10), total_amount: "", principal_amount: "", interest_amount: "", fees_amount: "", notes: "" });
      await load();
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add payment");
    }
  }

  async function addDraw(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await apiPost(`/loans/${loanId}/draw`, {
        amount: Number(drawForm.amount) || 0,
        draw_date: drawForm.draw_date,
        notes: drawForm.notes,
      });
      setShowDraw(false);
      setDrawForm({ draw_date: new Date().toISOString().slice(0, 10), amount: "", notes: "" });
      await load();
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to add draw");
    }
  }

  async function remove(p: LoanPayment) {
    if (!confirm(`Delete this entry of ${formatCurrency(p.total_amount)} on ${p.payment_date}? The balance will be reversed.`)) return;
    try {
      await apiDelete(`/loans/${loanId}/payments/${p.id}`);
      await load();
      onChange();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Draws &amp; payments ({items.length})</p>
        {canManage ? (
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={() => { setShowDraw((s) => !s); setShowAdd(false); }} title="Record a cash-advance / line draw — increases the balance" style={{ padding: "4px 10px", fontSize: 12 }}>{showDraw ? "Cancel" : "⬆ Draw"}</button>
            <button type="button" onClick={() => { setShowAdd((s) => !s); setShowDraw(false); }} title="Record a repayment — decreases the balance" style={{ padding: "4px 10px", fontSize: 12 }}>{showAdd ? "Cancel" : "⬇ Payment"}</button>
          </div>
        ) : null}
      </div>
      {showDraw && canManage ? (
        <form onSubmit={addDraw} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 2fr 90px", gap: 6, marginBottom: 8, alignItems: "end" }}>
          <label style={{ fontSize: 11 }}>Draw date<input type="date" required value={drawForm.draw_date} onChange={(e) => setDrawForm({ ...drawForm, draw_date: e.target.value })} /></label>
          <label style={{ fontSize: 11 }}>Amount<input type="number" step="0.01" required value={drawForm.amount} onChange={(e) => setDrawForm({ ...drawForm, amount: e.target.value })} placeholder="cash advance $" /></label>
          <label style={{ fontSize: 11 }}>Notes<input value={drawForm.notes} onChange={(e) => setDrawForm({ ...drawForm, notes: e.target.value })} placeholder="e.g. payroll 6/25 via N26" /></label>
          <button type="submit" style={{ padding: "6px 8px", fontSize: 12 }}>⬆ Add draw</button>
        </form>
      ) : null}
      {showAdd && canManage ? (
        <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr 80px", gap: 6, marginBottom: 8, alignItems: "end" }}>
          <label style={{ fontSize: 11 }}>Date<input type="date" required value={form.payment_date} onChange={(e) => setForm({ ...form, payment_date: e.target.value })} /></label>
          <label style={{ fontSize: 11 }}>Total<input type="number" step="0.01" required value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} /></label>
          <label style={{ fontSize: 11 }}>Principal<input type="number" step="0.01" value={form.principal_amount} onChange={(e) => setForm({ ...form, principal_amount: e.target.value })} placeholder="(auto if blank)" /></label>
          <label style={{ fontSize: 11 }}>Interest<input type="number" step="0.01" value={form.interest_amount} onChange={(e) => setForm({ ...form, interest_amount: e.target.value })} /></label>
          <label style={{ fontSize: 11 }}>Fees<input type="number" step="0.01" value={form.fees_amount} onChange={(e) => setForm({ ...form, fees_amount: e.target.value })} /></label>
          <button type="submit" style={{ padding: "6px 8px", fontSize: 12 }}>Add</button>
          <label style={{ fontSize: 11, gridColumn: "1 / span 6" }}>Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" /></label>
        </form>
      ) : null}
      {loading ? <p className="aq-lite-muted" style={{ fontSize: 12 }}>Loading…</p> : items.length === 0 ? (
        <p className="aq-lite-muted" style={{ fontSize: 12 }}>No payments recorded yet.</p>
      ) : (
        <table className="aq-lite-table" style={{ fontSize: 12 }}>
          <thead><tr><th>Date</th><th style={{ textAlign: "right" }}>Total</th><th style={{ textAlign: "right" }}>Principal</th><th style={{ textAlign: "right" }}>Interest</th><th style={{ textAlign: "right" }}>Fees</th><th>Notes</th>{canManage ? <th data-disable-sort="true" style={{ width: 70 }}></th> : null}</tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.payment_date}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(p.total_amount)}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(p.principal_amount)}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(p.interest_amount)}</td>
                <td style={{ textAlign: "right" }}>{formatCurrency(p.fees_amount)}</td>
                <td style={{ color: "var(--aq-muted)" }}>{p.notes || "—"}</td>
                {canManage ? <td><button type="button" onClick={() => remove(p)} style={{ padding: "2px 8px", fontSize: 11, background: "transparent", color: "var(--aq-red)", border: "1px solid var(--aq-border)", boxShadow: "none", whiteSpace: "nowrap" }}>Delete</button></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
