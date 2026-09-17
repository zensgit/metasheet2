# Manual Capture Attachment Inventory

Status: internal metadata checkpoint; authenticated attachment capture OPEN.
Parent: `347a31620b62f564fa4b7ca0d51f7e80ec76c2df`, PR #5849.

## Design

`readRecoveryArchiveCaptureSource` returns the seven existing relational
sections and `attachmentCandidates` from one SQL statement. The previous
seven-section helper delegates to this reader. Missing inventory is an error,
not an empty archive attachment section.

The inventory includes all metadata rows scoped to the selected live table and
base/workspace, including unbound, deleted and blob-purged entries. It retains
the physical storage locator internally, exact decimal size, media type and
nullable record/field bindings. Non-null bindings must occur in the captured
table. Duplicate IDs and malformed metadata refuse with a fixed values-free code.
Candidates are copied and sorted; later mutation of provider results cannot
change the returned scalar metadata.

This is not `attachments_index`: a database storage path or storage file ID does
not establish immutable object identity, content digest, existence or receipt
verification. Do not send candidates as public DTOs or use this reader as an
authorization check. No object IO, provider pin, permission proof, upload or
publication is performed here. Unbound/purged eligibility remains a decision for
the complete coordinator, not a reason to silently omit metadata in the reader.

## Local Verification

- Source unit plus canonical-row neighbor: 40/40 PASS.
- Existing full-schema acceptance driver: fresh canonical migration stream and
  second no-op migrateToLatest PASS. No migration body replay claim.
- Populated inventory includes live attachment and deleted/unbound/purged row;
  an attachment on a different table is excluded. Bigint precision preserved.
- An atomic writer changes schema, records and attachment size. A second
  connection sees the prior state before commit and retains that state within
  REPEATABLE READ after commit. A fresh read sees all new values.
- Mutation: filter out deleted attachments in the SQL. Full-schema acceptance
  fails with the expected missing unbound attachment; restore query and PASS.
- Typecheck for the archive acceptance project, source ESLint and diff-check PASS.
- Independent Terra high read-only review: no concrete P1/P2 in this bounded
  loader delta. It ran no tests or database operations; session closed.
- Independent cleanup census: zero task-prefix databases and connections;
  dedicated PostgreSQL stopped and its owned data directory removed.

This is local synthetic PostgreSQL 15 evidence, not a required-CI attachment
storage round trip. Unit SQL-census assertions cover the inventory query in the
existing backend unit lane. Public manual capture and repeat-capture source
seals remain incomplete. No flags, customer storage, dispatch or deployment.
