# Slice 1 design record (internal)

Internal engineering notes. Not for customers. Full design pack: the "Accountant-Managed Accounting Platform — Solution Design Pack v0.1" doc.

## Objects in Slice 1

| Object | Source of truth | Workspace | Capabilities (default first) | Actions |
| --- | --- | --- | --- | --- |
| Client organisation | `app.organisations` | Yes | Overview, Profile, Chart of accounts, Periods, Trial balance, Activity | `org.profile.update`, `coa.import`, `opening-balances.post`, `period.open` |
| Account | Bookkeeping runtime | Yes | Ledger, Details | `account.update`, `account.deactivate` |
| Accounting period | Bookkeeping runtime | Yes | Status, Trial balance | none yet (closing comes with the month-end close journey) |

The model lives in `shared/workspace-model.ts`. The server compiles it into Authorization Runtime policies (`server/src/access/authority.ts`); the browser only renders what the server allows.

## Who can do what

| Role | Sees | Can do |
| --- | --- | --- |
| Accountant | Everything in assigned clients | Import accounts, open periods, post opening balances, edit and deactivate accounts, edit the client profile |
| Reviewer | Everything in assigned clients | Read only in Slice 1 (closing periods comes later) |
| Client viewer | Overview, Profile, Chart of accounts, Trial balance, Activity, account ledgers, for their own client only | Nothing: every action returns 403 from the server |
| Firm administrator | Administration console | Create clients (each gets its own ledger), create and disable users, grant and revoke access. No access to a client's books unless also assigned to that client |

## How a request is protected

1. **Sign-in (Authentication Runtime, `auth-runtime` 1.1.0).** Passwords are hashed and verified by the runtime (salted scrypt, constant-time). The runtime's password policy applies, with this app's 12-character minimum. Its lockout policy locks an email for 15 minutes after 5 failures in 15 minutes; failures are stored in `app.sign_in_lockout`.
2. **Session.** HTTP-only, SameSite=Lax cookie. The token is stored only as the runtime's lookup hash. Every change needs the `x-jam-csrf` header.
3. **Client scope.** The client is resolved from the stored record, never from the URL. Unknown, malformed and unassigned client IDs all return the same 404.
4. **Every allow/deny (Authorization Runtime, via `identity-orchestrator-runtime` 1.1.0 `AuthorizationRuntimeAdapter`).** One policy per role and resource type, generated from the shared model. Each policy is bound to the firm (tenant condition), and for client resources the user's assigned client must own the resource (ownership condition). Workspace access checks, panel reads, actions, ledger operations and administration all ask the runtime. Refused actions and refused direct requests are recorded as `access.denied` against the user's own client.
5. **Ledger calls.** After the runtime allows an operation, the server signs a 60-second decision for exactly that operation, ledger and user; the Bookkeeping runtime verifies it and refuses anything else.
6. **Idempotency.** Workspace actions carry an idempotency key; the server stores one execution per client, action and key.

User and session records stay in the app's own tables, following the PEP pattern, until the identity runtimes publish their PostgreSQL schema (platform feedback PF-8).

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
| `@governedai-labs/auth-runtime` | 1.1.0 |
| `@governedai-labs/identity-orchestrator-runtime` | 1.1.0 (brings `authorization-runtime` 1.1.0 and `iar-rbac-runtime` 1.1.0) |
| `@governedai-labs/identity-contracts` | 1.2.0 |
