"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost, API_BASE } from "../../lib/api";

type PlaidItem = {
  id: number;
  item_id?: string | null;
  account_id?: string | null;
  institution?: string | null;
  last_synced_at?: string | null;
  last_sync_status?: string | null;
  notes?: string | null;
};

type CloudStatus = {
  connected: boolean;
  account_id?: string | null;
  business_id?: string | null;
  expires_at?: string | null;
  last_synced_at?: string | null;
  last_sync_status?: string | null;
  last_sync_summary?: Record<string, unknown>;
  notes?: string | null;
  // Plaid supports one linked institution per item — Chase and Dime side by side.
  item_count?: number;
  items?: PlaidItem[];
};

type OAuthProvider = {
  key: "freshbooks";
  label: string;
  description: string;
  redirectNote: string;
};

// Gusto API connector removed 2026-07 — payroll moved to Paychex and the Gusto
// OAuth app was never connected. Historical Gusto payroll-journal data and its
// CSV parser are UNTOUCHED; they still feed COGS. Paychex API is the follow-up.
const OAUTH_PROVIDERS: OAuthProvider[] = [
  {
    key: "freshbooks",
    label: "FreshBooks API",
    description:
      "Read-only sync of clients, invoices, expenses, payments, projects, and time entries from your live FreshBooks account.",
    redirectNote:
      "When FreshBooks redirects back, the URL starts with https://localhost:8000/... which won't load. Manually flip https → http in the URL bar and press enter.",
  },
];

declare global {
  interface Window {
    Plaid?: {
      create: (config: {
        token: string;
        // Set only on the OAuth return leg (bank redirected back to us).
        receivedRedirectUri?: string;
        onSuccess: (publicToken: string, metadata: unknown) => void;
        onExit?: (err: unknown, metadata: unknown) => void;
      }) => { open: () => void; exit: () => void };
    };
  }
}

export function CloudConnectionsPanel() {
  // Lazy-load Plaid Link JS once
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.Plaid) return;
    const existing = document.querySelector('script[data-plaid-link="1"]');
    if (existing) return;
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.async = true;
    s.dataset.plaidLink = "1";
    document.head.appendChild(s);
  }, []);

  return (
    <section className="aq-lite-panel">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Cloud connections</p>
          <h3>Direct API integrations</h3>
        </div>
      </div>
      <div className="aq-lite-stack" style={{ gap: 16 }}>
        {OAUTH_PROVIDERS.map((p) => <OAuthProviderCard key={p.key} provider={p} />)}
        <PaychexProviderCard />
        <PlaidProviderCard />
      </div>
    </section>
  );
}


