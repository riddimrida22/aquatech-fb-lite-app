"use client";

// Dropdown-first inputs for the QA/QC forms (owner: "provide dropdown lists whenever
// possible"). Every list still allows "Other" so nothing has to be forced into a category.

import { useEffect, useId, useState } from "react";
import { apiGet } from "../../lib/api";

export type QaqcProblem = { label: string; severity: string; action: string };
export type QaqcChoices = {
  work_product_types: string[];
  sources: string[];
  scopes: string[];
  check_types: string[];
  actions: string[];
  problems: QaqcProblem[];
  resolutions: string[];
  backchecks: string[];
};
export type QaqcSuggestions = { sources: string[]; items: string[]; item_sources: string[]; versions: string[]; actions: string[] };
export const EMPTY_SUGGESTIONS: QaqcSuggestions = { sources: [], items: [], item_sources: [], versions: [], actions: [] };

const OTHER = "__other__";
const quietBtn: React.CSSProperties = { background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.5)", boxShadow: "none", padding: "2px 8px", fontSize: 12 };

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function uniq(list: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const t = (v || "").trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

export function splitList(v: string): string[] {
  return uniq((v || "").split(";"));
}

/** Values already used on a project's QA/QC records (for suggestion lists). */
export function useQaqcSuggestions(projectId: number | null | undefined): QaqcSuggestions {
  const [s, setS] = useState<QaqcSuggestions>(EMPTY_SUGGESTIONS);
  useEffect(() => {
    if (!projectId) { setS(EMPTY_SUGGESTIONS); return; }
    apiGet<QaqcSuggestions>(`/qaqc/suggestions?project_id=${projectId}`).then(setS).catch(() => setS(EMPTY_SUGGESTIONS));
  }, [projectId]);
  return s;
}

/** A dropdown of standard options plus "Other (type it)". */
export function ChoiceSelect({ value, options, onChange, placeholder = "Select", style }: {
  value: string; options: string[]; onChange: (v: string) => void; placeholder?: string; style?: React.CSSProperties;
}) {
  const known = !value || options.includes(value);
  const [other, setOther] = useState(!known);
  useEffect(() => { if (value && !options.includes(value)) setOther(true); }, [value, options]);
  return (
    <span style={{ display: "grid", gap: 4, ...style }}>
      <select value={other ? OTHER : value} onChange={(e) => {
        const v = e.target.value;
        if (v === OTHER) { setOther(true); onChange(""); } else { setOther(false); onChange(v); }
      }}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={OTHER}>Other (type it)</option>
      </select>
      {other ? <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder="Type it" /> : null}
    </span>
  );
}

/** A text box with a dropdown of suggestions (type anything, or pick one). */
export function SuggestInput({ value, onChange, options, placeholder, style }: {
  value: string; onChange: (v: string) => void; options: string[]; placeholder?: string; style?: React.CSSProperties;
}) {
  const id = useId().replace(/:/g, "");
  const opts = uniq(options);
  return (
    <>
      <input list={`sg-${id}`} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={style} />
      <datalist id={`sg-${id}`}>{opts.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

/** Pick several values from a dropdown (shown as removable chips), with "Other". Stored "a; b; c". */
export function MultiPick({ value, onChange, options, addLabel = "+ Add" }: {
  value: string; onChange: (v: string) => void; options: string[]; addLabel?: string;
}) {
  const chosen = splitList(value);
  const [other, setOther] = useState("");
  const [typing, setTyping] = useState(false);
  const set = (list: string[]) => onChange(uniq(list).join("; "));
  const avail = uniq(options).filter((o) => !chosen.some((c) => c.toLowerCase() === o.toLowerCase()));
  return (
    <span style={{ display: "grid", gap: 6 }}>
      {chosen.length ? (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chosen.map((c) => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, border: "1px solid rgba(22,107,119,0.45)", fontSize: 12.5 }}>
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => set(chosen.filter((x) => x !== c))}
                style={{ ...quietBtn, border: "none", padding: "0 2px", lineHeight: 1 }}>x</button>
            </span>
          ))}
        </span>
      ) : null}
      <select value="" onChange={(e) => {
        const v = e.target.value;
        if (v === OTHER) { setTyping(true); return; }
        if (v) set([...chosen, v]);
      }}>
        <option value="">{addLabel}</option>
        {avail.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={OTHER}>Other (type it)</option>
      </select>
      {typing ? (
        <span style={{ display: "flex", gap: 6 }}>
          <input autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="Type it" style={{ flex: 1 }}
            onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) { e.preventDefault(); set([...chosen, other]); setOther(""); setTyping(false); } }} />
          <button type="button" style={quietBtn} disabled={!other.trim()} onClick={() => { set([...chosen, other]); setOther(""); setTyping(false); }}>Add</button>
        </span>
      ) : null}
    </span>
  );
}

/** "Type: description" from a work-product type dropdown and a short description. */
export function composeTitle(type: string, desc: string): string {
  const t = type.trim();
  const d = desc.trim();
  return t && d ? `${t}: ${d}` : t || d;
}

/** A row of radio buttons (one choice, all options visible). */
export function RadioRow({ value, options, onChange, name }: {
  value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; name?: string;
}) {
  const auto = useId().replace(/:/g, "");
  return (
    <span role="radiogroup" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
          <input type="radio" name={name || `rr-${auto}`} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} style={{ width: "auto", margin: 0 }} />
          {o.label}
        </label>
      ))}
    </span>
  );
}

/** "JA-1 to JA-8", "JA-1 to 8" or "R-2 through R-5" -> one entry per number; null if not a range. */
export function expandRange(v: string): string[] | null {
  const m = v.trim().match(/^(.*?)(\d+)\s*(?:to|through|thru)\s*(.*?)(\d+)$/i);
  if (!m) return null;
  const [, pre, a, pre2, b] = m;
  if (pre2 && pre2.trim() && pre2.trim().toLowerCase() !== pre.trim().toLowerCase()) return null;
  const lo = Number(a), hi = Number(b);
  if (!(hi > lo) || hi - lo >= 100) return null;
  const pad = a.length > 1 && a.startsWith("0") ? a.length : 0;
  return Array.from({ length: hi - lo + 1 }, (_, i) => `${pre}${String(lo + i).padStart(pad, "0")}`);
}
