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
  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
        padding: "6px 14px", borderRadius: 10, marginBottom: 10, fontSize: 12.5,
        background: bad ? "rgba(245,158,11,0.12)" : "var(--aq-input-bg, rgba(0,0,0,0.04))",
        border: bad ? "1px solid rgba(245,158,11,0.35)" : "1px solid var(--aq-border, rgba(0,0,0,0.08))",
      }}
    >
      <span style={{ fontWeight: 700, opacity: 0.7, textTransform: "uppercase", letterSpacing: 0.4, fontSize: 11 }}>
        Data freshness
      </span>
      {f.sources.map((s) => (
        <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title={s.detail || ""}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: DOT[s.status] || "#9ca3af" }} />
          {s.label}: <strong>{ageLabel(s.age_hours)}</strong>
          {(s.status === "reauth_required" || s.status === "error") && (
            <span style={{ color: "#ef4444", fontWeight: 600 }}>· needs reconnect</span>
          )}
        </span>
      ))}
    </div>
  );
}
