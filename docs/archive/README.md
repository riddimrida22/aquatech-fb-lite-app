# docs/archive

Superseded documents kept for historical reference. **Do not follow these as
current instructions** — read the banner at the top of each file.

| Document | Archived | Why |
|---|---|---|
| `GUSTO_PROD_PROMOTION.md` | 2026-06-02 | Gusto is no longer used. Payroll is transitioning to **Paychex** (timing TBD). The Gusto demo→prod promotion was never executed. `backend/app/gusto.py` and the `/auth/gusto/*` + `/admin/gusto/*` endpoints remain only to keep parsing historical Gusto Payroll Journal CSVs already imported. |

## Payroll transition note (Paychex)

When the Paychex integration is scoped, it will replace the Gusto path. Expected
touch points to revisit at that time:

- `backend/app/gusto.py` → new `paychex.py` (or generalized payroll module)
- `_parse_gusto_payroll_journal` in `backend/app/main.py` → Paychex journal format
- `.env.example` Gusto block (currently marked DEPRECATED)
- `frontend/app/legal/privacy/page.tsx` — still lists Gusto as a sub-processor;
  update to Paychex
- Gusto-derived tables (`gusto_employees`, `gusto_payrolls`) — decide migrate vs. retire
