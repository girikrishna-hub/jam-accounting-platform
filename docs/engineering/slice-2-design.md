# Slice 2 design record (internal)

Internal engineering notes. Not for customers.

## What Slice 2 adds

| Object | New capability or action | Who |
| --- | --- | --- |
| Client organisation | Journals list (filters: in progress, awaiting approval, posted, all); New journal | Everyone sees posted journals; staff see all; accountants create |
| Client organisation | Journal approval on/off (Profile) | Reviewers change it; staff see it |
| Journal (new workspace) | Lines: edit, submit, approve, return, post, discard, reverse | Accountants prepare, post and reverse; reviewers approve and return |
| Journal | Review trail: prepared, submitted, reviewed, posted, by whom and when | Staff |
| Account | Ledger lines show the journal description and link to the journal | Everyone with access |

## Journal approval (design pack D4)

- On by default for every client; a reviewer can switch it off or on (audited).
- With approval on: draft → submitted → approved → posted. A reviewer can return a submitted journal with a reason.
- The approver must not be the person who prepared, last edited or submitted the journal (checked on the server).
- Editing an approved journal clears the approval. Before posting, the server compares a fingerprint of the ledger's copy with the one taken at approval; if they differ, the journal goes back to draft.
- With approval off: accountants post drafts directly.
- Reversals are made by accountants without approval, with a date and a reason (audited). A reversing journal cannot be reversed.

## Journal register

The Bookkeeping runtime holds the journals and decides balance, period and posting rules. Because it has no list query (PF-10), the app keeps `app.journals` with each journal's status and the people involved. Status changes are compare-and-set, so two people acting at once cannot both succeed. Posting and reversal use stable request IDs, so a retry posts once.

## Journeys

None. Journal approval is a single handoff (approval queue), per the Journey Decision Register. The month-end close journey comes later.
