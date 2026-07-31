"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

/**
 * Admin-only toggle for whether FreshBooks "transitional" time (the FB-TRANS
 * quarantine bucket + any FreshBooks-imported rows) appears in the time portal.
 * Default is OFF (hidden) so the team enters time only in AqtPM. Rendered only for
 * users with MANAGE_USERS; the backend enforces the same gate.
 *
 * `compact` renders a slim inline row (for the Time header); default renders a full
 * settings panel (for Settings -> Preferences).
 */
export function PortalSettingsPanel({
  canManage,
  compact = false,
}: {
  canManage: boolean;
  compact?: boolean;
}) {
  const [showFb, setShowFb] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    apiGet<{ show_freshbooks_time: boolean }>("/admin/portal-settings")
      .then((r) => setShowFb(!!r.show_freshbooks_time))
      .catch(() => setErr("Could not load the setting."));
  }, [canManage]);

  if (!canManage) return null;

  async function toggle(next: boolean) {
    const prev = showFb;
    setShowFb(next); // optimistic
    setSaving(true);
    setErr(null);
    try {
      const r = await apiPost<{ show_freshbooks_time: boolean }>("/admin/portal-settings", {
        show_freshbooks_time: next,
      });
      setShowFb(!!r.show_freshbooks_time);
    } catch {
      setShowFb(prev);
      setErr("Could not save — try again.");
    } finally {
      setSaving(false);
    }
  }

  const loading = showFb === null && !err;

  if (compact) {
    return (
      <label
        title="Admin only. FreshBooks (transitional) time is hidden from the portal by default; check to show it. Takes effect immediately for everyone."
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12.5,
          padding: "5px 12px",
          borderRadius: 999,
          border: "1px solid var(--aq-border, rgba(0,0,0,0.12))",
          background: "var(--aq-input-bg, rgba(0,0,0,0.04))",
          cursor: loading || saving ? "wait" : "pointer",
          alignSelf: "flex-start",
        }}
      >
        <input
          type="checkbox"
          checked={!!showFb}
          disabled={loading || saving}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          Show FreshBooks (transitional) time{" "}
          <span style={{ opacity: 0.6 }}>· admin{loading ? " · loading…" : showFb ? " · on" : " · off"}</span>
        </span>
        {err ? <span style={{ color: "var(--aq-danger, #c0392b)" }}>· {err}</span> : null}
      </label>
    );
  }

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Time portal · admin</p>
          <h3>FreshBooks time visibility</h3>
        </div>
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 0 }}>
        FreshBooks "transitional" time (the FB‑TRANS quarantine bucket and any
        FreshBooks‑imported hours) is hidden from the time portal by default, so the team
        records time only in AqtPM. Turn this on to show it again. Takes effect immediately
        for everyone.
      </p>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: loading || saving ? "wait" : "pointer",
          fontSize: 14,
        }}
      >
        <input
          type="checkbox"
          checked={!!showFb}
          disabled={loading || saving}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>Show FreshBooks (transitional) time in the time portal</span>
      </label>
      <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 8 }}>
        {loading
          ? "Loading…"
          : showFb
          ? "On — FreshBooks time is visible in the portal."
          : "Off — only time entered in AqtPM shows in the portal."}
      </p>
      {err ? (
        <p style={{ color: "var(--aq-danger, #c0392b)", fontSize: 12, marginTop: 4 }}>{err}</p>
      ) : null}
    </section>
  );
}
