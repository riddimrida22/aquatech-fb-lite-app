"use client";

import { CashFlow } from "./workspaceShared";

type Grp = { group: string; amount: number };
type CogsBreak = {
  gross_wages?: number;
  employer_payroll_taxes?: number;
  employer_401k_match?: number;
  benefits_workers_comp?: number;
  direct_project_costs?: number;
};

export type BusinessHealth = {
  period: { start: string; end: string };
  basis?: string;
  cash_in: {
    business_revenue: number;
    borrowed_boc: number;
    borrowed_fundbox: number;
    borrowed_total: number;
    owner_contributions: number;
  };
  financing_cost: { interest: number; fees: number; total: number; note?: string };
  waterfall: {
    revenue: number;
    cogs: number;
    cogs_breakdown: CogsBreak;
    gross_profit: number;
    gross_margin?: number;
    indirect_total: number;
    indirect_by_group: Grp[];
    operating_income: number;
    financing_cost: number;
    net_income: number;
    net_margin?: number;
  };
  shareholder: {
    distributions_out: number;
    contributions_in: number;
    net_distributions: number;
    note?: string;
  };
  debt_outstanding: { lines: { name: string; balance: number }[]; total: number };
};

function money(n: number | undefined | null): string {
  return Number(n || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function pct(n: number | undefined | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

const BORDER = "1px solid rgba(128,128,128,0.28)";
const dimRow = { opacity: 0.6 } as const;
const subRow = { opacity: 0.55, fontSize: "0.82em" } as const;
const totalRow = { borderTop: BORDER, paddingTop: "0.35rem", fontWeight: 700 } as const;
const grandRow = { borderTop: "2px solid rgba(128,128,128,0.45)", paddingTop: "0.4rem", fontWeight: 700, fontSize: "1.05em" } as const;
const negStrong = { opacity: 0.85 } as const;

/* ─────────────────────────────────────────────────────────────
   PANEL 1 — PROFIT & LOSS
   Pure operating profitability: client revenue → COGS → indirect → net.
   No borrowed cash here (that lives in the Cash Flow panel).
   ───────────────────────────────────────────────────────────── */
function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(ms / 86400000) + 1);
}

export function ProfitLossPanel({
  data,
  ownerAnnualSalary,
  onOwnerSalaryChange,
}: {
  data: BusinessHealth | null;
  ownerAnnualSalary: number;
  onOwnerSalaryChange: (n: number) => void;
}) {
  if (!data) return null;
  const w = data.waterfall;
  const cb = w.cogs_breakdown || {};
  const basisLabel = (data.basis || "cash") === "accrual" ? "Accrual — invoiced" : "Cash — collected from clients";
  const annual = ownerAnnualSalary || 0;
  // Imputed comp for the DISPLAYED period (prorate annual salary by period days).
  const periodDays = daysBetween(data.period.start, data.period.end);
  const impPeriod = annual * (periodDays / 365);
  const adjNet = w.net_income - impPeriod;
  const adjMargin = w.revenue ? adjNet / w.revenue : null;
  // 2026 salary accrual tracker (Jan 1 → period end as "as of").
  const elapsed2026 = Math.min(365, daysBetween("2026-01-01", data.period.end));
  const owedSoFar = annual * (elapsed2026 / 365);
  const remaining2026 = Math.max(0, annual - owedSoFar);
  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Profit &amp; Loss</p>
          <h3>What the business earned</h3>
        </div>
        <span style={{ opacity: 0.6, fontSize: "0.82em" }}>
          {basisLabel} · {data.period.start} → {data.period.end}
        </span>
      </div>

      <div className="aq-lite-stat-list">
        <div>
          <span>Revenue — client invoicing</span>
          <strong>{money(w.revenue)}</strong>
        </div>
        <div>
          <span>− Total COGS (direct cost of work)</span>
          <strong style={negStrong}>({money(w.cogs)})</strong>
        </div>
        <div style={subRow}>
          <span>
            wages {money(cb.gross_wages)} · payroll tax {money(cb.employer_payroll_taxes)} · 401k{" "}
            {money(cb.employer_401k_match)} · benefits {money(cb.benefits_workers_comp)} · direct{" "}
            {money(cb.direct_project_costs)}
          </span>
        </div>
        <div style={totalRow}>
          <span>= Gross profit</span>
          <strong>
            {money(w.gross_profit)} · {pct(w.gross_margin)}
          </strong>
        </div>
        <div>
          <span>− Total indirect expenses</span>
          <strong style={negStrong}>({money(w.indirect_total)})</strong>
        </div>
        {(w.indirect_by_group || []).map((g) => (
          <div style={subRow} key={g.group}>
            <span>{g.group}</span>
            <span>{money(g.amount)}</span>
          </div>
        ))}
        <div style={totalRow}>
          <span>= Operating income</span>
          <strong>{money(w.operating_income)}</strong>
        </div>
        <div>
          <span>− Financing cost (loan interest &amp; fees)</span>
          <strong style={negStrong}>({money(w.financing_cost)})</strong>
        </div>
        <div style={grandRow}>
          <span>= Net income</span>
          <strong>
            {money(w.net_income)} · {pct(w.net_margin)}
          </strong>
        </div>
      </div>

      {/* Owner salary — value the principal's labor (taken as distributions, not
          W-2 salary) and track the 2026 accrual. */}
      <div style={{ marginTop: "0.85rem", padding: "0.6rem 0.7rem", borderRadius: 8, background: "rgba(150,120,90,0.10)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.82em", opacity: 0.8 }}>Owner salary (annual):</span>
          <span style={{ fontSize: "0.85em" }}>$</span>
          <input
            type="number"
            value={annual}
            min={0}
            step={1000}
            onChange={(e) => onOwnerSalaryChange(Number(e.target.value) || 0)}
            style={{ width: 130, fontSize: "0.85em", padding: "0.15rem 0.35rem" }}
          />
          <span style={{ fontSize: "0.78em", opacity: 0.55 }}>/ yr</span>
        </div>
        {annual ? (
          <div className="aq-lite-stat-list" style={{ marginTop: "0.5rem" }}>
            <div style={dimRow}>
              <span>Owed to you so far (2026, {elapsed2026} days)</span>
              <strong>{money(owedSoFar)}</strong>
            </div>
            <div style={dimRow}>
              <span>Remaining to be paid in 2026</span>
              <strong>{money(remaining2026)}</strong>
            </div>
            <div style={{ ...totalRow, opacity: 0.85 }}>
              <span>Salary cost this period ({periodDays} days)</span>
              <strong style={negStrong}>({money(impPeriod)})</strong>
            </div>
            <div style={{ ...grandRow, borderTopColor: "rgba(150,120,90,0.45)" }}>
              <span>= Net after owner salary</span>
              <strong>
                {money(adjNet)} · {pct(adjMargin)}
              </strong>
            </div>
          </div>
        ) : (
          <p style={{ ...subRow, marginTop: "0.35rem" }}>
            Set a market salary to see your real operating margin and 2026 accrual.
          </p>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────
   PANEL 2 — CASH FLOW STATEMENT (separate)
   Where cash actually moved: operating, financing (borrowing), owner.
   Always cash basis by definition.
   ───────────────────────────────────────────────────────────── */
export function CashFlowPanel({
  data,
  debt,
}: {
  data: CashFlow | null;
  debt?: BusinessHealth["debt_outstanding"] | null;
}) {
  if (!data) return null;
  const op = data.operating;
  const fin = data.financing;
  const own = data.owner;
  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Cash Flow</p>
          <h3>Where the cash actually moved</h3>
        </div>
        <span style={{ opacity: 0.6, fontSize: "0.82em" }}>
          cash basis · {data.period.start} → {data.period.end}
        </span>
      </div>

      <div className="aq-lite-stat-list">
        {/* Operating */}
        <div style={{ fontWeight: 600, opacity: 0.75 }}>
          <span>OPERATING</span>
          <span />
        </div>
        <div style={dimRow}>
          <span>Collected from clients</span>
          <strong>{money(op.cash_in_invoices)}</strong>
        </div>
        <div style={dimRow}>
          <span>− Payroll paid (wages + taxes)</span>
          <strong style={negStrong}>({money(op.cash_out_payroll ?? 0)})</strong>
        </div>
        <div style={dimRow}>
          <span>− Other operating costs paid</span>
          <strong style={negStrong}>({money(op.cash_out_opex ?? op.cash_out_opex_and_payroll)})</strong>
        </div>
        <div style={totalRow}>
          <span>= Operating cash flow</span>
          <strong>{money(op.net)}</strong>
        </div>

        {/* Financing */}
        <div style={{ fontWeight: 600, opacity: 0.75, marginTop: "0.5rem" }}>
          <span>FINANCING (borrowing — not revenue)</span>
          <span />
        </div>
        <div style={dimRow}>
          <span>+ Borrowed — BOC</span>
          <strong>{money(fin.loan_proceeds_boc)}</strong>
        </div>
        <div style={dimRow}>
          <span>+ Borrowed — Fundbox</span>
          <strong>{money(fin.loan_proceeds_fundbox)}</strong>
        </div>
        <div style={dimRow}>
          <span>− Loan payments (incl. Forward MCA)</span>
          <strong style={negStrong}>({money(fin.loan_payments_total)})</strong>
        </div>
        <div style={totalRow}>
          <span>= Financing cash flow</span>
          <strong>{money(fin.net)}</strong>
        </div>

        {/* Owner */}
        <div style={{ fontWeight: 600, opacity: 0.75, marginTop: "0.5rem" }}>
          <span>OWNER (S-corp equity)</span>
          <span />
        </div>
        <div style={dimRow}>
          <span>+ Capital contributions in</span>
          <strong>{money(own.contributions_in)}</strong>
        </div>
        <div style={dimRow}>
          <span>− Distributions to personal</span>
          <strong style={negStrong}>({money(own.distributions_out)})</strong>
        </div>
        <div style={totalRow}>
          <span>= Owner cash flow</span>
          <strong>{money(own.net)}</strong>
        </div>

        {/* Net change */}
        <div style={grandRow}>
          <span>= Net change in cash</span>
          <strong>{money(data.net_change_in_cash)}</strong>
        </div>
      </div>

      {debt && (debt.lines || []).length > 0 ? (
        <div style={{ marginTop: "1rem" }}>
          <p className="aq-lite-eyebrow">External debt outstanding (as of today)</p>
          <div className="aq-lite-stat-list">
            {(debt.lines || []).map((d) => (
              <div style={dimRow} key={d.name}>
                <span>{d.name}</span>
                <strong>{money(d.balance)}</strong>
              </div>
            ))}
            <div style={totalRow}>
              <span>= Total debt</span>
              <strong>{money(debt.total)}</strong>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
