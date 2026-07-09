"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";

type Item = { id: string; locked: boolean; decision: string; rationale: string; settled: string };
type Section = { title: string; items: Item[] };
type Data = { available: boolean; sections: Section[]; count?: number };

export default function DecisionsRegister() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<Data>("/decisions").then(setData).catch((e) => setErr(e?.message || "Could not load"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (err) return null;
  if (!data || !data.available) return null;

  return (
    <section className="aq-lite-panel" style={{ marginBottom: 16 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: "pointer" }}
        onClick={() => setOpen((o) => !o)}
      >
        <div>
          <p className="aq-lite-eyebrow" style={{ margin: 0 }}>Governance</p>
          <h3 style={{ margin: "2px 0 0", fontSize: 18 }}>
            Settled decisions <span style={{ opacity: 0.6, fontWeight: 400, fontSize: 14 }}>· {data.count ?? 0} locked</span>
          </h3>
          <p className="aq-lite-muted" style={{ fontSize: 12.5, margin: "3px 0 0", maxWidth: 620 }}>
            Decisions that are final. None of these change without Bertrand&apos;s express approval (source of truth: <code>DECISIONS.md</code>).
          </p>
        </div>
        <span style={{ fontSize: 13, opacity: 0.7 }}>{open ? "Hide ▲" : "Show ▼"}</span>
      </div>

      {open ? (
        <div style={{ marginTop: 14 }}>
          {data.sections.map((s) => (
            <div key={s.title} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.7, marginBottom: 6 }}>
                {s.title}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {s.items.map((it) => (
                  <div
                    key={it.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "58px 1fr",
                      gap: 10,
                      padding: "9px 11px",
                      borderRadius: 8,
                      border: "1px solid var(--aq-border, rgba(0,0,0,0.10))",
                      background: "var(--aq-input-bg, rgba(0,0,0,0.02))",
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 12.5 }}>
                      {it.locked ? "🔒 " : ""}
                      {it.id}
                    </div>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 550 }}>{it.decision}</div>
                      {it.rationale ? (
                        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>
                          <span style={{ opacity: 0.7 }}>Why:</span> {it.rationale}
                          {it.settled ? <span style={{ opacity: 0.55 }}> · settled {it.settled}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
