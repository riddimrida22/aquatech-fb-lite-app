# CSV Import Mapping Spec (Bank + Credit Card)

## Canonical fields
posted_date, description, amount (positive), direction (debit/credit), account_id.

## Common column aliases
Date: Date, Posted Date, Posting Date, Transaction Date  
Description: Description, Transaction Description, Memo, Details, Payee, Name  
Amount: Amount (may be +/-) OR Debit/Credit OR Withdrawal/Deposit OR Charge/Payment  
Optional: Category, Merchant, Transaction ID, Reference

## Rules
- If Amount < 0 => debit, abs(Amount)
- If Amount > 0 => credit
- Vendor normalization: uppercase; remove noise tokens (POS/ONLINE/etc.); collapse whitespace.
- Duplicate prevention: sha256(account_id|date|direction|amount|vendor_norm)

## Rule application priority
Exact vendor → regex vendor → keyword match → amount-range combos.

## Allocation policy
Require project assignment only for reimbursables or big-ticket items (threshold configurable).
