# 2025 Tax Packet Summary

Generated: 2026-03-12 20:08:55
Target tax year: 2025
Prior-year filing context: Form 1120-S (S corporation)

## Source files used
- P&L cash basis: `/mnt/c/Users/bertr/Downloads/profit_loss (1).csv`
- P&L accrual basis: `/mnt/c/Users/bertr/Downloads/profit_loss.csv`
- AquatechPM SQL backup: `/mnt/c/Users/bertr/OneDrive - Aquatech Engineering P.C/Documents/Projects/Codex/AquatechPM/backups/fblite_20260228_003502.sql.gz`
- AquatechPM reconciliation export: `/mnt/c/Users/bertr/OneDrive - Aquatech Engineering P.C/Documents/Projects/Codex/AquatechPM/docs/reconciliation/reconciliation_2024-02-08_2026-02-13.csv`
- Prior-year return reference: `/mnt/c/Users/bertr/Downloads/Aquatech2024TaxReturns.pdf`

## Core 2025 figures from the provided P&Ls
- Cash gross receipts: $373,632.12
- Accrual gross receipts: $592,506.24
- Total expenses: $209,772.68
- Cash net profit (loss): -$8,948.29
- Accrual net profit: $185,475.81

## AquatechPM support recovered from the backup
- App invoice subtotal issued in 2025: $428,815.17
- App invoice paid in 2025: $373,632.12
- App invoice ending balance in 2025: $55,183.05
- App reconciliation bill amount in 2025: $592,443.36
- App reconciliation cost amount in 2025: $368,196.75
- App reconciliation profit amount in 2025: $224,246.61
- App reconciliation hours in 2025: 4061.75
- Business bank transactions in 2025 backup: 1071 rows / $1,487,077.79 absolute dollars
- Negative business transactions flagged as expense in the import: 782 rows / $627,607.01
- Project expenses in app for 2025: 0 rows / $0.00

## Payroll support recovered from AquatechPM
- P&L payroll-related total (cash basis lines): $173,674.07
- P&L payroll-related total (accrual basis lines): $198,124.09
- AquatechPM payroll-related bank import support: $175,936.21
- AquatechPM time-entry labor cost support: $496,761.25
- AquatechPM time-entry labor bill value: $894,917.36
- Result: the app does contain payroll-related support through imported bank categories and the payroll-hours/rates model, even though statutory payroll filing packets are still not present in the provided files.

## Manual adjustments carried in this packet
- Aquatech repayment of shareholder loan to Bertrand Byrne: $125,000.00 | Not a Page 1 deduction; principal repayment of shareholder debt. Review Schedule L and Form 7203 debt-basis impact.
- Business expenses paid on Bertrand Byrne personal credit card: $25,000.00 | Potential corporate deduction if substantiated and not already in the books; generally treat at the corporation level rather than as a personal unreimbursed employee expense.
- Strict 6611/0273 transfer-family net withdrawals: $142,788.98
- Amount of the stated shareholder-loan repayment directly supported by that transfer family: $125,000.00
- Personal-card business expenses added to the shareholder-related analysis: $25,000.00
- Combined shareholder-related target (loan + personal-card expenses): $150,000.00
- Net withdrawals after accounting for both items: -$7,211.02
- Unaccounted withdrawals after both items: $0.00
- Remaining unreimbursed shareholder-related amount after both items: $7,211.02
- Excess transfer-family support above the stated shareholder-loan repayment: $17,788.98

## Key consistency checks
- Cash P&L gross receipts minus app invoice paid: $0.00
- Accrual P&L gross receipts minus app reconciliation billings: $62.88
- Accrual P&L gross receipts minus app invoice subtotals: $163,691.07
- Result: cash receipts align with the app invoice payments, the reconciliation billings are very close to the accrual P&L, and the app invoice table is incomplete for full accrual support.

## Bank review buckets from AquatechPM
- `expense_candidate`: $187,654.24
- `balance_sheet_or_cashflow`: $399,800.95
- `split_principal_interest`: $37,621.35
- `equity_owner_activity`: $100.00
- `manual_review`: $2,190.05
- `exclude_personal`: $240.42

## Packet outputs
- `2025-tax-pl-category-map.csv`
- `2025-tax-source-comparison.csv`
- `2025-tax-monthly-support.csv`
- `2025-tax-bank-category-review.csv`
- `2025-tax-payroll-support.csv`
- `2025-tax-payroll-by-user.csv`
- `2025-tax-1120s-draft-worksheet.csv`
- `2025-tax-manual-adjustments.csv`
- `2025-tax-shareholder-loan-ledger.csv`
- `2025-tax-shareholder-loan-match.csv`
- `2025-tax-accounting-method-memo.md`
- `2025-tax-cpa-handoff-checklist.md`

## Remaining gaps before filing
- The bookkeeping sources here do not include a depreciation/fixed-asset schedule.
- The app invoice table does not carry the full 2025 accrual revenue history; use the accrual P&L and reconciliation support for the primary billed revenue number.
- Statutory payroll filing support like W-2/W-3 package copies, 941 package copies, shareholder basis support, and state filing support are still not present in the provided files.
- The strict 6611/0273 transfer-family support exceeds the stated $125,000 shareholder-loan repayment by $17,788.98; confirm whether the excess is a separate distribution/transfer rather than part of the loan repayment.
- After also allocating $25,000.00 of shareholder-paid business expenses, there are no unexplained matched withdrawals; instead $7,211.02 remains due to the shareholder or otherwise unsupported by the strict 6611/0273 transfer family.
- The provided 2024 PDF does not preserve the checked accounting-method box in extractable text, so the filed 2024 cash-vs-accrual method still needs independent confirmation before the 2025 return is finalized.
- Bank categories marked `manual_review`, `split_principal_interest`, `equity_owner_activity`, or `exclude_personal` need a manual sign-off before the return is filed.
