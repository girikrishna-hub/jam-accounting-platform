# Jamaica Accounting Platform

A cloud accounting platform operated by an accounting firm. The firm's accountants keep separate books for each client business, and clients get secure read-only access to their own statements and records. Jamaica first; other Caribbean markets later through country-specific configuration.

## How this repository is worked on

- **Development happens in this repository.** Feature work goes on a branch per build slice (for example `slice-1-foundation`) and is merged into `main` only after approval.
- **Replit is used for publishing.** Replit imports this repository, installs dependencies, builds and deploys `main`.

## Planned stack

- Node.js 22, TypeScript
- Express API server, React web app
- PostgreSQL
- Certified GovernedAI runtimes from GitHub Packages:
  - `@governedai-labs/bookkeeping-runtime` 1.1.1: ledgers, accounts, periods, journals, trial balance
  - `@governedai-labs/financial-statements-runtime` 1.0.1: profit and loss, balance sheet, issued statements
  - `@governedai-labs/cowr-runtime` and `@governedai-labs/cowr-react` 1.0.0: object workspaces

## Replit secrets (needed once the app code lands)

| Secret | Purpose |
| --- | --- |
| `GH_PACKAGES_TOKEN` | GitHub token with `read:packages`, used by `.npmrc` to install `@governedai-labs` packages |
| `DATABASE_URL` | PostgreSQL connection string (Replit provides this when a database is added) |
| `DECISION_SIGNING_KEY` | Random string of at least 32 characters; signs the server's authorization decisions |

## Build slices

1. Foundation: sign-in, roles, client organisations, assignments, chart of accounts, opening balances, trial balance
2. Ledger work: journals, approval, posting, reversal, periods
3. Receivables, payables, expenses
4. Banking: statement import, matching, reconciliation
5. Reporting and client portal: statements, month-end close, read-only portal

Excluded from the initial release: payroll, tax filing and statutory submissions.
