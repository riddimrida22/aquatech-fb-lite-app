"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatDate, formatNumber } from "./workspaceShared";

type Item = { project: string; entries: number; hours: number; first: string | null; last: string | null };
type Data = {
  fb_hours: number;
  fb_entries: number;
  aquatech_hours: number;
  aquatech_entries: number;
  pct_migrated: number;
  items: Item[];
};

const AMBER = "#b9760f";
const GREEN = "#1f8a5b";

export default function FreshBooksHours() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<Data>("/reports/freshbooks-hours").then(setData).catch((e) => setErr(e?.message || "Could not load"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (err || !data) return null;
  // Nothing left in FreshBooks → the transition is complete; hide the panel.
  if (data.fb_hours <= 0) return null;

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>FreshBooks cut-over</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>
            FreshBooks hours <span style={{ opacity: 0.6, fontWeight: 400, fontSize: 14 }}>· transitional</span>
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 620 }}>
            Time still coming from FreshBooks (quarantined, not in your work subtasks). Shrinks as the team logs in the app; retired at cut-over.
          </p>
        </div>
        <span style={{ fontSize: 13, opacity: 0.7 }}>{open ? "Hide ▲" : "Show ▼"}</span>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
        <Stat label="FreshBooks hours" value={`${formatNumber(data.fb_hours, 0)}h`} sub={`${data.fb_entries} entries`} color={AMBER} />
        <Stat label="Aquatech hours" value={`${formatNumber(data.aquatech_hours, 0)}h`} sub={`${data.aquatech_entries} entries`} color={GREEN} />
        <div style={{ flex: "1 1 160px", minWidth: 140 }}>
          <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6 }}>Migrated to app</div>
          <div style={{ fontSize: 20, fontWeight: 750 }}>{data.pct_migrated.toFixed(0)}%</div>
          <div style={{ height: 7, borderRadius: 5, background: "rgba(128,128,128,0.18)", overflow: "hidden", marginTop: 4 }}>
            <div style={{ height: "100%", width: `${Math.min(100, data.pct_migrated)}%`, background: GREEN }} />
          </div>
        </div>
      </div>

      {open ? (
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(128,128,128,0.3)" }}>
                {["Project", "FB hours", "Entries", "First", "Last"].map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3, opacity: 0.65 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.project} style={{ borderBottom: "1px solid rgba(128,128,128,0.12)" }}>
                  <td style={{ textAlign: "left", padding: "6px 10px", fontSize: 13, fontWeight: 600 }}>{it.project}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13 }}>{formatNumber(it.hours, 1)}h</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 13, opacity: 0.75 }}>{it.entries}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 12, opacity: 0.7 }}>{it.first ? formatDate(it.first) : "—"}</td>
                  <td style={{ textAlign: "right", padding: "6px 10px", fontSize: 12, opacity: 0.7 }}>{it.last ? formatDate(it.last) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div style={{ flex: "1 1 150px", minWidth: 130 }}>
      <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 750, color }}>{value}</div>
      <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 2 }}>{sub}</div>
    </div>
  );
}
