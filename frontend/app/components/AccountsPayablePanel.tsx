"use client";

import { AccountsPayable, formatCurrency, formatDate } from "./workspaceShared";

const CAT_LABEL: Record<string, string> = {
  financing: "Financing",
  credit_card: "Credit card",
  salary: "Unpaid wages",
  owner_comp: "Deferred owner comp",
};
const CAT_COLOR: Record<string, string> = {
  financing: "#b42318",
  credit_card: "#d1561b",
  salary: "#8a5b1f",
  owner_comp: "#6b5bd1",
};

/** What the business owes — by entity, with a description — plus the net position. */
export function AccountsPayablePanel({ payable, owedToYou }: { payable: AccountsPayable | null; owedToYou: number }) {
  if (!payable) {
    return (
      <section className="aq-lite-panel">
        <p className="aq-lite-eyebrow">You owe · A/P</p>
        <p className="aq-lite-muted" style={{ marginTop: 8 }}>Loading…</p>
      </section>
    );
  }
  const net = owedToYou - payable.total;
  const ownerComp = payable.owner_comp ?? [];
  const ownerTotal = payable.total_owner_comp ?? 0;
  const asOf = formatDate(payable.as_of);
  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">You owe · A/P</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 32, color: "#b42318", lineHeight: 1.05 }}>
            {formatCurrency(payable.total)}
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, margin: "3px 0 0" }}>
            {formatCurrency(payable.total_financing)} financing · {formatCurrency(payable.total_salary)} unpaid wages
          </p>
          <p className="aq-lite-muted" style={{ fontSize: 10.5, margin: "2px 0 0", opacity: 0.7 }}>
            Loan balances as of {asOf}
            {payable.wages_week_end ? ` · wages: week ending ${formatDate(payable.wages_week_end)} + back-wages` : " · wages current"}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="aq-lite-muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
          Owed by entity
        </div>
        {payable.items.length === 0 ? (
          <p className="aq-lite-muted" style={{ fontSize: 13 }}>Nothing owed — no open loans or unpaid wages.</p>
        ) : payable.items.map((it, i) => (
          <div key={`${it.entity}-${i}`} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 10, padding: "8px 4px", borderBottom: "1px solid rgba(128,128,128,0.14)" }}>
            <div>
              <strong style={{ fontSize: 14 }}>{it.entity}</strong>
              <span style={{
                fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4,
                marginLeft: 8, padding: "1px 6px", borderRadius: 6,
                color: CAT_COLOR[it.category] || "#666", background: `${CAT_COLOR[it.category] || "#666"}18`,
              }}>
                {CAT_LABEL[it.category] || it.category}
              </span>
              <div className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 2 }}>{it.description}</div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#b42318", textAlign: "right" }}>{formatCurrency(it.amount)}</div>
          </div>
        ))}
      </div>

      {/* Deferred owner comp — memo only, NOT part of the A/P total */}
      {ownerComp.length > 0 && (
        <div style={{
          marginTop: 14, padding: "12px 14px", borderRadius: 12,
          background: "rgba(107,91,209,0.07)", border: "1px dashed rgba(107,91,209,0.4)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, color: "#6b5bd1", fontWeight: 700 }}>
              Deferred owner comp <span style={{ fontWeight: 500, textTransform: "none", opacity: 0.8 }}>· memo, not in A/P</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#6b5bd1" }}>{formatCurrency(ownerTotal)}</div>
          </div>
          {ownerComp.map((it, i) => (
            <div key={`owner-${i}`} className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              <strong style={{ color: "inherit" }}>{it.entity}</strong> — {it.description}
            </div>
          ))}
        </div>
      )}

      {/* Net position — the one number that says where you stand */}
      <div style={{
        marginTop: 16, padding: "14px 16px", borderRadius: 12,
        background: net >= 0 ? "rgba(31,138,91,0.08)" : "rgba(180,35,24,0.08)",
        border: `1px solid ${net >= 0 ? "rgba(31,138,91,0.3)" : "rgba(180,35,24,0.3)"}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.7 }}>Net position</div>
          <div className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            {formatCurrency(owedToYou)} owed to you − {formatCurrency(payable.total)} you owe
          </div>
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, color: net >= 0 ? "#1f8a5b" : "#b42318" }}>
          {net < 0 ? "−" : ""}{formatCurrency(Math.abs(net))}
        </div>
      </div>
    </section>
  );
}
