"use client";

import { FreshBooksInbox, FreshBooksTransitionRun } from "./workspaceShared";
import { GroupedList } from "./GroupedList";

type TransitionInboxPanelProps = {
  freshbooksInbox: FreshBooksInbox | null;
  onRefresh: () => Promise<void>;
  onImport: () => Promise<void>;
  workspaceLoading: boolean;
  importBusy: boolean;
  transitionRun: FreshBooksTransitionRun | null;
};

export function TransitionInboxPanel({
  freshbooksInbox,
  onRefresh,
  onImport,
  workspaceLoading,
  importBusy,
  transitionRun,
}: TransitionInboxPanelProps) {
  const recommended = freshbooksInbox?.files.filter((file) => file.recommended_use) ?? [];
  const skipped = freshbooksInbox?.files.filter((file) => !file.recommended_use) ?? [];

  return (
    <section className="aq-lite-panel aq-lite-panel-span-2">
      <div className="aq-lite-panel-head">
        <div>
          <p className="aq-lite-eyebrow">Transition intake</p>
          <h3>FreshBooks folder inbox</h3>
        </div>
        <div className="aq-lite-topbar-actions">
          <button type="button" onClick={() => void onRefresh()} disabled={workspaceLoading || importBusy}>
            Rescan inbox
          </button>
          <button type="button" onClick={() => void onImport()} disabled={workspaceLoading || importBusy || recommended.length === 0}>
            {importBusy ? "Importing…" : "Import recommended files"}
          </button>
        </div>
      </div>

      <div className="aq-lite-grid aq-lite-grid-3">
        <div className="aq-lite-note">
          <strong>No browser upload required</strong>
          <p>
            Drop new FreshBooks exports into <code>{freshbooksInbox?.root_path || "the configured inbox folder"}</code>.
            AqtPM reads from that folder directly during the transition.
          </p>
        </div>
        <div className="aq-lite-note">
          <strong>{recommended.length} files ready</strong>
          <p>These are the canonical files the transition import should use.</p>
        </div>
        <div className="aq-lite-note">
          <strong>{skipped.length} duplicates or lower-priority files</strong>
          <p>They are still visible for audit purposes, but not part of the recommended load set.</p>
        </div>
      </div>

      {transitionRun ? (
        <div className="aq-lite-note-stack" style={{ marginBottom: 16 }}>
          <div className="aq-lite-note">
            <strong>Last import run</strong>
            <p>
              Imported {transitionRun.totals.imported || 0}, updated {transitionRun.totals.updated || 0}, skipped{" "}
              {transitionRun.totals.skipped || 0}, errors {transitionRun.totals.errors || 0}.
            </p>
          </div>
          {transitionRun.steps.map((step) => (
            <div key={step.step} className="aq-lite-note">
              <strong>{step.step.replaceAll("_", " ")}</strong>
              <p>
                Imported {step.imported}, updated {step.updated}, skipped {step.skipped}, errors {step.errors}.
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {!freshbooksInbox?.files.length ? (
        <p className="aq-lite-muted">
          {freshbooksInbox?.exists === false
            ? "Configured FreshBooks inbox folder does not exist."
            : "No transition files detected yet."}
        </p>
      ) : (
        <GroupedList
          rows={freshbooksInbox.files}
          persistKey="imports.fbInbox"
          searchPredicate={(f, q) =>
            `${f.name} ${f.category} ${f.reason}`.toLowerCase().includes(q)
          }
          searchPlaceholder="Search file / category / reason"
          groupOptions={[
            { key: "category", label: "Category", groupBy: (f) => f.category || "(uncategorized)" },
            {
              key: "status",
              label: "Status",
              groupBy: (f) => (f.recommended_use ? "Use" : f.duplicate_of ? "Duplicate" : "Skip"),
              sortBuckets: (a, b) => {
                const order = ["Use", "Duplicate", "Skip"];
                return order.indexOf(a) - order.indexOf(b);
              },
            },
          ]}
          renderGroupSummary={(items) => `${items.length} file${items.length === 1 ? "" : "s"}`}
          renderRow={(file) => (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.5fr 80px 130px 1fr",
                gap: 8,
                padding: "4px 8px",
                fontSize: 12,
                borderBottom: "1px solid #f0f3f6",
                alignItems: "center",
              }}
            >
              <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.name}
              </strong>
              <span>
                <span
                  className={
                    file.recommended_use
                      ? "aq-lite-badge aq-lite-badge-good"
                      : file.duplicate_of
                        ? "aq-lite-badge aq-lite-badge-warn"
                        : "aq-lite-badge"
                  }
                >
                  {file.recommended_use ? "Use" : file.duplicate_of ? "Duplicate" : "Skip"}
                </span>
              </span>
              <span style={{ color: "var(--aq-muted)", fontSize: 11 }}>
                {new Date(file.modified_at).toLocaleDateString()}
              </span>
              <span style={{ color: "var(--aq-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.reason}
              </span>
            </div>
          )}
          initiallyOpen="first"
        />
      )}
    </section>
  );
}