function OAuthProviderCard({ provider }: { provider: OAuthProvider }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const s = await apiGet<CloudStatus>(`/admin/${provider.key}/status`);
      setStatus(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    window.location.href = `${API_BASE}/auth/${provider.key}/start`;
  }

  async function syncNow() {
    setBusy(true);
    setErr(null);
    try {
      await apiPost(`/admin/${provider.key}/sync`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${provider.label}? You'll need to re-authorize.`)) return;
    setBusy(true);
    try {
      await apiPost(`/admin/${provider.key}/disconnect`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ProviderCardShell
      label={provider.label}
      status={status}
      err={err}
      busy={busy}
      onConnect={connect}
      onSync={syncNow}
      onDisconnect={disconnect}
      description={provider.description}
      connectNote={provider.redirectNote}
      connectLabel="Connect"
    />
  );
}


// Paychex uses a company-owned app with OAuth2 client_credentials — there is no
// user redirect to "connect". It is live as soon as the keys are in the server
// env; what varies is which API resources the app is entitled to, so this card
// surfaces per-resource capability instead of a Connect button.
type PaychexCapability = { status: number; allowed: boolean; count: number | null; note: string };

function PaychexProviderCard() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      setStatus(await apiGet<CloudStatus>("/admin/paychex/status"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }
  useEffect(() => { void load(); }, []);

  async function syncNow() {
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/admin/paychex/sync");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  // Clears the stored connection record only. The credentials live in the
  // server env, so this does not revoke anything at Paychex.
  async function disconnect() {
    if (!confirm("Clear the stored Paychex connection record? Keys stay in the server env; re-probe any time.")) return;
    setBusy(true);
    try {
      await apiPost("/admin/paychex/disconnect");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  const summary = (status?.last_sync_summary ?? {}) as {
    company?: { displayId?: string; name?: string };
    capabilities?: Record<string, PaychexCapability>;
    payroll_ready?: boolean;
    note?: string;
  };
  const caps = summary.capabilities ?? {};
  const capKeys = Object.keys(caps);

  const detail = status?.connected ? (
    <div style={{ marginTop: 10 }}>
      {summary.company?.name ? (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>{summary.company.name}</strong>
          <span className="aq-lite-muted" style={{ fontSize: 11, marginLeft: 8 }}>
            client #{summary.company.displayId}
          </span>
        </div>
      ) : null}
      {capKeys.length ? (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--aq-muted)", marginBottom: 4 }}>
            API resources
          </div>
          {capKeys.map((k) => (
            <div key={k} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "baseline", marginBottom: 2 }}>
              <span style={{ color: caps[k].allowed ? "var(--aq-green)" : "var(--aq-red)", fontWeight: 600, minWidth: 84 }}>
                {caps[k].allowed ? "● granted" : "○ blocked"}
              </span>
              <span style={{ minWidth: 92 }}>{k}</span>
              <span className="aq-lite-muted" style={{ fontSize: 11 }}>
                {caps[k].allowed ? (caps[k].count !== null ? `${caps[k].count} sampled` : "ok") : `HTTP ${caps[k].status}`}
              </span>
            </div>
          ))}
        </>
      ) : null}
      {summary.note ? (
        <p style={{ fontSize: 11, marginTop: 8, marginBottom: 0, color: summary.payroll_ready ? "var(--aq-green)" : "var(--aq-amber, #d9a14f)" }}>
          {summary.note}
        </p>
      ) : null}
    </div>
  ) : null;

  return (
    <ProviderCardShell
      label="Paychex Flex API"
      status={status}
      err={err}
      busy={busy}
      onConnect={syncNow}
      onSync={syncNow}
      onDisconnect={disconnect}
      extra={detail}
      description="Read-only payroll source. Company-owned app using OAuth2 client_credentials — no redirect, keys live in the server env. Payroll and Checks must be enabled per-resource in Paychex (Company Settings → Integrated apps → Access settings)."
      connectNote="Click to authenticate and probe which Paychex API resources this app is entitled to."
      connectLabel="Connect / probe Paychex"
    />
  );
}

function PlaidProviderCard() {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const s = await apiGet<CloudStatus>("/admin/plaid/status");
      setStatus(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // NOTE: the Plaid OAuth return leg is handled at the app root (app/page.tsx),
  // because the bank redirects back to the root URL where this panel is not
  // mounted. Do not duplicate that handler here — it would open Link twice.

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const { link_token } = await apiPost<{ link_token: string }>("/admin/plaid/link-token");
      if (typeof window === "undefined" || !window.Plaid) {
        throw new Error("Plaid Link JS not loaded yet — refresh the page and try again.");
      }
      // Persist for the OAuth round-trip — the same token must be reused on return.
      window.localStorage.setItem("plaid_link_token", link_token);
      const handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (public_token: string) => {
          try {
            await apiPost("/admin/plaid/exchange", { public_token });
            window.localStorage.removeItem("plaid_link_token");
            await load();
          } catch (e) {
            setErr(e instanceof Error ? e.message : "Exchange failed");
          }
        },
        onExit: (err) => {
          window.localStorage.removeItem("plaid_link_token");
          if (err) console.warn("Plaid Link exit:", err);
        },
      });
      handler.open();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/admin/plaid/sync");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  // Disconnect ONE bank. Without an item_id the server would drop every linked
  // institution, which would silently kill a working feed.
  async function disconnectItem(item: PlaidItem) {
    const who = item.institution || item.item_id || "this bank";
    if (!confirm(`Disconnect ${who}? Other linked banks stay connected. You'll need to re-link it.`)) return;
    setBusy(true);
    try {
      await apiPost(`/admin/plaid/disconnect?item_id=${encodeURIComponent(item.item_id || "")}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const n = status?.items?.length ?? 0;
    if (!confirm(`Disconnect ALL ${n || ""} linked bank(s)? You'll need to re-link each.`)) return;
    setBusy(true);
    try {
      await apiPost("/admin/plaid/disconnect");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  const items = status?.items ?? [];
  const linkedBanks = status?.connected ? (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--aq-muted)", marginBottom: 6 }}>
        Linked banks ({items.length})
      </div>
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, padding: "6px 8px", border: "1px solid var(--aq-border)",
            borderRadius: 8, marginBottom: 6, flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 13 }}>
            <strong>{it.institution || "Linked bank"}</strong>
            <span className="aq-lite-muted" style={{ fontSize: 11, marginLeft: 8 }}>
              {it.last_synced_at ? `synced ${new Date(it.last_synced_at).toLocaleString()}` : "never synced"}
              {it.last_sync_status ? ` · ${it.last_sync_status}` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void disconnectItem(it)}
            disabled={busy}
            style={{
              padding: "3px 9px", fontSize: 12, background: "transparent",
              color: "var(--aq-red)", border: "1px solid var(--aq-border)", boxShadow: "none",
            }}
          >
            Disconnect
          </button>
        </div>
      ))}
      <button type="button" onClick={connect} disabled={busy} style={{ padding: "5px 11px", fontSize: 12 }}>
        {busy ? "Opening…" : "+ Add another bank"}
      </button>
    </div>
  ) : null;

  return (
    <ProviderCardShell
      label="Plaid bank feed"
      status={status}
      err={err}
      busy={busy}
      onConnect={connect}
      onSync={syncNow}
      onDisconnect={disconnect}
      extra={linkedBanks}
      description="Live transactions from your real bank — replaces the manual Chase CSV import. Sandbox lets you test with simulated banks; promotes to Production at dashboard.plaid.com without certification gating."
      connectNote="Click Connect to launch Plaid Link. You'll pick your bank and authenticate. On success, Plaid sends a public_token that we exchange server-side for a long-lived access_token."
      connectLabel="Connect bank via Plaid Link"
    />
  );
}


function ProviderCardShell({
  label,
  status,
  err,
  busy,
  onConnect,
  onSync,
  onDisconnect,
  description,
  connectNote,
  connectLabel,
  extra,
}: {
  label: string;
  status: CloudStatus | null;
  err: string | null;
  busy: boolean;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  description: string;
  connectNote: string;
  connectLabel: string;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--aq-border)",
        borderRadius: 10,
        padding: 14,
        background: "var(--aq-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h4 style={{ margin: 0 }}>{label}</h4>
          {status?.connected ? (
            <span style={{ color: "var(--aq-green)", fontSize: 12, fontWeight: 600 }}>● Connected</span>
          ) : (
            <span style={{ color: "var(--aq-muted)", fontSize: 12 }}>○ Not connected</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {!status?.connected ? (
            <button type="button" onClick={onConnect} disabled={busy}>
              {busy ? "Connecting…" : connectLabel}
            </button>
          ) : (
            <>
              <button type="button" onClick={onSync} disabled={busy} style={{ padding: "6px 12px", fontSize: 13 }}>
                {busy ? "Syncing…" : "Sync now"}
              </button>
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy}
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  background: "transparent",
                  color: "var(--aq-red)",
                  border: "1px solid var(--aq-border)",
                  boxShadow: "none",
                }}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {err ? <p style={{ color: "var(--aq-red)", fontSize: 12, marginTop: 8 }}>{err}</p> : null}

      {extra}

      <p className="aq-lite-muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
        {description}
      </p>

      {!status?.connected ? (
        <p className="aq-lite-muted" style={{ fontSize: 11, marginTop: 6, fontStyle: "italic" }}>
          {connectNote}
        </p>
      ) : null}

      {status?.connected ? (
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 11 }}>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>Account / item</span>
            <div style={{ fontFamily: "monospace", fontSize: 11 }}>
              {status.account_id || status.business_id || "(not set)"}
            </div>
          </div>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>Token expires</span>
            <div>{status.expires_at ? new Date(status.expires_at).toLocaleString() : status.expires_at === null ? "Never" : "—"}</div>
          </div>
          <div>
            <span style={{ color: "var(--aq-muted)" }}>Last synced</span>
            <div>{status.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : "Never"}</div>
          </div>
        </div>
      ) : null}

      {status?.connected && status.last_synced_at ? (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 11, color: "var(--aq-muted)", cursor: "pointer" }}>
            Last sync details · {status.last_sync_status}
          </summary>
          <pre style={{ fontSize: 10, marginTop: 4, background: "var(--aq-subtle)", padding: 8, borderRadius: 6, color: "var(--aq-muted)", maxHeight: 240, overflow: "auto" }}>
            {JSON.stringify(status.last_sync_summary, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
