"use client";

import { ReactNode, useMemo, useState } from "react";

export type GroupOption<T> = {
  key: string;
  label: string;
  /** Returns the bucket label (string) for a row. Use "" or null to drop from view. */
  groupBy: (row: T) => string;
  /** Optional comparator for the bucket labels (e.g. date desc). Default: localeCompare. */
  sortBuckets?: (a: string, b: string) => number;
};

type GroupedListProps<T> = {
  /** All rows, already filtered if you want — GroupedList does NOT filter besides search & group dropdown. */
  rows: T[];
  /** "Group by" choices the user picks from a dropdown. Pick an initial one with `defaultGroupKey`. */
  groupOptions: GroupOption<T>[];
  defaultGroupKey?: string;
  /** Render one row inside an expanded group. */
  renderRow: (row: T, idx: number) => ReactNode;
  /** Optional header summary inside the group header (e.g. count, total $). Receives the bucket rows. */
  renderGroupSummary?: (rows: T[], bucketLabel: string) => ReactNode;
  /** Optional search predicate. If provided, a search input is shown above the grouping. */
  searchPredicate?: (row: T, normalized: string) => boolean;
  searchPlaceholder?: string;
  /** Show "no rows" placeholder. */
  emptyHint?: string;
  /** Storage key — if provided, the chosen group + open buckets persist in localStorage. */
  persistKey?: string;
  /** Initial collapsed state for buckets. Defaults: groups all collapsed. */
  initiallyOpen?: "all" | "none" | "first";
};

/**
 * A reusable groupable, collapsible, searchable list.
 * - Top: "Group by" dropdown (e.g. Merchant / Date / Category)
 * - Optional search input
 * - Each group: collapsible header showing count + custom summary
 * - Click group header -> expand/collapse
 * - All groups have a "expand all / collapse all" pair of buttons next to the dropdown.
 *
 * Designed to deal with long lists by hiding rows behind group headers by default.
 */
