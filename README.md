# gcs-automated-payments

## Audit ownership

The extension creates no dedicated tables. Payment metadata uses `extensions.kv_entry` with owner type `fundingcasepayment`; the host resolves Payment → Commitment → Agreement → Program stream → Agency.

The manifest targets SDK 0.3.2 and explicitly declares its dedicated tables (an empty
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

Run `bun run test:e2e` in this package for the managed lifecycle browser journey. It verifies JV reversal/replacement, posts a separate signed Correction through public host APIs, checks corrected paid-to-date and capacity, preserves the source Payment and Outcome Allocation snapshot, and generates a later Payment against the revised capacity. The journey saves screenshots of the posted Correction and generated Payment. Standalone unit tests inject the public financial service; PostgreSQL tests retain the extension's transaction/metadata checks. Core financial rules and permissions are tested by the host.
