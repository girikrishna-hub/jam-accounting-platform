# Slice 3a – Receivables (fee notes, receipts, retainers, credit notes)

Release 1a, slice 3 is split: **3a receivables** (this record) and **3b payables and expenses**.

## Decisions (approved by the owner)

| # | Decision |
|---|----------|
| 1 | Slice 3 split into 3a (receivables) and 3b (payables and expenses). |
| 2 | One "brought forward" item per control account holds the pre-system balance, so the customer total agrees with the ledger from day one. |
| 3 | Clients' money waits for release 1b. All 12 January fee notes and the 8 office receipts are loaded; FN-2026-0001 and 0003 (settled from the client account) stay outstanding until then. |
| 4 | Retainers are held in 2200 Fees Received in Advance and applied to fee notes. |
| 5 | Practice area → income account: Conveyancing 4000, Litigation 4010, Corporate 4020, Probate 4030, Family 4040, Notarial and Immigration 4050, Retainer 4100. Disbursements go to 1120 without GCT; output GCT to 2100. |
| 6 | A receipt from an unknown payer is held as unidentified and reassigned once known. |
| 7 | Issuing a fee note needs no approval; corrections are made by credit note; numbers are gap-free. |
| 8 | Printable fee note page now; PDF and Excel in slice 5. |
| 9 | Matter reference is stored as text. |

## Postings

| Document | Debit | Credit |
|---|---|---|
| Fee note issued | 1100 receivables (total) | income account for the practice area (fees), 2100 (GCT), 1120 (disbursements) |
| Payment received | bank account | 1100 |
| Retainer received | bank account | 2200 |
| Retainer applied | 2200 | 1100 |
| Credit note | income, 2100, 1120 | 1100 |

Allocating a payment to a fee note posts nothing; it only settles the item. GCT is 15% of the
standard-rated fee lines, rounded half up on the total; this reproduces every amount in the
January register exactly.

Every document posts its own journal with deterministic ledger request IDs, so an interrupted
issue or receipt is finished on the next visit (`completePending`) without a duplicate. Journals
made by a document cannot be reversed from the Journals screen; the document is corrected instead
(credit note).

## Numbering

`FN-YYYY-NNNN` fee notes, `CN-YYYY-NNNN` credit notes, `RC-YY-NNNN` receipts, per client and year,
from one locked sequence table. A number is taken in the same transaction that marks the fee note
as issuing, so no number is skipped or reused. Because clients' money receipts wait for 1b, the
demo's office receipts are numbered RC-26-0001 to 0008 rather than the register's numbers.

## Screens

* **Client › Receivables** (staff only): control check against 1100, New fee note, Record receipt,
  Add customer; tabs for fee notes, customers, receipts (with assignment of unidentified
  receipts), ageing and settings.
* **Customer**: statement with running balance, fee notes, details.
* **Fee note**: draft editor with live totals, Issue, Discard; once issued, the printable fee note,
  Allocate a payment, Apply retainer, Credit note, link to its journal. **Payments and credits**
  lists everything settled against it.

Client viewers do not see receivables in this slice.

## Demo data

The demo seed sets up receivables for Harbourview and loads January: 12 fee notes, 8 office
receipts (3 settling 2025 fee notes against the brought-forward item, the Portland retainer applied
to FN-2026-0005, 3 payments of January fee notes, 1 unidentified receipt of 575,000). Result: owed
by customers 34,377,880.00, agreeing with 1100.
