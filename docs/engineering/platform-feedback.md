# Platform feedback (internal)

Gaps found while building this app, to raise with the runtimes' owner. The app works around each one without copying runtime code.

| # | Runtime | Finding | Effect | Workaround in this app |
| --- | --- | --- | --- | --- |
| PF-1 | cowr-react 1.0.0 | A failed action sets the workspace's failure state, and the whole workspace is replaced by a one-line error page. | A rejected import file would hide the workspace instead of showing its line errors. | Panels invoke actions through `WorkspaceRuntime.invokeAction` (same access, validation and audit path) and show the result in place. |
| PF-2 | cowr-react 1.0.0 | The generic action bar invokes actions with no input. | Actions that need a file or a form cannot run from it. | The bar is hidden with CSS; each panel renders its own controls. |
| PF-3 | cowr-react 1.0.0 | The header always shows the raw object ID. | Accountants see internal IDs such as `acc_led_…_1`. | Hidden with CSS. A header option to hide or relabel it would help. |
| PF-4 | cowr-runtime 1.0.0 | Access decision freshness is checked against the browser clock, but decisions come from the server. | Clock skew between browser and server could make every decision stale. | The browser port stamps `evaluatedAt` on receipt; the server re-checks every action anyway. |
| PF-5 | bookkeeping-runtime 1.1.1 | Journal lines have no party or matter dimension. | Receivables, payables and clients'-money ledgers need their own sub-ledgers (Slices 3 and 1b). | Planned as application sub-ledgers. |
| PF-6 | financial-statements-runtime 1.0.1 | No cash flow statement. | Needed in Slice 5. | Planned as an application calculation. |
| PF-7 | bookkeeping-runtime 1.1.1 | One currency per ledger. | USD accounts are held at JMD equivalents. | Planned: store foreign amount and rate on app records. |
