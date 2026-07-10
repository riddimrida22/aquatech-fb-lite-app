"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatCurrency } from "./workspaceShared";

type Emp = {
  user_id: number;
  name: string;
  salary_rate: number;
  client_hours: number;
  overhead_hours: number;
  cost_rate_labor: number;
  cost_rate_loaded: number;
  billing_floor: number;
};
type OverheadRate = {
  window: { start: string; end: string };
  fringe_rate: number;
  overhead_rate: number;
  profit_rate: number;
  pools: { direct_labor: number; indirect_labor: number; nonlabor_opex: number; overhead_pool: number };
  needs_review_in_opex: number;
  employees: Emp[];
  basis: string;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function OverheadRatePanel() {
  const [data, setData] = useState<OverheadRate | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<OverheadRate>("/accounting/overhead-rate").then(setData).catch((e) => setErr(e?.message || "Could not load"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (err || !data) return null;
  const p = data.pools;

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Cost model</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>
            Overhead rate <span style={{ opacity: 0.6, fontWeight: 400, fontSize: 14 }}>· derived from actuals</span>
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 640 }}>
            Non-labor cost pool allocated to each employee&rsquo;s rate. Window {data.window.start} → {data.window.end}. Owner costed at reasonable comp.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{pct(data.overhead_rate)}</div>
          <div style={{ fontSize: 11.5, opacity: 0.6 }}>overhead rate</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14 }}>
        <Pool label="Direct labor (base)" value={p.direct_labor} />
        <Pool label="Indirect labor" value={p.indirect_labor} />
        <Pool label="Non-labor OPEX" value={p.nonlabor_opex} />
        <Pool label="Overhead pool" value={p.overhead_pool} strong />
        <div style={{ flex: "1 1 120px", minWidth: 110 }}>
          <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6 }}>Fringe / Profit</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{pct(data.fringe_rate)} / {pct(data.profit_rate)}</div>
        </div>
      </div>

      {data.needs_review_in_opex > 0 ? (
        <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 10 }}>
          ⚠ {formatCurrency(data.needs_review_in_opex)} of the OPEX pool is still un-reviewed — categorize it to tighten the rate.
        </p>
      ) : null}

      <div style={{ marginTop: 8, fontSize: 13, opacity: 0.75, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide per-employee rates ▲" : "Show per-employee rates ▼"}
      </div>

      {open ? (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                {["Employee", "Salary/h", "+ Fringe", "Loaded (cost)", "Billing floor"].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3, opacity: 0.65 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.user_id} style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}>
                  <td style={{ textAlign: "left", padding: "6px 10px", fontSize: 13, fontWeight: 600 }}>{e.name}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13 }}>{formatCurrency(e.salary_rate)}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13, opacity: 0.8 }}>{formatCurrency(e.cost_rate_labor)}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13, fontWeight: 700 }}>{formatCurrency(e.cost_rate_loaded)}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13 }}>{formatCurrency(e.billing_floor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="aq-lite-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
            Loaded = salary × (1 + fringe) × (1 + overhead). Billing floor = loaded × (1 + profit). {data.basis}.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Pool({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div style={{ flex: "1 1 130px", minWidth: 115 }}>
      <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: strong ? 20 : 18, fontWeight: strong ? 800 : 650 }}>{formatCurrency(value)}</div>
    </div>
  );
}
