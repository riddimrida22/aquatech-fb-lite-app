"use client";

import type { CSSProperties } from "react";

type ReportPreset = "weekly" | "monthly" | "annual" | "project_to_date" | "custom";

type WeekOption = { start: string; label: string };
type ProjectOption = { id: number; name: string };

type ReportPeriodControlsProps = {
  keyPrefix: string;
  reportPreset: ReportPreset;
  applyReportPreset: (preset: ReportPreset) => void;
  reportYear: number;
  setReportYear: (year: number) => void;
  reportYearOptions: number[];
  reportMonth: number;
  setReportMonth: (month: number) => void;
  reportWeekStart: string;
  setReportWeekStart: (start: string) => void;
  reportWeekOptions: WeekOption[];
  reportPtdProjectId: number | null;
  setReportPtdProjectId: (id: number | null) => void;
  reportPtdProjectOptions: ProjectOption[];
  reportStart: string;
  setReportStart: (start: string) => void;
  reportEnd: string;
  setReportEnd: (end: string) => void;
  showNativeDatePicker: (el: HTMLInputElement) => void;
  containerStyle?: CSSProperties;
};

export function ReportPeriodControls({
  keyPrefix,
  reportPreset,
  applyReportPreset,
  reportYear,
  setReportYear,
  reportYearOptions,
  reportMonth,
  setReportMonth,
  reportWeekStart,
  setReportWeekStart,
  reportWeekOptions,
  reportPtdProjectId,
  setReportPtdProjectId,
  reportPtdProjectOptions,
  reportStart,
  setReportStart,
  reportEnd,
  setReportEnd,
  showNativeDatePicker,
  containerStyle,
}: ReportPeriodControlsProps) {
  return (
    <div style={containerStyle || { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "0 0 8px 0" }}>
      <button onClick={() => applyReportPreset("weekly")} disabled={reportPreset === "weekly"}>Weekly</button>
      <button onClick={() => applyReportPreset("monthly")} disabled={reportPreset === "monthly"}>Monthly</button>
      <button onClick={() => applyReportPreset("annual")} disabled={reportPreset === "annual"}>Annual</button>
      <button onClick={() => applyReportPreset("project_to_date")} disabled={reportPreset === "project_to_date"}>Project to Date</button>
      <button onClick={() => applyReportPreset("custom")} disabled={reportPreset === "custom"}>Custom</button>

      {reportPreset === "annual" && (
        <select value={reportYear} onChange={(e) => setReportYear(Number(e.target.value))}>
          {reportYearOptions.map((y) => (
            <option key={`${keyPrefix}-year-${y}`} value={y}>{y}</option>
          ))}
        </select>
      )}

      {reportPreset === "monthly" && (
        <>
          <select value={reportYear} onChange={(e) => setReportYear(Number(e.target.value))}>
            {reportYearOptions.map((y) => (
              <option key={`${keyPrefix}-my-year-${y}`} value={y}>{y}</option>
            ))}
          </select>
          <select value={reportMonth} onChange={(e) => setReportMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={`${keyPrefix}-month-${m}`} value={m}>
                {new Date(Date.UTC(2026, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })}
              </option>
            ))}
          </select>
        </>
      )}

      {reportPreset === "weekly" && (
        <select value={reportWeekStart} onChange={(e) => setReportWeekStart(e.target.value)} style={{ minWidth: 220 }}>
          {reportWeekOptions.map((w) => (
            <option key={`${keyPrefix}-week-${w.start}`} value={w.start}>{w.label}</option>
          ))}
        </select>
      )}

      {reportPreset === "project_to_date" && (
        <select
          value={reportPtdProjectId ?? ""}
          onChange={(e) => setReportPtdProjectId(e.target.value ? Number(e.target.value) : null)}
          style={{ minWidth: 260 }}
        >
          {reportPtdProjectOptions.length === 0 && <option value="">No projects with start date</option>}
          {reportPtdProjectOptions.map((p) => (
            <option key={`${keyPrefix}-ptd-${p.id}`} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      {reportPreset === "custom" && (
        <>
          <input
            type="date"
            value={reportStart}
            onChange={(e) => {
              applyReportPreset("custom");
              setReportStart(e.target.value);
            }}
            onFocus={(e) => showNativeDatePicker(e.currentTarget)}
            onClick={(e) => showNativeDatePicker(e.currentTarget)}
          />
          <input
            type="date"
            value={reportEnd}
            onChange={(e) => {
              applyReportPreset("custom");
              setReportEnd(e.target.value);
            }}
            onFocus={(e) => showNativeDatePicker(e.currentTarget)}
            onClick={(e) => showNativeDatePicker(e.currentTarget)}
          />
        </>
      )}
    </div>
  );
}
