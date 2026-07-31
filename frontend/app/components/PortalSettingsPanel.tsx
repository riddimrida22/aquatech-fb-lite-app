"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";

/**
 * Admin-only toggle for whether FreshBooks-imported time appears in the time portal.
 * Default is OFF (FB time hidden) so the team enters time only in AqtPM. Checking the
 * box shows FB-imported time again, effective immediately. Rendered only for users
 * with the MANAGE_USERS permission; the backend enforces the same gate.
 */
export function PortalSettingsPanel({ canManage }: { canManage: boolean }) {
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

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Time portal · admin</p>
          <h3>FreshBooks time visibility</h3>
        </div>
      </div>
      <p className="aq-lite-muted" style={{ fontSize: 13, marginTop: 0 }}>
        Time entered in FreshBooks is hidden from the time portal by default, so the team
        records time only in AqtPM. Turn this on to show FreshBooks-imported time in the portal
        again. Takes effect immediately for everyone.
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
        <span>Show FreshBooks-imported time in the time portal</span>
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
