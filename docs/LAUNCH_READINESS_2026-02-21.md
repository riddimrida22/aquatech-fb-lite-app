# Launch Readiness Report (2026-02-21)

## Scope
This report reflects the current Aquatech FB-Lite codebase after launch-hardening updates:
- secrets/config moved to `.env` pattern
- launch preflight script added
- financial currency formatting standardized (commas + accounting negatives in red parentheses)
- invoice line notes visible in preview and saved invoice detail
- daily reminder worker bug fix (`SessionLocal` import)

## Launch Gate Summary
- Gate 1: Core workflow (time -> approval -> invoice -> payment tracking): **PASS**
- Gate 2: Security baseline config hygiene: **PASS with actions required in `.env`**
- Gate 3: Reminder automation: **PASS (feature complete), needs SMTP config**
- Gate 4: Operations readiness (preflight + smoke tests): **PASS**
- Gate 5: Feature parity with FreshBooks-like commercial usage: **PARTIAL**

## Feature Comparison vs FreshBooks (practical SMB usage)
Scoring: 0 (missing), 0.5 (partial), 1 (comparable)

1. Time tracking and daily use UX: `1.0`
2. Project/task/subtask structure and controls: `1.0`
3. Timesheet submit/approve workflow: `1.0`
4. Invoice creation from approved time: `1.0`
5. Payment status tracking and A/R aging: `0.8`
6. Historical invoice continuity import: `0.8`
7. Recurring invoices and auto-send reminders: `0.8`
8. Online payment collection (payment links + posting): `0.4`
9. Automated estimate-to-invoice flow: `0.0`
10. Polished client portal self-service: `0.1`

Total: `6.9 / 10`
Operationally, for Aquatech internal PM/time/invoice control, readiness is strong. For full FreshBooks-equivalent commercial billing automation, two major gaps remain: recurring automation and payment collection.

## Ranking Snapshot
- Internal controls and project accounting use-case: **8.5/10**
- Full FreshBooks commercial invoicing platform parity: **6.9/10**

## Priority Actions To Reach 8+/10 vs FreshBooks
1. Add recurring invoice templates/schedules with email reminders.
2. Add payment gateway integration for ACH/card and payment links.
3. Add estimate/retainer workflow and convert-to-invoice path.
4. Add client-facing invoice portal (view/pay/history).

## Go-Live Recommendation
Launch now for internal operations and controlled invoicing if:
- `.env` is fully configured
- `./scripts/launch_preflight.sh` passes
- `./scripts/smoke_test.sh` passes

Treat public/commercial rollout as Phase 2 after Priority Actions above.
