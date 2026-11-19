# Slice 1 design record (internal)

Internal engineering notes. Not for customers. Full design pack: the "Accountant-Managed Accounting Platform — Solution Design Pack v0.1" doc.

## Objects in Slice 1

| Object | Source of truth | Workspace | Capabilities (default first) | Actions |
| --- | --- | --- | --- | --- |
| Client organisation | `app.organisations` | Yes | Overview, Profile, Chart of accounts, Periods, Trial balance, Activity | `org.profile.update`, `coa.import`, `opening-balances.post`, `period.open` |
| Account | Bookkeeping runtime | Yes | Ledger, Details | `account.update`, `account.deactivate` |
| Accounting period | Bookkeeping runtime | Yes | Status, Trial balance | none yet (closing comes with the month-end close journey) |

The model lives in `shared/workspace-model.ts`. The server enforces it; the browser only renders it.

## Who can do what

| Role | Sees | Can do |
| --- | --- | --- |
| Accountant | Everything in assigned clients | Import accounts, open periods, post opening balances, edit and deactivate accounts, edit the client profile |
| Reviewer | Everything in assigned clients | Read only in Slice 1 (closing periods comes later) |
| Client viewer | Overview, Profile, Chart of accounts, Trial balance, Activity, account ledgers, for their own client only | Nothing: every action returns 403 from the server |
| Firm administrator | Administration console | Create clients (each gets its own ledger), create and disable users, grant and revoke access |

## How a request is protected

1. Session cookie (HTTP-only, SameSite=Lax) plus a required `x-jam-csrf` header on every change.
2. The client is resolved from the stored record, never from the URL. Unknown, malformed and unassigned client IDs all return the same 404.
3. The role is checked against `shared/workspace-model.ts` (views and actions) and `server/src/access/policy.ts` (ledger operations).
4. For every ledger call the server issues an HMAC-signed decision for exactly one operation, ledger and user, valid for 60 seconds. The Bookkeeping runtime verifies it and refuses anything else.
5. Workspace actions carry an idempotency key; the server stores one execution per client, action and key.

## Non-object screens (documented exceptions)

| Screen | Why it is not an object workspace |
| --- | --- |
| Sign-in | Before identity exists |
| Clients list | Cross-client list, not one object |
| Administration | Firm-level console across clients and users |

Each uses the same session, CSRF and server-side checks as the workspaces.

## Journeys

None in Slice 1. Every task here is a direct capability. The month-end close journey arrives in Slice 5 (design pack, Journey Decision Register).

## Runtime versions

| Package | Version |
| --- | --- |
| `@governedai-labs/bookkeeping-runtime` | 1.1.1 |
| `@governedai-labs/bookkeeping-runtime-postgres` | 1.1.1 |
| `@governedai-labs/cowr-runtime` | 1.0.0 |
| `@governedai-labs/cowr-react` | 1.0.0 |
