# Slice 4 – Bank reconciliation

Release 1a, slice 4: import the bank statement, match it to the books, enter what only the bank shows,
and reconcile the month with a reviewer's sign-off.

## Decisions (approved by the owner, 2026-11-21)

| # | Decision |
|---|----------|
| 1 | January, NCB operating account (1000) only; the USD account and petty cash counts come later. |
| 2 | Statements are imported as CSV in the bank's layout (date, value date, reference, description, debit, credit, balance). The opening balance must follow on from the last statement, or for the first one agree with the ledger; every running balance is checked; the same file or the same lines cannot come in twice. |
| 3 | The app suggests matches (shared document or cheque number; same amount within 7 days; two or three items adding up to one line); the accountant confirms. One bank line can match several entries. |
| 4 | A bank line with nothing recorded is turned into a receipt, an expense, or a simple bank entry to an account. No approval, as for expenses. |
| 5 | Remembered rules per client ("lines containing SERVICE CHARGE → 5400"): suggestions only, never posted without the accountant. |
| 6 | Bank-only items: charges and GCT on charges → 5400 (no tax invoice, no claim); interest → 4500; GCT paid to TAJ → 2100; S01 → 2110; drawings → 3200 / 3210 / 3220. |
| 7 | Payroll batches → 5000 as net pay, flagged "payroll register needed", until a journal splits gross pay, deductions (2110) and staff groups. |
| 8 | Pre-system fee notes paid in January (Carib Telecom, Blue Mountain Resorts, FN-2025-1201) settle the brought-forward balance. |
| 9 | Transfers from the client account that paid FN-2026-0001 and FN-2026-0003 are recorded now as office receipts, so both fee notes show paid; the client-account side comes in 1b. **This revises slice 3a decision 3.** |
| 10 | The WiPay settlement (214,300) covers the two card receipts already recorded (130,700) plus 83,600 held as an unidentified receipt. |
| 11 | The reconciliation: statement balance ± ledger items not yet on the statement = ledger balance ± statement lines not yet entered. The accountant completes it; a different person, a reviewer, signs it off; lines to that date are then locked. |
| 12 | January shows one unpresented cheque (004815, valuation surveyor, 80,500) and one line not yet entered (the loan instalment, 318,400); both sides agree at 6,291,110.01. |

## How it works

* **Lines and matches.** `app.bank_lines` holds what the bank says (amount signed: money in positive).
  `app.bank_matches` links a line to ledger entries that move the bank account; an entry is matched once.
  Ledger items come from the Bookkeeping runtime's account ledger for the bank account, the opening
  balance excluded.
* **Entering from a line** creates the 3a receipt or 3b expense (dated on the bank date, paid into or
  from that bank account) or a bank entry (`app.bank_entries`, source type `bank-entry`), then matches it.
  Bank entries' journals cannot be reversed from the Journals screen. An interrupted bank entry is
  finished on the next visit, once.
* **Reconciliation** is worked out from the lines, the ledger and the matches at the chosen period end.
  Completing stores a snapshot and fingerprint; sign-off is refused if anything changed since, or if the
  reviewer is the person who completed it. After sign-off, matching, unmatching and entering lines dated
  on or before the period end are refused.

## Screens

**Client › Bank** (staff only): account, Import statement, the reconciliation statement for the chosen
period end with Complete (accountant) and Sign off (reviewer); To do / All lines / In the books, not on the
statement / Rules; each line shows its suggestion or rule with Accept / Enter, and Match… / Enter… for
anything else; flagged bank entries (payroll) under Needs attention.

## Demo data

The seed imports January's statement (`seed/harbourview/bank-statement-2026-01.csv`), accepts the
suggestions for 16 lines already in the books, enters 10 lines (6 receipts found on the statement, the
WiPay remainder, TAJ GCT and S01, interest, two payroll batches) and adds two rules. Left for testers:
the two-cheque lodgement (suggested), the two bank charges (rules) and the three partner drawings; the
loan instalment waits for its split. Customers then owe 23,381,780.00, agreeing with 1100.
