# Platform feedback (internal)

Gaps found while building this app, for the runtimes' owner to decide on. Runtime changes are made only by the owner. Until then the app handles each one itself, without copying or changing runtime code.

| # | Runtime | Finding | Effect | Workaround in this app |
| --- | --- | --- | --- | --- |
| PF-1 | cowr-react 1.0.0 | A failed action sets the workspace's failure state, and the whole workspace is replaced by a one-line error page. | A rejected import file would hide the workspace instead of showing its line errors. | Panels invoke actions through `WorkspaceRuntime.invokeAction` (same access, validation and audit path) and show the result in place. |
| PF-2 | cowr-react 1.0.0 | The generic action bar invokes actions with no input. | Actions that need a file or a form cannot run from it. | The bar is hidden with CSS; each panel renders its own controls. |
| PF-3 | cowr-react 1.0.0 | The header always shows the raw object ID. | Accountants see internal IDs such as `acc_led_…_1`. | Hidden with CSS. A header option to hide or relabel it would help. |
| PF-4 | cowr-runtime 1.0.0 | Access decision freshness is checked against the browser clock, but decisions come from the server. | Clock skew between browser and server could make every decision stale. | The browser port stamps `evaluatedAt` on receipt; the server re-checks every action anyway. |
| PF-5 | bookkeeping-runtime 1.1.1 | Journal lines have no party or matter dimension. | Receivables, payables and clients'-money ledgers need their own sub-ledgers (Slices 3 and 1b). | Planned as application sub-ledgers. |
| PF-6 | financial-statements-runtime 1.0.1 | No cash flow statement. | Needed in Slice 5. | Planned as an application calculation. |
| PF-7 | bookkeeping-runtime 1.1.1 | One currency per ledger. | USD accounts are held at JMD equivalents. | Planned: store foreign amount and rate on app records. |
| PF-8 | identity-runtime, auth-runtime, session-runtime, iar-rbac-runtime, authorization-runtime 1.1.0 | The PostgreSQL adapters (`PgIdentityStore`, `PgCredentialStore`, `PgLockoutCache`, `PgSessionStore`, `PgRoleStore`, `PgPermissionStore`, `PgAuthorizationPolicyStore`) need `iar_*` tables, but no package publishes the schema or a `migrate()` (Bookkeeping does). | The runtimes' own storage cannot be used, so identities, credentials and sessions stay in app tables. | Follows the PEP pattern: `auth-runtime` functions and lockout policy, Authorization Runtime for decisions, app-owned user and session tables. |
| PF-9 | iar-rbac-runtime 1.1.0 | An assigned role with no Role definition throws `MissingReference` rather than returning a decision. | A caller must catch it to fail closed. | The app registers its four roles and treats any runtime error as a denial. |
| PF-10 | bookkeeping-runtime 1.1.1 | No query lists a ledger's journals (drafts or posted); `GetPostedLines` returns lines, not entries, and never drafts. | The app keeps a journal register (`app.journals`) for lists, status and the approval trail. | The register holds workflow status and people only; journal contents and posting stay in the ledger and are re-read with `GetEntry`. |
| PF-11 | bookkeeping-runtime 1.1.1 | `EntryView` has no version or revision. | The app cannot tell from the entry alone that a draft changed after approval. | The app stores a fingerprint of date, description, reference and lines at approval and compares it before posting. |

