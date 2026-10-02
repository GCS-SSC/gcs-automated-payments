# gcs-automated-payments

## Audit ownership

The extension creates no dedicated tables. Payment metadata uses `extensions.kv_entry` with owner type `fundingcasepayment`; the host resolves Payment → Commitment → Agreement → Program stream → Agency.

The manifest targets SDK ^0.3.7 and explicitly declares its dedicated tables (an empty
list when there are none). Extension migration journals remain global infrastructure.

Run `bun run test:audit` from this extension inside a GCS-SSC host checkout with
`tooling/gcs-ssc` available. The extension owns its concrete fixtures; the private
host adapter exercises the real audit migrations, declaration publication, row
triggers, both ownership interpreters, rollback and immutable historical audiences.
These reduced-schema ownership fixtures complement the extension’s normal tests.
Set `AUDIT_EXTENSION_POSTGRES_URL` to a disposable PostgreSQL database URL ending
in `_test` to run the same suite on PostgreSQL; the adapter creates and removes an
isolated database. Without that variable, the suite uses in-memory PGlite.


Payment commitment ceilings use the SDK 0.3.5 `agreement-payment-capacity` host capability. The calculator passes the stable Agreement fiscal year, Agency commitment type, and the current Payment exclusion when recalculating. The host owns commitment selection, denied-Payment coverage and signed finalized JV/reversal effects, including shared Agency chart coding pools. The extension retains its claims, forecasts and holdback calculations and stores no JV-derived allocation versions. Capacity is exact aggregate decimal text.

SDK 0.3.6 also supplies correction-aware cumulative recorded paid totals by fiscal year and period. The calculator consumes those totals independently of shared capacity; protective line floors never become paid-to-date totals.

## Payment calculation rules

Reimbursement entitlement is successful reconciled claims minus cumulative corrected recorded paid. Advance entitlement replaces forecast through the last successful claim month with successful reconciled claims, adds forecast through the selected payment month, and subtracts cumulative corrected recorded paid. Negative entitlement produces a zero ceiling. Fiscal periods use April = 0 through March = 11; earlier fiscal years accumulate, while later claims and later-year forecast do not enter the selected-period entitlement.

Product decisions confirmed October 2, 2026: one immutable currency per Agreement; whole-dollar floor holdback; recurring reserve clipped to unpaid eligibility; final-fiscal basis uses the final current Agreement fiscal year even when funding is zero.

The full holdback is the owning Agreement percentage applied exactly to either all current budget funding (`fullagreement`) or the final fiscal year's current budget funding (`finalfiscal`), **rounded down to whole dollars**. The final year comes from current, nondeleted Agreement budget fiscal-year parents; a final year with no live funding lines contributes $0. Historical/deleted versions do not extend that horizon. Percentage precision follows the stored `numeric(5,2)` field. Claims, forecasts, cash, JV effects, Corrections and payment amounts retain cents.

Every calculation applies that full holdback again. Gross unpaid eligible balance is successful claims plus unclaimed current-year forecast plus future-year budget funding, minus corrected recorded paid, clamped to zero. The current reserve is the lesser of that balance and the full rounded holdback. Ordinary available funds are the balance minus the current reserve. Elected release is capped at the current reserve; it increases ordinary availability for this calculation. Prior releases do not reduce the full holdback and are not counted separately. For $1,000 eligible funding, $950 recorded paid and a $100 full holdback, the entire remaining $50 is reserved: no release gives a zero ceiling, releasing $25 gives $25, and requesting $100 releases at most $50.

The single-payment ceiling is the least of nonnegative entitlement, the host SDK's exact commitment/shared-coding capacity, ordinary availability plus elected release, and the persisted `numeric(19,2)` row limit ($99,999,999,999,999,999.99). Aggregate amounts retain their complete exact value even when larger than one row.

`holdbackAmount` now uses whole-dollar rounding; `holdbackReleaseAmount` is the elected amount bounded by the **current** reserve; `availableBeforeHoldback` continues to expose ordinary available funds. Existing metadata remains readable by update validation, but saved prior release metadata no longer influences later calculations. The pure helper's internal `availableForDisbursementBeforeHoldback` input now carries gross unpaid eligible balance. `holdbackAlreadyReleased` and the calculation-only Payment/metadata queries are removed.

Each Agreement has one required, immutable native currency. Every Payment must match its owning Agreement; different currencies require separate Agreements. The calculator first reads `Funding_Case_Agreement_Profile.egcs_fc_currency` and rejects a missing/invalid denomination or a differing request before reading amounts or calling financial services. Budget, Forecast and successful Claim/Reconciliation lines are filtered defensively by that currency, and both SDK paid-to-date and commitment capacity services receive it. Reconciliation currency comes from its source Claim line. There is no exchange-rate conversion or addition of different currency units. Full-agreement and final-fiscal holdback bases use the single Agreement currency. An empty paid ledger contributes zero; a nonzero ledger without a matching currency is rejected. Disabled extension payment types still defer to the host's native-currency Payment validation.
Before this change, HTTP calculation requests omitted currency and every result was labelled `CAD`. Requests now carry lower-case `egcs_fc_currency`; results carry the selected upper-case currency code. The host calculator model supplies `model.currency`, creation/update hooks use the actual Payment currency, and created rows must match their request currency. Omitted currency defaults to CAD for existing standalone callers; cleared/invalid explicit currency does not default. Saved release metadata retains its existing shape. The UI keeps the selected currency, clears the previous calculation while recalculating, ignores stale responses, and rejects a current response for another currency.

The independently authored unit financial ledgers cover advances below/above claims, reimbursement underpayment/overpayment, signed SDK JV/Correction totals, fiscal boundaries, shared coding capacity, rounded holdback and large exact amounts. `tests/integration/calculation-ledger-postgres.test.ts` executes the extension's source queries against PostgreSQL to verify current/stable budget roots, successful latest reconciliation attempts, inactive/deleted rows, fiscal cutoffs and exact NUMERIC transport. Host projection mathematics remains owned by host tests and is supplied through the SDK in this suite.

Run `bun run test:e2e` in this package for the managed lifecycle browser journey. It verifies JV reversal/replacement, posts a separate signed Correction through public host APIs, checks corrected paid-to-date and capacity, preserves the source Payment and Outcome Allocation snapshot, and generates a later Payment against the revised capacity. The journey saves screenshots of the posted Correction and generated Payment. Standalone unit tests inject the public financial service; PostgreSQL tests retain the extension's transaction/metadata checks. Core financial rules and permissions are tested by the host.

The same managed suite includes a fixed-input browser journey with $1,000.05 funding and Commitment, $1,020.05 submitted claims, and $1,000.05 accepted reconciliations. It checks the advance overpayment, reimbursement shortfall, repeated $100.00 holdback, unused release election, and final $50.00 reserve/release. Each calculation rejects a one-cent overrun without creating a Payment; accepted Payments are checked in the calculator, persisted detail, and loaded detail page. Set `GCS_PAYMENT_AUDIT_DIR` to retain `automated-payment-scenarios.csv`, the source ledger and raw JSON, and the JV/Correction checkpoint CSV/JSON outside Playwright's replaceable results directory. A suggested ceiling is distinct from the amount actually selected and paid; both are logged.
