# Local approval unlink after provider drift

An active MetaSheet owner could lose the ability to clear an old personal approval
binding when its current provider became unavailable or its configured connection,
tenant, or organization changed. `unbind(..., credential=false)` still consulted
the current provider before reaching its local cleanup statements. A provider
exception or scope mismatch therefore rolled the transaction back.

Source commit: `fdb287e32a9dbe19e42fb21fdae7615dd6add758`.
Parent: `cf14dbe83a9475decfb803628c1358f49d542088`.
Branch: `codex/plm-approval-local-unlink-20261102`.
This is a local source delivery; it has not been pushed or assigned a new PR.

## Change and preserved authority

The existing binding service now shares an `ownedBinding` lookup between normal
bound operations and local unlink. It retains the module/configuration gate, the
active MetaSheet owner check, and the exact binding ID plus owner lookup under
`FOR UPDATE`. Local unlink uses this lookup without consulting the current
provider. Normal bound operations still check the current provider scope and
require an unexpired stored credential. The obsolete private credential switch
was removed; all six remaining callers already pass three arguments.

The transaction and three cleanup statements are unchanged: clear the stored
credential and increment generation, deactivate projected tasks, and mark sent
local cards revoked. Saved identity and unresolved command evidence remain. The
module-off and invalid configured-connection behavior are unchanged. A wrong
owner, inactive owner, or missing binding still cannot perform cleanup.

Local unlink does not revoke the Native bearer. The Native management entry and
its independent issue/verify/revoke lifecycle remain separate. Neither DELETE 204
nor a local card state named `revoked` proves Native revocation or full N08
acceptance.

## Static validation

The existing contract test retains its original 1,746-byte prefix and adds six
test blocks for unavailable or drifted providers, changed connection, expired
stored credential, cleanup denials, and strict public bind refusals. Verify mocks
use the real strict seven-field schema; the scope negatives require the existing
typed 403 before an existing-binding lookup or insertion.

The PG double records queries and parameters. It does not execute SQL or mutate
database rows. Its observations specify cleanup calls, owner admission and idle
provider/fetch behavior; they do not prove PostgreSQL state changes, locking,
isolation, or remote revocation. Tests, type checking, lint, builds, application
imports, HTTP, databases, browser and product runtime are **NOT_RUN**.

Root verified the six-member Grok archive SHA256 and byte map, three unchanged
read-only inputs, and the original test prefix. Root reassembled the changed
binding prefix with the byte-exact 13,981-byte original service suffix:
`771168b2fcf40ce584712d58bb696a6c0da103d9d224da7915f062fbabe895e9`.
Imports, transaction handling, owner checks, scope-check implementation, secret and
bind code are unchanged; the unlink body differs only in its lookup call. The
credential predicate is unchanged and now unconditional for normal bound callers.
`git diff --check` passed.

Grok Build session `gbt-5e78-1a198381d34-4` supplied the implementation and corrected
the preliminary verify fixture in the same session. Requested model/effort were
Grok4.7/high; Root observed Grok4.7/xhigh in the CLI TUI. Backend deployment identity
is UNKNOWN; the author's own effort field remains UNKNOWN. Root removed redundant
test checks, strengthened the connection-drift positive control and removed one
redundant grouping pair. Independent review requested Sol6.1/high, with actual
model/effort UNKNOWN, and found no known static blocker in the final prefix/test.
The model session was closed after review; the bridge reports zero model sessions.
This is not a global host-idle claim.

## Delivery limits and evidence

Head-only remote observation at approximately 2026-11-01 18:15 UTC found main
`b28538e328f754abba38553766537af2c4651894` and the unchanged published #6684 head
`8d237dac8ef6f168353d7cf8806a878e026bd0e5`. This local stack is not main-rebased.
Existing #425/#6425/#6684 source/document heads remain fixed. No new CI was
started, old terminal jobs were not polled, and old compiled artifacts do not
contain this change. Future integration and execution gates remain.

Evidence is retained in the state-owning review worktree under
`unattended-12h-20261101/grok-tool-restore-20261101/approval-local-unlink-20261102/`.
Key receipts are `Root-final-artifact-receipt.json`,
`Root-small-final-delta.json`, `Sol-final-local-unlink-independent-review.json`,
and `Root-reassembly-and-static-guards.json`. Preliminary fixture defects and
controller observation failures are retained; terminal retention is incomplete.

The N2 lease and all HOLDs remain untouched. This slice does not qualify the real
Meta/Native pair, approval execution, BOM write, installation or business flow.
All seven packages remain OPEN. No merge or deployment is authorized. This is the
single closeout document for this source slice; later results update records or
PR body only.
