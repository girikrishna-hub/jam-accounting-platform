# Slice 3b – Payables and expenses (suppliers, expenses, supplier payments)

Release 1a, slice 3b. Builds on 3a: the shared document helpers (numbering, posting one journal per
document, account and period checks) now live in `server/src/services/documents.ts`.

## Decisions (approved by the owner, 2026-11-21)

| # | Decision |
|---|----------|
| 1 | One "expense" document, either paid at once (POS, ACH, cheque, direct debit, petty cash) or owed to the supplier and paid later. Supplier payments settle owed expenses. |
| 2 | What is owed to suppliers before the system (2000: 4,215,660.00) is brought forward as one item, so suppliers agree with 2000 from day one. |
| 3 | Bank-statement-only items (payroll, drawings, TAJ GCT and S01 payments, bank charges, interest) are not in 3b; they come with the bank work or as journals. |
| 4 | Input GCT goes to 1160 GCT Input Tax Recoverable, kept apart from output GCT in 2100. |
| 5 | GCT defaults to 15% of net (rounded half up) and can be edited to match the supplier's invoice. |
| 6 | No receipt on file: no input GCT is claimed, the full amount is expensed, and the expense is flagged. |
| 7 | Rechargeable costs go to 1120 with the matter reference; one with no matter is flagged "matter to be identified". |
| 8 | Foreign currency: recorded at the bank's JMD amount, with the foreign amount and rate kept on the record. |
| 9 | Paid from: bank items to 1000 NCB, petty cash to 1020. Cheque numbers are stored. |
| 10 | Recording an expense needs no approval. A mistake is corrected by cancelling: the reversing entry is posted and both stay in the history. |
| 11 | The app numbers expenses EX-YY-NNNN and keeps the supplier's invoice number; the same invoice from the same supplier twice is refused. |
| 12 | The NCB motor loan instalment (318,400) waits as a draft until its principal / interest split is known. |

## Postings

| Document | Debit | Credit |
|---|---|---|
| Expense, paid at once | each line's account (net; plus GCT when not claimed), 1160 input GCT (claimed) | the cash or bank account paid from |
| Expense, owed | as above | 2000 payables |
| Supplier payment | 2000 payables | bank account |
| Cancellation | the expense's journal with every side swapped, on the cancellation date | |

A line can be charged to any account except cash and bank accounts, the payables control account and the
input GCT account, so a loan instalment can reduce 2500 and charge interest to 5410. An owed expense with
payments against it cannot be cancelled. Journals made by an expense or payment cannot be reversed from
the Journals screen.

Every posting uses ledger request IDs derived from the document, so an interrupted expense, cancellation
or payment is finished on the next visit without posting twice (`completePendingPayables`).

## Screens

* **Client › Expenses** (staff only): owed to suppliers with the control check against 2000; count of items
  needing attention; New expense (record at once or save as draft), Pay supplier, Add supplier; tabs for
  expenses, needs attention, suppliers (owed, spent this year), supplier payments and settings.
* **Supplier**: expenses and payments; details.
* **Expense**: draft editor with live GCT preview, Record, Discard; once recorded, the expense with its
  lines, GCT claimed and not claimed, payments, journal links, and Cancel expense.

Client viewers do not see expenses in this slice.

## Demo data

The demo seed sets up expenses for Harbourview and loads January from the register: 13 expenses recorded
as paid (JMD 2,820,742.72; input GCT claimed 104,503.40), with the fuel flagged "no receipt" and the court
filing fee flagged "matter to be identified", and the loan instalment kept as a draft. Owed to suppliers
stays at 4,215,660.00, agreeing with 2000.
