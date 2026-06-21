"use client";

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
const negStrong = { opacity: 0.85 } as const;

export function BusinessHealthPanel({ data }: { data: BusinessHealth | null }) {
  if (!data) return null;
  const w = data.waterfall;
  const cb = w.cogs_breakdown || {};
  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Business health</p>
          <h3>How the business is actually doing</h3>
        </div>
        <span style={{ opacity: 0.6, fontSize: "0.85em" }}>
          {data.period.start} → {data.period.end}
        </span>
      </div>

      <div className="aq-lite-grid aq-lite-grid-2">
        {/* ① Cash in — real revenue vs borrowed */}
        <div>
          <p className="aq-lite-eyebrow">① Cash in — what&apos;s really revenue</p>
          <div className="aq-lite-stat-list">
            <div>
              <span>Business revenue (earned)</span>
              <strong>{money(data.cash_in.business_revenue)}</strong>
            </div>
            <div style={dimRow}>
              <span>Borrowed — BOC (not revenue)</span>
              <strong>{money(data.cash_in.borrowed_boc)}</strong>
            </div>
            <div style={dimRow}>
              <span>Borrowed — Fundbox (not revenue)</span>
              <strong>{money(data.cash_in.borrowed_fundbox)}</strong>
            </div>
            <div style={dimRow}>
              <span>Owner contributions (your cash)</span>
              <strong>{money(data.cash_in.owner_contributions)}</strong>
            </div>
          </div>
          <p style={{ ...subRow, marginTop: "0.5rem" }}>
            Borrowed cash isn&apos;t income — it&apos;s repaid with the financing cost below.
          </p>
        </div>

        {/* ③ Shareholder distributions + debt */}
        <div>
          <p className="aq-lite-eyebrow">③ Shareholder (S-corp, sole owner)</p>
          <div className="aq-lite-stat-list">
            <div>
              <span>Distributions — drawn to personal</span>
              <strong>{money(data.shareholder.distributions_out)}</strong>
            </div>
            <div style={dimRow}>
              <span>Put back in (contributions)</span>
              <strong>({money(data.shareholder.contributions_in)})</strong>
            </div>
            <div style={totalRow}>
              <span>= Net distributions</span>
              <strong>{money(data.shareholder.net_distributions)}</strong>
            </div>
          </div>
          <p style={{ ...subRow, marginTop: "0.5rem" }}>
            Equity draw — not an expense, not a loan; doesn&apos;t touch net income.
          </p>
        </div>
      </div>

      {/* ② Clean P&L waterfall */}
      <div style={{ marginTop: "1rem" }}>
        <p className="aq-lite-eyebrow">② Clean P&amp;L — revenue down to what&apos;s left</p>
        <div className="aq-lite-stat-list">
          <div>
            <span>Business revenue</span>
            <strong>{money(w.revenue)}</strong>
          </div>
          <div>
            <span>− COGS (direct labor)</span>
            <strong style={negStrong}>({money(w.cogs)})</strong>
          </div>
          <div style={subRow}>
            <span>
              wages {money(cb.gross_wages)} · payroll tax {money(cb.employer_payroll_taxes)} · 401k{" "}
              {money(cb.employer_401k_match)} · benefits {money(cb.benefits_workers_comp)}
            </span>
          </div>
          <div style={totalRow}>
            <span>= Gross profit</span>
            <strong>
              {money(w.gross_profit)} · {pct(w.gross_margin)}
            </strong>
          </div>
          <div>
            <span>− Indirect costs</span>
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
            <span>− Financing cost (loans &amp; fees)</span>
            <strong style={negStrong}>({money(w.financing_cost)})</strong>
          </div>
          <div style={{ ...totalRow, borderTop: "2px solid rgba(128,128,128,0.45)", fontSize: "1.05em" }}>
            <span>= Net business income</span>
            <strong>
              {money(w.net_income)} · {pct(w.net_margin)}
            </strong>
          </div>
        </div>
      </div>

      {/* Debt outstanding strip */}
      <div style={{ marginTop: "1rem" }}>
        <p className="aq-lite-eyebrow">External debt outstanding</p>
        <div className="aq-lite-stat-list">
          {(data.debt_outstanding.lines || []).map((d) => (
            <div style={dimRow} key={d.name}>
              <span>{d.name}</span>
              <strong>{money(d.balance)}</strong>
            </div>
          ))}
          <div style={totalRow}>
            <span>= Total debt</span>
            <strong>{money(data.debt_outstanding.total)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}
