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

## Replit secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `GH_PACKAGES_TOKEN` | Yes | GitHub token with `read:packages`, used by `.npmrc` to install `@governedai-labs` packages |
| `DATABASE_URL` | Yes | PostgreSQL connection string (Replit provides this when a database is added) |
| `DECISION_SIGNING_KEY` | Yes | Random string of at least 32 characters; signs the server's authorization decisions |
| `SEED_DEMO` | Optional | `1` loads the fictitious Harbourview Chambers demo at start-up (skips anything already loaded) |
| `DEMO_PASSWORD` | With `SEED_DEMO` | One password (12+ characters) for every demo user |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Optional | Create the first firm administrator at start-up when none exists |

## Running

| Command | What it does |
| --- | --- |
| `npm install` | Installs server and web dependencies (needs `GH_PACKAGES_TOKEN`) |
| `npm run build` | Builds the web app into `web/dist` |
| `npm run start` | Applies database migrations and serves the API and web app on `PORT` (default 3000) |
| `npm run test` | Server tests; set `TEST_DATABASE_URL` to an empty database to include the acceptance tests |
| `npm run typecheck` | Type checks server and web |
| `npm run seed:demo` | Loads the demo data (needs `DEMO_PASSWORD`) |

## Demo users (with `SEED_DEMO=1`)

All use `DEMO_PASSWORD`.

| Email | Role |
| --- | --- |
| `admin@demo.firm` | Firm administrator |
| `accountant@demo.firm` | Accountant for both demo clients |
| `reviewer@demo.firm` | Reviewer for Harbourview Chambers |
| `owner@harbourview.demo` | Client viewer, Harbourview Chambers only |
| `owner@bluemountain.demo` | Client viewer, Blue Mountain Traders only |

All demo data is fictitious (from the Jamaica sample data pack in `seed/harbourview`).

## Code layout

| Path | Contents |
| --- | --- |
| `shared/workspace-model.ts` | Objects, capabilities, actions and who may use them (enforced by the server) |
| `server/src/access` | Ledger operation policy and signed authorization decisions |
| `server/src/ledger/gateway.ts` | The only path to the Bookkeeping runtime |
| `server/src/services` | Clients, users, chart of accounts, periods, opening balances |
| `server/src/workspace` | Object resolution, search and action execution for the workspaces |
| `server/src/http` | API routes, sessions, isolation checks |
| `web/src` | React app: sign-in, clients list, administration, object workspaces and panels |
| `docs/engineering` | Internal design record and platform feedback |

## Build slices

1. Foundation: sign-in, roles, client organisations, assignments, chart of accounts, opening balances, trial balance
2. Ledger work: journals, approval, posting, reversal, periods
3. Receivables, payables, expenses
4. Banking: statement import, matching, reconciliation
5. Reporting and client portal: statements, month-end close, read-only portal

Excluded from the initial release: payroll, tax filing and statutory submissions.
