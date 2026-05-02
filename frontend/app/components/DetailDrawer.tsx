"use client";

import { ReactNode, useEffect } from "react";

type DetailDrawerProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Slide-out right drawer for "full context" detail of a clicked row.
 * Click overlay or Esc to close. Content area scrolls; header + footer are sticky.
 */
export function DetailDrawer({ open, onClose, title, subtitle, width = 720, children, footer }: DetailDrawerProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(11, 26, 46, 0.45)",
        backdropFilter: "blur(2px)",
        zIndex: 200,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: `min(${width}px, 96vw)`,
          height: "100vh",
          background: "var(--aq-card)",
          borderLeft: "1px solid var(--aq-border)",
          boxShadow: "-12px 0 30px rgba(11, 26, 46, 0.18)",
          display: "flex",
          flexDirection: "column",
          animation: "aqDrawerSlide 180ms ease-out",
        }}
      >
        <header
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid var(--aq-border)",
            background: "var(--aq-primary-soft)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 17, lineHeight: 1.2, color: "var(--aq-shell-dark)" }}>{title}</h3>
            {subtitle ? (
              <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "var(--aq-muted)" }}>{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            style={{
              background: "transparent",
              color: "var(--aq-shell-dark)",
              border: "1px solid var(--aq-border)",
              padding: "6px 12px",
              boxShadow: "none",
              fontWeight: 500,
            }}
          >
            Close ✕
          </button>
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "16px 20px",
          }}
        >
          {children}
        </div>

        {footer ? (
          <footer
            style={{
              padding: "12px 20px",
              borderTop: "1px solid var(--aq-border)",
              background: "#fafcfd",
              flexShrink: 0,
            }}
          >
            {footer}
          </footer>
        ) : null}
      </aside>

      <style>{`
        @keyframes aqDrawerSlide {
          from { transform: translateX(24px); opacity: 0.6; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}
