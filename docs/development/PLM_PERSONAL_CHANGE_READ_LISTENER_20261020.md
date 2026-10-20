# Standing personal BOM change listener — 2026-10-20

This slice connects the encrypted `yue_` enrollment to the existing BOM change
listener, fact verification, cursor, inbox, completion event and notification
worker. It does not create another approval or delivery engine. The Native and
Meta source changes remain local candidates held behind #363's valuable job;
all PRs stay Draft. Installed images predate these changes.

## Standing authority and explicit start

A Native personal change-read grant is standing consent with its own expiry. The
browser session that authenticated enrollment remains immutable provenance; its
expiry does not silently revoke the separately confirmed grant. Background reads
need no browser cookie. They do require the current managed identity link/source
binding and generation, exact Native subject/tenant/org/root/connection, Meta
user and both Meta memberships, source owner/configuration epoch, owner epoch,
current registration, exact review/base/sheet and current sheet-management ACL.
Current Native authorization is checked by the independent Native grant endpoint
on each page/fact request. No Meta user ID substitutes for the Native subject.

The standing path locks the managed link/source binding before the review and
listener. It acquires the persisted source row after the review lock and compares
its current fingerprint/epoch, avoiding a new source-before-review lock inversion.
It never decrypts shared source credentials or resolves the cached source adapter.
The server's existing worker receives the independent personal provider through
its existing service dependency injection.

A new explicit personal browser start endpoint requires current managed browser
authentication, target authority, registered Origin, JSON and
`x-plm-change-read:start`. Existing normal-bearer listener and direct intake routes
also pass the authenticated Meta tenant. Personal activation/status/intake refuse
a wrong target tenant. Background/internal intake uses its frozen standing target
and current memberships, independently of a browser request.

Start obtains a fresh empty baseline and persists its head cursor only after
revalidating authority and CAS. It cannot consume historical changes. Polling uses
only personal page requests; applicable facts use only the same independent
personal purpose. Plugin replies are independently parsed against frozen scope.
Current authority, personal revision, generation, policy and cursor are rechecked
after awaits, including empty pages. Stopped personal listeners cannot perform
direct fact reads. A late response cannot revive a replaced or unlinked listener.

Existing inbox insertion and cursor advancement remain one transaction with the
existing completion-event trigger. Concurrent workers cannot create a second fact
or completion. A failed cursor commit rolls back inbox and completion together.
Completion preparation reuses the personal standing context instead of decrypting
shared credentials; existing delivery also re-verifies the stored Native fact.

Read flags are exact-true/default-off. Other values close reads without a shared
fallback. Expiry, current link/subject/membership/target changes and received
Native revocation stop admission. Temporary provider errors retain pending work.
The unlink-retirement migration must be present before admitting personal reads.

## Unlink, retry and recovery

A PostgreSQL trigger in the existing managed unlink transaction archives the
frozen encrypted personal credential, clears local access, rotates personal
revision/listener generation and stops the listener. This applies even to an
enrolled listener that has not started. If unlink rolls back, none of those effects
persist. Historical consent and retired identity evidence remain intact.

The existing notification worker drains the existing retired queue even with
personal reads off and no active bindings. It introduces no new timer. Drain
admission stops with the package worker; stop awaits its in-flight cleanup.
Queries are bounded to 50 authority groups and 50 grants per group, oldest update
first, so an unknown key is retained for retry without permanently starving newer
entries. Frozen Native authority is used even if current source/identity changed.
Only exact acknowledgement marks revoked; local failures/unknown outcomes retain
ciphertext, and received hard refusal is reported separately as rejected.

Rollback uses NOWAIT locks and refuses any existing consent/retirement evidence.
No historical grants, PB/HOLD evidence, thresholds or baselines are erased.
Source/owner changes retain the existing synchronous listener-stop/authority epoch
mechanism; current checks also refuse starting stale consent. Automatic retirement
on every source configuration change is not claimed by this slice.

## Evidence and independent counterexample

- New PostgreSQL integration controls: 24 distinct cases qualified cumulatively
  with focused failed/new-case selections. Existing 21 enrollment cases were not
  rerun. Native provider replies in this worker PG profile are controlled; these
  are real Meta schema/ACL/locks/trigger/encryption/process tests, not real Native
  HTTP or browser-authentication acceptance.
- Positive flow: a naturally expired immutable browser session still permits a
  separate valid standing grant; start skips head=5 history, one later event is
  independently fact-checked, cursor becomes6, inbox/completion each contain one.
- Separate Node processes prove persistent worker recovery and simultaneous
  polling: one process commits, the other is superseded, with one inbox and one
  completion. A child held at its page await cannot commit after parent unlink.
- Rollback injection after inbox/completion creation and before cursor advancement
  leaves all three unchanged; a subsequent normal pass commits successfully.
- Real Meta membership/target ACL loss after page/fact awaits refuses commit.
  Source epoch ABA during baseline, expired grants, non-true flags, stopped direct
  intake, current link revocation and received provider revocation are covered.
  Unlink rollback/commit and frozen cleanup with reads off use actual PostgreSQL.
- Independent review found a real tenant boundary bug: the old activation API
  accepted the correct Meta actor with a foreign authenticated Meta tenant and
  issued a Native baseline request. The retained red case returned active/cursor5.
  The surgical repair passes the request tenant through routes and validates it
  against the frozen personal target. The corrected negative and browser-start
  positive/status/direct-intake controls pass before any unauthorized read.
- First worker PG attempt:9 passed,2 fixture failures. Existing immutable-session
  and immutable-link guards correctly refused direct edits. Tests now let a short
  real session naturally expire, assert subject immutability, and revoke the link
  through its allowed state transition. No immutable guard was disabled.
- Changed existing legacy listener/intake/outbound-delivery PG profile:11 selected
  tests passed in a fresh owned database;121 unrelated cases deselected. Existing
  worker/service units29 passed, including two new cleanup lifecycle cases.
  Route and source-verification units12 passed. The changed tenant-routing case
  and new managed-start route each passed separately after their changes.
- Full backend TypeScript project validation and staged whitespace checks pass.
  Test options and production policy gates are unchanged. The initial unit list
  named a missing router file; only the two actually discovered files count in
  its29 cases. The correct route file was subsequently run explicitly.

Raw attempts, including the independent tenant red and fixture failures, remain
in the compact local evidence index. All data are owned QA fixtures. No real
business notification, production deployment or external-device acceptance is
claimed. Read-only dependency symlinks were reused without package changes.

## Remaining whole-goal work

The actual Native-issued grant plus real Meta authentication/browser enrollment,
listener, owned HTTP delivery and cross-process restore still need one combined
proof. Frontend enrollment/start, persistent Native connection configuration,
capability reporting and new installed images remain open. Reuse existing Meta
install/upgrade/health/backup/disable engines for package validation, then continue
the full W01–W23 census, including Native standalone and the remaining
Visual/Discussion/SSO/revocation/DP1/Stage A/RG/version requirements. Current
source-process evidence does not qualify the previously built images, installation
or production/long-term acceptance.
