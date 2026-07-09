"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

type Gap = {
  id: number;
  question: string;
  status: "partial" | "unanswered";
  missing_data?: string | null;
  suggested_source?: string | null;
  answer_preview?: string | null;
  asked_by?: string | null;
  created_at?: string | null;
  resolved: boolean;
  resolved_at?: string | null;
  resolved_note?: string | null;
};

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const s = /[Z+]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z";
  const t = new Date(s).getTime();
  if (isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d}d ago` : new Date(s).toLocaleDateString();
}

export default function DataGaps() {
  const [items, setItems] = useState<Gap[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [includeResolved, setIncludeResolved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback((withResolved: boolean) => {
    apiGet<{ open_count: number; items: Gap[] }>(`/assistant/gaps?include_resolved=${withResolved ? "true" : "false"}`)
      .then((r) => {
        setItems(r.items || []);
        setOpenCount(r.open_count || 0);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    load(includeResolved);
  }, [includeResolved, load]);

  async function toggleResolved(g: Gap) {
    const next = !g.resolved;
    setItems((xs) => xs.map((x) => (x.id === g.id ? { ...x, resolved: next } : x)));
    setOpenCount((c) => Math.max(0, c + (next ? -1 : 1)));
    try {
      await apiPost("/assistant/gaps/resolve", { id: g.id, resolved: next });
    } catch {
      load(includeResolved); // revert to server truth on failure
    }
  }

  // Nothing to show and nothing resolved to browse — stay out of the way.
  if (loaded && openCount === 0 && !includeResolved && items.length === 0) {
    return (
      <section className="aq-lite-panel" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6 }}>Data gaps</div>
        <h3 style={{ margin: "2px 0 6px", fontSize: 18 }}>
          Questions the assistant couldn’t answer <span style={{ opacity: 0.6, fontWeight: 400 }}>✓ none open</span>
        </h3>
        <p className="aq-lite-muted" style={{ fontSize: 13, margin: 0 }}>
          Every question asked so far was answerable from the current data.{" "}
          <button
            type="button"
            onClick={() => setIncludeResolved(true)}
            style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", textDecoration: "underline", opacity: 0.7, fontSize: 13, padding: 0 }}
          >
            Show addressed
          </button>
        </p>
      </section>
    );
  }

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 0.4, textTransform: "uppercase", opacity: 0.6 }}>Data gaps</div>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>
            Questions the assistant couldn’t answer
            {openCount > 0 && (
              <span
                style={{
                  marginLeft: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#b9760f",
                  background: "rgba(245,158,11,0.14)",
                  border: "1px solid rgba(245,158,11,0.35)",
                  borderRadius: 999,
                  padding: "2px 9px",
                  verticalAlign: "middle",
                }}
              >
                {openCount} open
              </span>
            )}
          </h3>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, opacity: 0.75, cursor: "pointer" }}>
          <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
          Show addressed
        </label>
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "4px 0 10px" }}>
        Each is a question someone asked <em>Ask AqtPM</em> that the app’s data couldn’t answer — and what to add so it can.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((g) => (
          <div
            key={g.id}
            style={{
              padding: "11px 13px",
              borderRadius: 10,
              border: "1px solid var(--aq-border, rgba(0,0,0,0.10))",
              background: g.resolved ? "transparent" : "rgba(245,158,11,0.06)",
              opacity: g.resolved ? 0.6 : 1,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
              <div style={{ fontWeight: 650, fontSize: 14.5 }}>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.3,
                    color: g.status === "unanswered" ? "#b42318" : "#b9760f",
                    marginRight: 7,
                  }}
                >
                  {g.status === "unanswered" ? "Unanswered" : "Partial"}
                </span>
                {g.question}
              </div>
              <button
                type="button"
                onClick={() => toggleResolved(g)}
                style={{
                  flex: "none",
                  border: "1px solid var(--aq-border, rgba(0,0,0,0.15))",
                  background: g.resolved ? "transparent" : "var(--aq-row-head-bg, rgba(59,130,246,0.08))",
                  color: "inherit",
                  borderRadius: 999,
                  padding: "3px 11px",
                  fontSize: 12,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {g.resolved ? "↩ Reopen" : "✓ Mark addressed"}
              </button>
            </div>
            {g.missing_data && (
              <div style={{ fontSize: 13, marginTop: 5 }}>
                <span style={{ opacity: 0.6 }}>Missing:</span> {g.missing_data}
              </div>
            )}
            {g.suggested_source && (
              <div style={{ fontSize: 13, marginTop: 2 }}>
                <span style={{ opacity: 0.6 }}>Add:</span> <strong>{g.suggested_source}</strong>
              </div>
            )}
            <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 5 }}>
              asked{g.asked_by ? ` by ${g.asked_by}` : ""} · {relTime(g.created_at)}
              {g.resolved && g.resolved_at ? ` · addressed ${relTime(g.resolved_at)}` : ""}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
