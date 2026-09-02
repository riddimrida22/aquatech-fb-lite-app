# Golden-stub fixtures (LOCAL ONLY — PII)

`check_golden.py` validates the engine against real Paychex payroll journals.
Those fixtures contain employee names + compensation, so they are **gitignored**
(see `.gitignore` here) — build them locally from the journals in the prod inbox
`/opt/AquatechPM/data/imports/AqtPM-Uploads/` (or Downloads).

Current fixture: `run_2026-08-21.json` — Paychex run for pay period 08/03–08/16
(check date 08/21/26, 6 employees, $12,506.80 gross). Regenerate by parsing
`70367505_PYRJRN_08-21-2026_payrun.pdf`.
