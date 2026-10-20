# Personal BOM change-read enrollment — 2026-10-20

This slice enrolls an independently confirmed Native `bom_change_read` grant in
MetaSheet's existing BOM listener row. It does not yet implement the personal
listener worker or qualify an installed package. Publication remains held behind
Yuantus #363's valuable performance job. No merge, deployment or production
activation is authorized.

## Authority and behavior

The browser must have a current managed session and identity link, current Meta
user and both Meta memberships, and actual sheet-management permission on the
existing BOM review. The source owner, source fingerprint/epoch, owner epoch,
current registration, active review binding and audited enabled change policy are
locked and checked before and after the external Native verification. A concurrent
identity, permission, source, binding or listener change refuses installation.
Native and Meta tenant/organization/subject identifiers are checked separately.
The Native connection must be explicitly persisted in
`source.config.options.personalChangeReadConnectionId`; no SSO client, Meta
source ID, shared bearer or Meta user ID substitutes for it.

The shared browser authority lock is extracted from the existing snapshot flow.
Each caller retains its own purpose gate. Personal read enrollment does not need
the snapshot-share flag. `PLM_PERSONAL_BOM_CHANGE_READ_ENABLED` accepts only exact
`true`; personal unbind and frozen remote cleanup remain available with read off.
The source metadata path does not decrypt or use stored shared credentials.

Management links use the persisted authority and the existing Native consent UI.
The Native verify reply is independently parsed, including purpose, public grant
ID, expiry, exact Native subject/root and exact Meta target/review version.
Credentials are encrypted before storage, never returned by state endpoints and
redacted before the existing HTTP audit observes even an authentication denial.
Browser mutations require the registered Origin, JSON content type and explicit
`x-plm-change-read` action. Responses, including authentication errors, are no-store.

Enrollment stops the existing listener and rotates its generation and personal
revision. Existing cursors are preserved; explicit future start must establish a
fresh baseline. Same credential/same authority is idempotent. A changed provenance
may renew the same credential without retiring and remotely revoking the still
current key. A retired credential cannot be installed again under the same frozen
Native authority. Distinct replacement credentials retire the old encrypted key.

Unbind atomically stops access, rotates generation/revision and archives the old
key for cleanup. The cleanup queue belongs to the existing listener. It uses the
stored Native authority and global personal provider, independent of the current
source adapter. Unknown transport/local failures retain the encrypted key for
retry. Only an exact null revoke acknowledgement records `revoked`; an actually
received hard 4xx records `rejected`, separately exposed to callers, without
claiming revocation. Local preflight 403 is not a received remote refusal. Terminal
cleanup removes ciphertext while retaining immutable authority evidence.

Migration rollback takes NOWAIT locks and refuses any personal authority or
retired evidence, including expired, unbound and revoked rows. It never erases
historical authorization evidence to make rollback appear successful.

A standing Native grant outlives the browser session that authenticated enrollment.
That session is consent provenance, not a worker cookie. The pending worker must
fresh-check link/generation/Native subject, Meta user/memberships, source/owner,
target ACL and the Native grant before and after requests. It must never fall back
to shared credentials under any flag value.

## Actual validation and retained failures

- PostgreSQL 16 real-schema integration: 21 distinct cases qualified cumulatively
  by initial and selected failed/new-case runs. Previously passed cases were
  deselected, not counted as conditional runtime skips or a single all-case run.
  Real Meta locks/ACL/configuration/audits/encryption/migrations were used; Native
  verify replies in these PG tests were controlled fixtures.
- Two independent Node processes raced enrollment: one consented credential won
  CAS and the other received 409. A separate PG reader made downgrade fail with
  SQLSTATE 55P03. Empty migration down/up passed before any evidence existed.
- Covered current and post-await target ACL loss, separate Meta organization,
  wrong Native subject and tenant, API-key refusal, four additional valid-shaped
  Native scope mismatches, encrypted persistence, unknown cleanup/retry, immutable
  retired evidence, exact revoke acknowledgement, hard-refusal reporting, retired
  replay and distinct replacement, plus provenance renewal.
- A real counterexample found same-key provenance renewal retired and revoked the
  newly installed current key. The retained red run precedes the surgical fix;
  the targeted green run proves no retirement or remote revoke on that renewal.
- Existing affected BOM service/routes: 22 passed. Existing snapshot publication,
  history, idempotency, separate-process replay and current membership controls:
  3 selected cases passed, 11 previously unrelated cases deselected.
- Actual existing HTTP audit middleware: two new cases proved no plaintext grant
  in the audit for successful enrollment and authentication denial. Additional
  transport assertions distinguish local preflight from received provider errors.
- A separate actual Node-to-Native HTTP revoke-only phase passed: real Native
  revoke followed by fresh Native 401 with `responseReceived=true`, DB verified,
  owned server stopped and temporary runtime removed. It did not repeat the
  previously accepted fact/page profile.
- Full backend TypeScript project validation passed after the final source change;
  `git diff --check` passed. No compiler options or policy thresholds were relaxed.

Initial PG fixture failures violated existing 300-second intent/600-second session
limits; only synthetic TTLs were corrected. A negative fixture changed base owner
but left an explicit sheet-admin grant valid; the fixture now revokes the actual
sheet permission and restores it for its positive control. Neither was repaired
by weakening product authorization. Wrong-working-directory commands found no
tests and are not passing evidence. Raw red logs are retained in the compact
receipt's local evidence index.

The owned Unix-socket-only PG cluster and two named QA databases are retained for
subsequent worker tests. Compatibility used a new owned socket alias to satisfy
the unchanged older test's safety guard. This is not a separate installed system,
a same-runner MinIO drill or production proof. Synthetic keys vary per test
process; old fixture ciphertext is not future functional proof.

## Remaining acceptance

Actual Native-issued yue enrollment through real Meta browser authentication,
background current-authority checks and unlink/source hooks, retry draining,
explicit baseline/start/receive/cursor integration, frontend enrollment and source
configuration, cross-process recovery and updated installed images remain open.
The current installed Native/Meta images predate this feature. Prior package
installation and restore evidence does not qualify these new paths. Whole W01–W23
engineering acceptance remains incomplete.

Source commit: `491cdbed1b5b8c3ab720e73e46809ae860968af3`. Compact evidence index:
`artifacts/plm-personal-change-read-enrollment-20261020/verification.json`.
This is the single source-closeout document commit; remote head CI is pending
held publication.
