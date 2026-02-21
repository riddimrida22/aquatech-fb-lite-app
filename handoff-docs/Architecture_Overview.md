# Architecture Overview

Browser (Users)
  -> Google Workspace SSO (domain restricted)
  -> Next.js UI (role/permission nav; wizards; dashboards; imports; invoices)
  -> FastAPI backend (permissions enforced server-side)
     - Project controls: WBS, budgets, rates, time, approvals, dashboards
     - Invoicing: HTML/Jinja templates -> PDF
     - Accounting: CSV import, rules, splits, month close export
  -> Postgres DB
  -> Optional object storage for PDFs/exports
