# gcs-automated-payments

The extension supplies Payment amount suggestions and guards using the host SDK's
`agreementFinancials.getPaymentCalculation` under the `agreement-payment-capacity`
capability. The host owns financial source queries, exact entitlement, current
Commitment selection, approved Credit Memo effects, Claim reductions and holdback.
The extension controls enabled payment types and the release election; it never
falls back to its own financial calculation when the SDK is unavailable.

The SDK receives the stable Agreement fiscal-year ID, Agency Commitment type,
Payment type, selected fiscal end month, native currency, optional holdback release
and optional same-Agreement Payment exclusion. Its eight exact values are base
amount, Commitment remaining, ordinary availability, elected release, Claims
through the last eligible Claim month, forecast through that Claim month, forecast
through period end, and payments to date. Holdback and the single-Payment ceiling
are also host-calculated. `availableBeforeHoldback` retains its established meaning
of ordinary funds after reserving holdback.

Reimbursement entitlement uses successful reconciled Claims minus recorded paid.
Advances replace forecast through the last Claim month with those Claims, add
forecast through the selected month, and subtract recorded paid. Earlier fiscal
years accumulate; later Claims and forecast remain outside the selected cutoff.
The host rounds holdback down to whole dollars, reapplies the full reserve on each
calculation, caps the reserve at unpaid eligibility and caps release at that reserve.
Final-fiscal basis includes the final current year even when its funding is zero.
The host caps each Payment at entitlement, Commitment/shared-coding capacity,
availability plus elected release and `numeric(19,2)`; aggregate inputs retain cents
and can exceed one persisted row. There is no currency conversion.

A suggestion is a ceiling, not a required amount. The calculator preserves an
explicit amount choice, including cleared/invalid editing state. Financial selection
and release changes recalculate the ceiling without replacing that choice. Create
and update guards re-read host calculations under the Agreement lock and reject
amounts above the live ceiling. Amount keystrokes do not change calculation inputs.

Creation stores `payment-metadata.calculationEvidence` in extension KV under
`fundingcasepayment`. Version 1 captures the selection, timestamp and all eight
calculation details together with the exact ceiling, reserve and currency. The
Payment calculation tab reads this creation-time snapshot without recomputing or
enriching it from live financial records. Missing preexisting snapshots have an
explicit empty state; corrupt authored evidence returns a localized error. The
read route uses the host-dispatched Payment scope with Agreement Viewer authority
and Agency/Stream extension enablement. English/French presentation, retry and
stale Payment response protection belong to the extension. Existing holdback
release metadata remains readable by update guards.

The tab uses the shared host workspace's full available width; the evidence body
supplies a distinct Calculation details SDK section without a private max-width.
Payment section bookmarks and reloads wait for successful tab discovery before URL normalization. Discovery failures retain the requested section
and expose a local announced retry without replacing the Payment's business data.
Evidence rows stack at phone widths and allow long exact currency text to wrap.

The extension creates no dedicated tables. `extensions.kv_entry` retains host audit
ownership: Payment → Commitment → Agreement → Program stream → Agency. The manifest
explicitly declares an empty dedicated-table audit ownership list. Run
`bun run test:audit` from this workspace; `AUDIT_EXTENSION_POSTGRES_URL` enables its
isolated disposable PostgreSQL variant, otherwise it uses PGlite.

Run `bun run test:unit`, `bun run test:coverage`, `bun run typecheck`, the owning
transaction/metadata PostgreSQL suite, and `bun run test:e2e` in this package. Unit
and rendered tests verify SDK delegation, exact values, live bilingual rendering,
release choices, creation evidence and failure recovery. Host tests own financial
source selection and entitlement/holdback mathematics. The managed lifecycle journey
uses public APIs to verify JV reversal/replacement and Corrections, then creates a
later Payment; the fixed-input accuracy and native-currency journeys retain their
independently authored ledgers. `GCS_PAYMENT_AUDIT_DIR` optionally retains the browser
CSV/source ledger and JSON evidence outside replaceable Playwright output.

For the host calculation and retained Payment evidence journey against the current
NCIA demo seed, run:

```sh
GCS_AUTOMATED_PAYMENTS_E2E_GREP='verifies fixed advances' bun run test:e2e
```

The managed runner still owns a fresh build, isolated database and server. The
optional grep selects the independent fixed-input journey, including all eight
creation-time evidence values after Payment approval. The full suite also includes
an Outcome Cost Allocator journey; that extension's migration to the new coding
allocator remains outside this change.
