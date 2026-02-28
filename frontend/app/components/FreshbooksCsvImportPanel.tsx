"use client";

type FreshbooksCsvImportPanelProps = {
  title: string;
  description: string;
  fileAccept?: string;
  onFileChange: (file: File | null) => void;
  apply: boolean;
  setApply: (value: boolean) => void;
  runLabelApply: string;
  runLabelPreview: string;
  onRun: () => void;
  mappingLabel: string;
  mappingJson: string;
  setMappingJson: (value: string) => void;
  summary: string;
};

export function FreshbooksCsvImportPanel({
  title,
  description,
  fileAccept = ".csv,text/csv",
  onFileChange,
  apply,
  setApply,
  runLabelApply,
  runLabelPreview,
  onRun,
  mappingLabel,
  mappingJson,
  setMappingJson,
  summary,
}: FreshbooksCsvImportPanelProps) {
  return (
    <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p>{description}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="file" accept={fileAccept} onChange={(e) => onFileChange(e.target.files?.[0] || null)} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} />
          Apply import (unchecked = preview)
        </label>
        <button onClick={onRun}>{apply ? runLabelApply : runLabelPreview}</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <p style={{ marginBottom: 4 }}>{mappingLabel}</p>
        <textarea
          value={mappingJson}
          onChange={(e) => setMappingJson(e.target.value)}
          rows={8}
          style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
        />
      </div>
      {summary && <p style={{ marginTop: 8 }}>{summary}</p>}
    </div>
  );
}
