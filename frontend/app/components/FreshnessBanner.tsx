"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";

type Src = { key: string; label: string; last_synced_at: string | null; age_hours: number | null; status: string; detail?: string };
type Fresh = { sources: Src[]; overall: string; as_of: string };

const DOT: Record<string, string> = {
  ok: "#10b981", connected: "#10b981", stale: "#f59e0b",
  error: "#ef4444", reauth_required: "#ef4444",
};

function ageLabel(h: number | null): string {
  if (h == null) return "never";
  if (h < 1) return "just now";
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function FreshnessBanner() {
  const [f, setF] = useState<Fresh | null>(null);
  useEffect(() => {
    const load = () => apiGet<Fresh>("/integrations/freshness").then(setF).catch(() => {});
    load();
    const id = setInterval(load, 300_000); // refresh every 5 min
    return () => clearInterval(id);
  }, []);
  if (!f || !f.sources.length) return null;
  const bad = f.overall !== "ok";
  // Colors come from the `.aq-freshness` classes in globals.css, which set an
  // explicit, theme-aware background + text pair per light/dark mode. (The prior
  // approach used var(--aq-card)/var(--aq-text): the near-white card blended into
  // the page gradient and the muted label washed out.)
  return (
    <div
      className={`aq-freshness${bad ? " aq-freshness--stale" : ""}`}
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "8px 14px", borderRadius: 10, marginBottom: 10, fontSize: 13,
      }}
    >
      <span className="aq-freshness-label">Data freshness</span>
      {f.sources.map((s) => (
        <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title={s.detail || ""}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[s.status] || "#9ca3af", flex: "none" }} />
          {s.label}: <strong>{ageLabel(s.age_hours)}</strong>
          {(s.status === "reauth_required" || s.status === "error") && (
            <span className="aq-freshness-alert">· needs reconnect</span>
          )}
        </span>
      ))}
    </div>
  );
}
