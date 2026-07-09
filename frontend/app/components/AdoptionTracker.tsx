"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "../../lib/api";
import { formatDate, formatNumber } from "./workspaceShared";

type AdoptionItem = {
  user_id: number;
  name: string;
  email: string;
  hours: number;
  entries: number;
  has_logged: boolean;
  timesheet_status: string;
  last_entry_at: string | null;
};

type Adoption = {
  week_start: string;
  week_end: string;
  logged: number;
  total: number;
  items: AdoptionItem[];
};

const GREEN = "#1f8a5b";
const AMBER = "#b9760f";

// Monday of the week containing `d` (ISO yyyy-mm-dd), local.
function mondayIso(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function AdoptionTracker() {
  const [data, setData] = useState<Adoption | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState<string>(() => mondayIso(new Date()));

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    apiGet<Adoption>(`/timesheets/adoption?week_start=${weekStart}`)
      .then((r) => {
        setData(r);
        setLoading(false);
      })
      .catch((e) => {
        setErr(e?.message || "Could not load");
        setLoading(false);
      });
  }, [weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  const pct = useMemo(() => (data && data.total ? Math.round((data.logged / data.total) * 100) : 0), [data]);

  function shiftWeek(dir: -1 | 1) {
    const d = new Date(weekStart + "T00:00:00");
    d.setDate(d.getDate() + dir * 7);
    setWeekStart(mondayIso(d));
  }

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>FreshBooks cut-over</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>In-app time — who&apos;s logged this week</h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 560 }}>
            Everyone who has entered time <em>in the app</em> for the week. Chase the “not yet” names to finish the switch off FreshBooks.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={() => shiftWeek(-1)} aria-label="Previous week" style={{ padding: "4px 9px" }}>‹</button>
          <button type="button" onClick={() => setWeekStart(mondayIso(new Date()))} style={{ padding: "4px 9px" }}>This week</button>
          <button type="button" onClick={() => shiftWeek(1)} aria-label="Next week" style={{ padding: "4px 9px" }}>›</button>
        </div>
      </div>

      {err ? (
        <p style={{ color: "#b42318", fontSize: 13, marginTop: 12 }}>Couldn&apos;t load adoption: {err}</p>
      ) : !data ? (
        <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 12 }}>{loading ? "Loading…" : "No data."}</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 22, color: data.logged === data.total ? GREEN : AMBER }}>
              {data.logged}/{data.total}
            </strong>
            <span className="aq-lite-muted" style={{ fontSize: 13 }}>
              logged in-app · week of {formatDate(data.week_start)} – {formatDate(data.week_end)}
            </span>
            <div style={{ flex: 1, minWidth: 120, height: 8, borderRadius: 6, background: "rgba(128,128,128,0.18)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: data.logged === data.total ? GREEN : AMBER }} />
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            {data.items.map((it) => (
              <div
                key={it.user_id}
                title={it.has_logged ? `${it.entries} entries · last ${it.last_entry_at ? new Date(it.last_entry_at).toLocaleString() : "—"}` : "No app entries this week — still on FreshBooks?"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 11px",
                  borderRadius: 999,
                  fontSize: 13,
                  border: `1px solid ${it.has_logged ? "rgba(31,138,91,0.35)" : "rgba(245,158,11,0.35)"}`,
                  background: it.has_logged ? "rgba(31,138,91,0.08)" : "rgba(245,158,11,0.08)",
                }}
              >
                <span style={{ color: it.has_logged ? GREEN : AMBER, fontWeight: 700 }}>{it.has_logged ? "✓" : "○"}</span>
                <span style={{ fontWeight: 600 }}>{it.name}</span>
                {it.has_logged ? (
                  <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{formatNumber(it.hours, 1)}h</span>
                ) : (
                  <span style={{ opacity: 0.7 }}>not yet</span>
                )}
                {it.timesheet_status !== "none" && it.timesheet_status !== "draft" ? (
                  <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.3, opacity: 0.7 }}>
                    · {it.timesheet_status}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