export function GroupedList<T>({
  rows,
  groupOptions,
  defaultGroupKey,
  renderRow,
  renderGroupSummary,
  searchPredicate,
  searchPlaceholder = "Search…",
  emptyHint = "No items.",
  persistKey,
  initiallyOpen = "first",
}: GroupedListProps<T>) {
  const [groupKey, setGroupKey] = useState<string>(() => {
    if (typeof window !== "undefined" && persistKey) {
      const saved = window.localStorage.getItem(`${persistKey}.groupKey`);
      if (saved && groupOptions.some((opt) => opt.key === saved)) return saved;
    }
    return defaultGroupKey || groupOptions[0]?.key || "";
  });
  const [search, setSearch] = useState("");
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined" && persistKey) {
      const saved = window.localStorage.getItem(`${persistKey}.open`);
      if (saved) {
        try {
          return JSON.parse(saved) as Record<string, boolean>;
        } catch {
          /* ignore */
        }
      }
    }
    return {};
  });

  const activeOption = groupOptions.find((opt) => opt.key === groupKey) || groupOptions[0];

  const filteredRows = useMemo(() => {
    if (!searchPredicate) return rows;
    const norm = search.trim().toLowerCase();
    if (!norm) return rows;
    return rows.filter((r) => searchPredicate(r, norm));
  }, [rows, search, searchPredicate]);

  const grouped = useMemo(() => {
    if (!activeOption) return [] as { label: string; items: T[] }[];
    const buckets = new Map<string, T[]>();
    for (const row of filteredRows) {
      const lbl = activeOption.groupBy(row) || "(uncategorized)";
      if (!buckets.has(lbl)) buckets.set(lbl, []);
      buckets.get(lbl)!.push(row);
    }
    const labels = Array.from(buckets.keys());
    const sortFn = activeOption.sortBuckets || ((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    labels.sort(sortFn);
    return labels.map((label) => ({ label, items: buckets.get(label)! }));
  }, [filteredRows, activeOption]);

  // Initial open state for never-seen-before buckets
  const computedOpenMap = useMemo(() => {
    const next = { ...openMap };
    grouped.forEach((g, idx) => {
      const k = `${groupKey}::${g.label}`;
      if (next[k] === undefined) {
        next[k] =
          initiallyOpen === "all" ? true : initiallyOpen === "first" ? idx === 0 : false;
      }
    });
    return next;
  }, [grouped, openMap, groupKey, initiallyOpen]);

  function toggle(label: string) {
    const k = `${groupKey}::${label}`;
    const next = { ...computedOpenMap, [k]: !computedOpenMap[k] };
    setOpenMap(next);
    if (typeof window !== "undefined" && persistKey) {
      window.localStorage.setItem(`${persistKey}.open`, JSON.stringify(next));
    }
  }

  function setAll(open: boolean) {
    const next: Record<string, boolean> = { ...computedOpenMap };
    grouped.forEach((g) => {
      next[`${groupKey}::${g.label}`] = open;
    });
    setOpenMap(next);
    if (typeof window !== "undefined" && persistKey) {
      window.localStorage.setItem(`${persistKey}.open`, JSON.stringify(next));
    }
  }

  function changeGroup(k: string) {
    setGroupKey(k);
    if (typeof window !== "undefined" && persistKey) {
      window.localStorage.setItem(`${persistKey}.groupKey`, k);
    }
  }

  return (
    <div className="aq-grouped-list">
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontSize: 12, color: "var(--aq-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          Group by:
          <select value={groupKey} onChange={(e) => changeGroup(e.target.value)} style={{ padding: "4px 8px" }}>
            {groupOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        {searchPredicate ? (
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={searchPlaceholder}
            style={{ flex: 1, minWidth: 180, padding: "4px 10px" }}
          />
        ) : null}

        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => setAll(true)}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              background: "transparent",
              color: "var(--aq-primary-dark)",
              border: "1px solid var(--aq-border)",
              boxShadow: "none",
            }}
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              background: "transparent",
              color: "var(--aq-primary-dark)",
              border: "1px solid var(--aq-border)",
              boxShadow: "none",
            }}
          >
            Collapse all
          </button>
        </div>

        <span style={{ fontSize: 12, color: "var(--aq-muted)", marginLeft: "auto" }}>
          {filteredRows.length} item{filteredRows.length === 1 ? "" : "s"} · {grouped.length} group
          {grouped.length === 1 ? "" : "s"}
        </span>
      </div>

      {grouped.length === 0 ? (
        <p className="aq-lite-muted" style={{ fontSize: 12, padding: "8px 4px" }}>{emptyHint}</p>
      ) : null}

      {grouped.map((g) => {
        const k = `${groupKey}::${g.label}`;
        const isOpen = !!computedOpenMap[k];
        return (
          <div
            key={g.label}
            style={{
              border: "1px solid var(--aq-border)",
              borderRadius: 8,
              marginBottom: 6,
              background: "var(--aq-card)",
            }}
          >
            <button
              type="button"
              onClick={() => toggle(g.label)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 12px",
                background: isOpen ? "var(--aq-primary-soft)" : "transparent",
                color: "var(--aq-text)",
                border: "none",
                borderRadius: 8,
                boxShadow: "none",
                textAlign: "left",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ width: 14, color: "var(--aq-text)" }}>{isOpen ? "▼" : "▶"}</span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--aq-text)",
                    letterSpacing: 0.2,
                  }}
                >
                  {g.label.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                </span>
                <span style={{ fontWeight: 600, fontSize: 12, color: "var(--aq-muted)" }}>
                  ({g.items.length})
                </span>
              </span>
              <span style={{ fontSize: 12, color: "var(--aq-muted)", fontWeight: 400 }}>
                {renderGroupSummary ? renderGroupSummary(g.items, g.label) : null}
              </span>
            </button>
            {isOpen ? (
              <div style={{ padding: "0 6px 8px 6px", maxHeight: 420, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
                {g.items.map((row, idx) => (
                  <div key={idx}>{renderRow(row, idx)}</div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
