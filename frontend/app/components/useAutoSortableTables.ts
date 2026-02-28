"use client";

import { useEffect, useRef } from "react";

type SortDirection = "asc" | "desc";
type SortState = { columnIndex: number; direction: SortDirection };

const TABLE_SELECTOR = ".aq-main-pane table:not([data-disable-table-sort='true'])";

function parseCellValue(raw: string): { kind: "number" | "date" | "text"; value: number | string } {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return { kind: "text", value: "" };

  const numericCandidate = cleaned
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .replace(/[()]/g, "")
    .trim();
  const negativeByParens = /^\(.*\)$/.test(cleaned);
  if (/^-?\d+(\.\d+)?$/.test(numericCandidate)) {
    const parsed = Number(numericCandidate);
    return { kind: "number", value: negativeByParens ? -Math.abs(parsed) : parsed };
  }

  const parsedDate = Date.parse(cleaned);
  if (!Number.isNaN(parsedDate) && /[-/]|\b\d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(cleaned)) {
    return { kind: "date", value: parsedDate };
  }

  return { kind: "text", value: cleaned.toLowerCase() };
}

function compareCells(aRaw: string, bRaw: string): number {
  const a = parseCellValue(aRaw);
  const b = parseCellValue(bRaw);

  if (a.kind === b.kind) {
    if (a.kind === "text") {
      return String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: "base" });
    }
    return Number(a.value) - Number(b.value);
  }

  if (a.kind === "number") return -1;
  if (b.kind === "number") return 1;
  if (a.kind === "date") return -1;
  if (b.kind === "date") return 1;
  return String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: "base" });
}

function updateHeaderStyles(table: HTMLTableElement, activeColumn: number, direction: SortDirection) {
  const headerCells = Array.from(table.querySelectorAll("thead th"));
  headerCells.forEach((th, idx) => {
    th.classList.remove("aq-sortable-active", "aq-sortable-asc", "aq-sortable-desc");
    th.removeAttribute("aria-sort");
    if (idx === activeColumn) {
      th.classList.add("aq-sortable-active", direction === "asc" ? "aq-sortable-asc" : "aq-sortable-desc");
      th.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
    }
  });
}

function sortTable(table: HTMLTableElement, state: SortState) {
  const tbody = table.tBodies[0];
  if (!tbody) return;

  const allRows = Array.from(tbody.rows);
  if (allRows.length < 2) return;

  const sortableRows = allRows.filter((row) => !row.hasAttribute("data-nosort-row") && !row.querySelector("th"));
  const lockedRows = allRows.filter((row) => row.hasAttribute("data-nosort-row") || !!row.querySelector("th"));
  if (sortableRows.length < 2) return;

  const decorated = sortableRows.map((row, originalIndex) => {
    const cell = row.cells[state.columnIndex];
    const text = cell ? (cell.textContent || "") : "";
    return { row, originalIndex, text };
  });

  decorated.sort((a, b) => {
    const cmp = compareCells(a.text, b.text);
    if (cmp !== 0) return state.direction === "asc" ? cmp : -cmp;
    return a.originalIndex - b.originalIndex;
  });

  decorated.forEach((item) => tbody.appendChild(item.row));
  lockedRows.forEach((row) => tbody.appendChild(row));
  updateHeaderStyles(table, state.columnIndex, state.direction);
}

export function useAutoSortableTables() {
  const tableSortState = useRef<Map<string, SortState>>(new Map());

  useEffect(() => {
    let tableIdCounter = 0;

    function ensureTableId(table: HTMLTableElement): string {
      const existing = table.getAttribute("data-sort-table-id");
      if (existing) return existing;
      tableIdCounter += 1;
      const assigned = `aq-sort-table-${tableIdCounter}`;
      table.setAttribute("data-sort-table-id", assigned);
      return assigned;
    }

    function prepareHeaders(root: ParentNode = document) {
      const tables = root.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR);
      Array.from(tables).forEach((table) => {
        const headers = Array.from(table.querySelectorAll("thead th"));
        if (headers.length < 2 || !table.tBodies.length) return;
        headers.forEach((th) => {
          th.classList.add("aq-sortable-header");
          if (!th.getAttribute("title")) {
            th.setAttribute("title", "Click to sort");
          }
        });
      });
    }

    function reapplyExistingSort(table: HTMLTableElement) {
      const tableId = ensureTableId(table);
      const state = tableSortState.current.get(tableId);
      if (state) sortTable(table, state);
    }

    function onClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      const th = target?.closest("th");
      if (!th) return;
      const table = th.closest("table");
      if (!table || !(table instanceof HTMLTableElement)) return;
      if (!table.matches(TABLE_SELECTOR)) return;
      if (!table.tBodies.length) return;

      const headerRow = th.parentElement;
      if (!headerRow) return;
      const headers = Array.from(headerRow.children).filter((el) => el.tagName === "TH");
      const columnIndex = headers.indexOf(th);
      if (columnIndex < 0) return;

      const tableId = ensureTableId(table);
      const previous = tableSortState.current.get(tableId);
      const direction: SortDirection = previous && previous.columnIndex === columnIndex && previous.direction === "asc" ? "desc" : "asc";
      const next = { columnIndex, direction };

      tableSortState.current.set(tableId, next);
      sortTable(table, next);
    }

    prepareHeaders(document);
    const existingTables = document.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR);
    Array.from(existingTables).forEach((table) => reapplyExistingSort(table));

    document.addEventListener("click", onClick);

    const observer = new MutationObserver((mutations) => {
      let touched = false;
      mutations.forEach((mutation) => {
        if (mutation.type === "childList") {
          touched = true;
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              prepareHeaders(node);
              const nestedTables = node.querySelectorAll<HTMLTableElement>(TABLE_SELECTOR);
              Array.from(nestedTables).forEach((table) => reapplyExistingSort(table));
            }
          });
        }
      });
      if (touched) prepareHeaders(document);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("click", onClick);
      observer.disconnect();
    };
  }, []);
}
