"use client";

import { useEffect } from "react";

export type ToastKind = "error" | "success" | "info";

export type ToastState = {
  message: string;
  kind: ToastKind;
} | null;

export function Toast({ state, onClose, autoCloseMs }: { state: ToastState; onClose: () => void; autoCloseMs?: number }) {
  const ms = autoCloseMs ?? (state?.kind === "error" ? 8000 : 3500);
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(onClose, ms);
    return () => clearTimeout(t);
  }, [state, ms, onClose]);

  if (!state) return null;
  const cls =
    state.kind === "error"
      ? "aq-lite-toast aq-lite-toast-error"
      : state.kind === "success"
        ? "aq-lite-toast aq-lite-toast-success"
        : "aq-lite-toast";
  const icon = state.kind === "error" ? "⚠" : state.kind === "success" ? "✓" : "•";
  return (
    <div role="status" aria-live="polite" className={cls}>
      <span aria-hidden style={{ fontWeight: 700 }}>{icon}</span>
      <div style={{ flex: 1, whiteSpace: "pre-wrap" }}>{state.message}</div>
      <button type="button" onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
