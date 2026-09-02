"use client";

// Shared top bar for the standalone payroll pages: return to the main app + move
// between payroll screens (these routes render outside the main SPA sidebar).
export default function PayrollNav({ active }: { active?: string }) {
  const tabs = [
    { href: "/", label: "← AqtPM", home: true },
    { href: "/payroll", label: "Run payroll", key: "run" },
    { href: "/payroll/reconcile", label: "Reconcile", key: "reconcile" },
    { href: "/payroll/employees", label: "Employees", key: "employees" },
    { href: "/payroll/me", label: "My Pay Settings", key: "me" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
                  padding: "10px 14px", marginBottom: 8, borderBottom: "1px solid rgba(0,0,0,0.1)",
                  background: "var(--aq-card-bg,#fff)", position: "sticky", top: 0, zIndex: 10 }}>
      {tabs.map((t) => (
        <a key={t.href} href={t.href}
           style={{
             textDecoration: "none", fontSize: 13, padding: "5px 10px", borderRadius: 8,
             fontWeight: t.home ? 700 : 500,
             color: t.home ? "#21737e" : (t.key === active ? "#fff" : "#333"),
             background: t.key === active ? "#21737e" : (t.home ? "transparent" : "rgba(0,0,0,0.05)"),
             marginRight: t.home ? 10 : 0,
           }}>
          {t.label}
        </a>
      ))}
    </div>
  );
}
