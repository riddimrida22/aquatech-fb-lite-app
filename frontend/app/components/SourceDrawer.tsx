"use client";

import { ReactNode, useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import { DetailDrawer } from "./DetailDrawer";

/**
 * "Click any figure to see its source." A table cell wraps its value in <SourceLink>,
 * which asks the single <SourceDrawerHost> (mounted once in page.tsx) to open a drawer
 * listing the underlying records from GET /sources (time entries, invoices or bank
 * transactions), with a total that reconciles to the figure clicked.
 */

export type SourceKind = "time_entries" | "invoices" | "bank_transactions" | "owner_distributions" | "payroll";
export type SourceQuery = { kind: SourceKind } & Record<string, string | number | boolean | null | undefined>;

type Column = { key: string; label: string; align?: "left" | "right"; money?: boolean };
type SourceResp = {
  kind: SourceKind;
  count: number;
  rows: Record<string, string | number>[];
  totals: Record<string, number>;
  columns: Column[];
};

const EVENT = "aq:source";

export function openSource(title: string, query: SourceQuery) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { title, query } }));
}

export function SourceLink({ title, query, children }: { title: string; query: SourceQuery; children: ReactNode }) {
  return (
    <button
      type="button"
      className="aq-source-link"
      title="Show the records behind this figure"
      onClick={(e) => { e.stopPropagation(); openSource(title, query); }}
    >
      {children}
    </button>
  );
}

const money = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toParams(q: SourceQuery): string {
  const p = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  });
  return p.toString();
}

const TOTAL_LABEL: Record<string, string> = {
  hours: "hours", value: "billable value", cost: "loaded cost", amount: "amount", paid: "paid", balance: "balance",
};

export default function SourceDrawerHost() {
  const [req, setReq] = useState<{ title: string; query: SourceQuery } | null>(null);
  const [data, setData] = useState<SourceResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent).detail as { title: string; query: SourceQuery };
      setReq(d); setData(null); setErr(null);
      apiGet<SourceResp>(`/sources?${toParams(d.query)}`)
        .then(setData)
        .catch((ex) => setErr(ex?.message || "Could not load the source records"));
    };
    window.addEventListener(EVENT, onOpen);
    return () => window.removeEventListener(EVENT, onOpen);
  }, []);

  if (!req) return null;
  const totals = data?.totals ?? {};
  const moneyKeys = new Set((data?.columns ?? []).filter((c) => c.money).map((c) => c.key));
  const subtitle = data
    ? [`${data.count} record${data.count === 1 ? "" : "s"}`,
       ...Object.entries(totals).map(([k, v]) => `${moneyKeys.has(k) || k !== "hours" ? money(v) : v.toLocaleString()} ${TOTAL_LABEL[k] ?? k}`)].join(" · ")
    : "Loading…";

  return (
    <DetailDrawer open onClose={() => setReq(null)} title={req.title} subtitle={subtitle} width={980}>
      {err ? <p style={{ color: "#b42318" }}>{err}</p> : null}
      {data ? (
        <div style={{ overflowX: "auto" }}>
          <table className="aq-lite-table" style={{ width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr>
                {data.columns.map((c) => (
                  <th key={c.key} style={{ textAlign: c.align === "right" ? "right" : "left", whiteSpace: "nowrap" }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={String(r.id ?? i)}>
                  {data.columns.map((c) => {
                    const v = r[c.key];
                    const shown = c.money && typeof v === "number" ? money(v) : String(v ?? "");
                    return (
                      <td key={c.key} style={{ textAlign: c.align === "right" ? "right" : "left",
                                              fontVariantNumeric: c.align === "right" ? "tabular-nums" : undefined,
                                              whiteSpace: c.key === "note" || c.key === "description" ? "normal" : "nowrap" }}>
                        {shown}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {data.rows.length === 0 ? (
                <tr><td colSpan={data.columns.length} className="aq-lite-muted">No records behind this figure.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </DetailDrawer>
  );
}
