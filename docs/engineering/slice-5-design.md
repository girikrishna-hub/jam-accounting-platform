# Slice 5 – Month-end close and reports

Release 1a, slice 5: close a month with a checklist and a reviewer's approval, produce the profit and loss
and balance sheet through the Financial Statements runtime, work out the GCT return, and export reports.

## Decisions (approved by the owner, 2026-11-22)

| # | Decision |
|---|----------|
| 1 | A checklist before closing. Blocks: bank reconciliation not signed off; customers or suppliers not agreeing with their control accounts; journals not yet posted; a document half-posted. Warnings, each needing a reason: drafts, unidentified receipts, expenses without a receipt or matter, bank entries flagged (payroll). |
| 2 | The accountant asks for the close; a different person, a reviewer, approves it, which closes the Bookkeeping period. Months close in order. |
| 3 | Reopening needs a reviewer and a reason, latest month first, and is logged. A statement already issued is replaced (with a reason) when issued again. |
| 4 | Month-end adjustments are ordinary journals; nothing automatic. |
| 5 | Statements use the Financial Statements runtime 1.0.1, through the same gateway as Bookkeeping. |
| 6 | Layouts follow the sample year-end statements: profit and loss by nature ending at net profit available for appropriation (each line lists its accounts, so practice areas show under fee income); balance sheet financed by partners' capital and current accounts. |
| 7 | Drafts any time, marked DRAFT; issued only for closed months, numbered, never changed, verifiable against the ledger. |
| 8 | The balance sheet compares with the previous month end; for January, the opening position on 1 January 2026 (the books start that day). The January profit and loss has no comparative. |
| 9 | Partners' profit sharing stays at year end (out of this release). |
| 10 | GCT working on documents dated in the month: output on fee notes less credit notes; input claimed on expenses with a receipt, less cancellations; not-claimed GCT shown for information. Marking it filed posts Dr 2100 / Cr 1160 for the input GCT on the filing date. |
| 11 | PDF and Excel for the trial balance, profit and loss, balance sheet, GCT working, aged debtors, supplier balances, and fee notes (PDF). |
| 12 | Client viewers see issued statements only, plus the trial balance. |
| 13 | The app answers health checks before loading demo data. |

**Also approved (2026-11-22):** the demo's opening balances were Harbourview's 31 December 2025 trial balance
before the year was closed. The demo now posts a 2025 year-end close journal dated 1 January 2026, sharing
2025's profit (129,842,300.00) to the partners' current accounts as in the sample (A 58,036,535; B 45,167,305;
C 26,638,460) and clearing 2025's drawings into them. Partners' funds at 1 January 2026 are then
102,762,300.00, as in the sample's balance sheet.

## How it works

* **Gateway.** `LedgerGateway` also runs `FinancialStatementsRuntime` (PostgreSQL storage, schema
  `financial_statements`). Every statements call is authorised for the user (policy in `access/policy.ts`) and
  carries a signed decision; the runtime reads the ledger through `BookkeepingLedgerSource`, whose four reads are
  issued to the `service:financial-statements` principal. Runtime business errors become messages.
* **Set-up** is automatic the first time an accountant opens Statements: the ledger is registered and the two
  practice layouts saved as its defaults (`services/statements.ts`).
* **Close** (`services/month-end.ts`, `app.period_closes`): request → (reviewer) approve → Bookkeeping
  `ClosePeriod`; reopen → `ReopenPeriod`. Interrupted documents are finished before the checklist runs.
* **GCT** (`app.gct_returns`, source type `gct-return`).
* **Exports** (`reports/export.ts`): one table definition rendered to PDF (pdfkit) and Excel (SpreadsheetML,
  zipped with fflate). Statements are rendered from the runtime's statement content, with each line's accounts
  and the content fingerprint.

## Screens

* **Month end** (was Periods): months with their close status; Open next month; for the chosen month the
  checklist with reasons, Ask to close (accountant), Approve and close (reviewer), Reopen (reviewer); the GCT
  working with Mark filed; downloads (trial balance, GCT working, aged debtors, supplier balances).
* **Statements**: staff choose a month and see draft profit and loss and balance sheet (expandable to accounts),
  download them, and issue once the month is closed; everyone sees issued statements, can view and download
  them; staff see whether each still agrees with the ledger.
* **Fee note**: Download PDF. **Trial balance**: PDF and Excel.
