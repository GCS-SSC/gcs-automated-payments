# gcs-automated-payments

The extension supplies Payment amount suggestions and guards using SDK 0.3.13's
`agreementFinancials.getPaymentCalculation` under `agreement-payment-capacity`.
The host owns financial source queries, current Commitment selection, approved
Credit Memo totals and Claim reductions. The extension owns exact entitlement,
holdback and Payment ceiling arithmetic, enabled types and the release election.
It delegates financial source totals to the host and never falls back when the SDK is unavailable.

The calculator translates only the structured `AGREEMENT_CURRENCY_MISMATCH`
into its bilingual currency field error. Other failures propagate unchanged.
The SDK receives the stable Agreement fiscal-year ID, Commitment type, selected
start and end months, native currency and optional same-Agreement Payment exclusion.
It supplies exact claims, forecasts, payments, total Credit memos and Credit memos for reconciled periods, Commitment capacity,
net disbursement availability, Agreement/final-year funding and holdback settings.

Agency settings require an explicit `creditMemoBasis`: `all` (All credit memos)
or `reconciled-periods` (Credit memos for reconciled periods). There is no default.
Enabled agency settings without a valid choice cannot be saved, and existing
unconfigured agencies must choose a basis before automated calculations or payment
creation/update checks can run. Stream settings separately choose enabled Payment
types. The host supplies the owning Agency configuration through the SDK to read
routes and transactional mutation hooks; request bodies cannot override it.

Payments to date include cash, signed successful JVs and Corrections through the
selected month, excluding Credit Memo recoveries. Credit memos separately include
posted recovery through the selected fiscal year regardless of received month.
Credit memos for reconciled periods are attributed through their AR's source
Payment or Claim and require successful final reconciliation covering the full
source period. Selecting that source period again does not make its credits
reconciled. Both credit totals remain visible. Reimbursement entitlement is Claims
minus (payments to date minus the Agency's selected credit total).
Advances replace forecast through the last eligible Claim month with those Claims,
add forecast through the selected month, then subtract the same net paid amount.
For $2,000 reconciled Claims, $3,000 forecast to the Claim month, $9,000 forecast
to period end, $5,500 paid and $500 Credit memos for reconciled periods, the advance
is $3,000 when the Agency selects reconciled periods, even when total Credit memos
are $1,000. Selecting all Credit memos instead produces $3,500. Host-provided net
availability includes all Credit memos. The extension subtracts credits outside
the selected basis from that availability before reserving holdback, using the
same credit choice as entitlement.
Earlier fiscal years accumulate, while later Claims
and forecast remain outside the selected cutoff. There is no currency conversion.

The extension rounds holdback down to whole dollars, reapplies the reserve each
calculation, caps it at unpaid eligibility and caps elected release at that reserve.
Final-fiscal basis includes an empty final current year. Each Payment is capped at
entitlement, Commitment/shared-coding capacity, availability plus elected release,
and `numeric(19,2)`; aggregates retain cents and can exceed one persisted row.
`availableBeforeHoldback` retains its established meaning of ordinary funds after
reserving holdback.

A suggestion is a ceiling, not a required amount. The calculator preserves an
explicit amount choice, including cleared/invalid editing state. Financial selection
and release changes recalculate the ceiling without replacing that choice. Create
and update guards re-read host inputs and extension calculations under the Agreement lock and reject
amounts above the live ceiling. Amount keystrokes do not change calculation inputs.

Creation stores `payment-metadata.calculationEvidence` in extension KV under
`fundingcasepayment`. Version 1 captures the selection, agency credit basis, timestamp and all ten
calculation details together with the exact ceiling, reserve and currency. The
Payment calculation tab reads this creation-time snapshot without recomputing or
enriching it from live financial records. Missing preexisting snapshots have an
explicit empty state; corrupt authored evidence returns a localized error. The
read route uses the host-dispatched Payment scope with Agreement Viewer authority
and Agency/Stream extension enablement. English/French presentation, retry and
stale Payment response protection belong to the extension. Existing holdback
release metadata remains readable by update guards. Older version-1 snapshots
without start month or either Credit Memo field remain readable and are never
enriched from live data. Earlier snapshots with `totalCreditMemosForPayment`
retain their historical “Eligible credit memos” label and calculation result;
current calculations publish only total Credit memos and Credit memos for reconciled periods.

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
source selection; owner tests verify entitlement and holdback mathematics. The managed lifecycle journey
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
optional grep selects the independent fixed-input journey, including all ten
creation-time evidence values after Payment approval. The full suite also includes
an Outcome Cost Allocator journey; that extension's migration to the new coding
allocator remains outside this change.
