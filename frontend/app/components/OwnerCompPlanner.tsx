"use client";

import { OwnerCompPlanner as Planner, formatCurrency, formatDate } from "./workspaceShared";

/** Owner salary-vs-distribution planner: when worked-hours salary maxes the 401(k)
 * and absorbs distributions taken, plus the FICA-cost vs 401(k)-tax-saving netting.
 * 401(k) deferrals cut income tax, NOT FICA — the two are shown in separate columns. */
export function OwnerCompPlanner({ plan }: { plan: Planner | null }) {
  if (!plan || !plan.available) return null;
  const m = plan.milestones;
  const t = plan.tiers;
  const k = plan.k401;
  const rate = Math.round((plan.marginal_rate ?? 0.37) * 100);

  const Milestone = ({ label, ms, hint }: { label: string; ms?: { date: string | null; reached: boolean; salary: number }; hint: string }) => (
    <div style={{ flex: "1 1 180px", padding: "10px 12px", borderRadius: 10, background: "rgba(31,138,91,0.06)", border: "1px solid rgba(31,138,91,0.25)" }}>
      <div className="aq-lite-muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>
        {ms?.date ? formatDate(ms.date) : "—"}
        {ms?.reached ? <span style={{ fontSize: 11, color: "#1f8a5b", marginLeft: 6 }}>✓ reached</span> : <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 6 }}>projected</span>}
      </div>
      <div className="aq-lite-muted" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>
    </div>
  );

  const TierRow = ({ name, tier, note }: { name: string; tier?: { salary: number; added_fica: number; income_tax_saving: number; net: number }; note: string }) => (
    <tr style={{ borderTop: "1px solid rgba(128,128,128,0.14)" }}>
      <td style={{ padding: "6px 4px" }}>
        <strong style={{ fontSize: 13 }}>{name}</strong>
        <div className="aq-lite-muted" style={{ fontSize: 11 }}>{note}</div>
      </td>
      <td style={{ textAlign: "right", padding: "6px 4px", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(tier?.salary)}</td>
      <td style={{ textAlign: "right", padding: "6px 4px", color: "#b42318", fontVariantNumeric: "tabular-nums" }}>-{formatCurrency(tier?.added_fica)}</td>
      <td style={{ textAlign: "right", padding: "6px 4px", color: "#1f8a5b", fontVariantNumeric: "tabular-nums" }}>+{formatCurrency(tier?.income_tax_saving)}</td>
      <td style={{ textAlign: "right", padding: "6px 4px", fontWeight: 800, color: (tier?.net ?? 0) >= 0 ? "#1f8a5b" : "#b42318", fontVariantNumeric: "tabular-nums" }}>
        {(tier?.net ?? 0) < 0 ? "-" : "+"}{formatCurrency(Math.abs(tier?.net ?? 0))}
      </td>
    </tr>
  );

  const maxCum = Math.max(1, ...(plan.months ?? []).map((x) => x.cum_salary));

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Owner comp planner</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 20 }}>Salary vs. distributions — when to switch</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12, margin: "3px 0 0" }}>
            {plan.ytd_hours} hrs YTD @ {formatCurrency(plan.rate)}/hr = {formatCurrency(plan.ytd_salary)} · ~{plan.avg_hours_week} hrs/wk
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>
        <Milestone label="401(k) maxed" ms={m?.k401_max} hint={`salary >= ${formatCurrency(k?.gross_salary_to_max)} (defers ${formatCurrency(k?.max)})`} />
        <Milestone label="Distributions absorbed" ms={m?.distributions_absorbed} hint={`salary = ${formatCurrency(plan.net_distributions)} net taken`} />
        <Milestone label="Reasonable-comp target" ms={m?.reasonable_comp} hint={`salary = ${formatCurrency(206398)}`} />
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 10 }}>
        Pay yourself salary for worked hours; once cumulative salary passes the markers above you can switch back to distributions.
        After <strong>{formatCurrency(plan.ss_wage_base)}</strong> of salary, Social Security stops — the rest is Medicare-only (2.9%).
      </p>

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        <div className="aq-lite-muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
          FICA cost vs. 401(k) income-tax saving <span style={{ textTransform: "none" }}>(at {rate}% marginal)</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr className="aq-lite-muted" style={{ fontSize: 11, textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "2px 4px" }}>Play</th>
              <th style={{ padding: "2px 4px" }}>Salary</th>
              <th style={{ padding: "2px 4px" }}>+ FICA</th>
              <th style={{ padding: "2px 4px" }}>401(k) tax saving</th>
              <th style={{ padding: "2px 4px" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            <TierRow name="Max the 401(k)" tier={t?.max_401k} note="minimum salary to fully defer" />
            <TierRow name="Absorb all distributions" tier={t?.absorb_distributions} note="reasonable-comp level" />
          </tbody>
        </table>
        <p className="aq-lite-muted" style={{ fontSize: 10.5, marginTop: 6, opacity: 0.8 }}>
          401(k) deferrals reduce income tax, not FICA. Net = 401(k) saving - added FICA (vs. taking it as distribution). Figures are incremental over the {formatCurrency(plan.w2_drawn)} W-2 already drawn. Confirm the marginal rate with your CPA - a 2025 NOL/loss carryforward could change it.
        </p>
      </div>

      {plan.months && plan.months.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="aq-lite-muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Cumulative salary by month</div>
          {plan.months.map((row) => (
            <div key={row.month} style={{ display: "grid", gridTemplateColumns: "56px 1fr 90px", alignItems: "center", gap: 8, padding: "2px 0" }}>
              <span className="aq-lite-muted" style={{ fontSize: 11 }}>{row.month}</span>
              <div style={{ height: 10, borderRadius: 5, background: "rgba(128,128,128,0.12)", overflow: "hidden" }}>
                <div style={{ width: `${(row.cum_salary / maxCum) * 100}%`, height: "100%", background: "#1f8a5b" }} />
              </div>
              <span style={{ fontSize: 11.5, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(row.cum_salary)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
