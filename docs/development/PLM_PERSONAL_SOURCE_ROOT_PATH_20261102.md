# Personal BOM Source root-path admission

The persisted Source resolver previously accepted a non-root URL such as
`https://native.invalid/prefix`. Global READ could retain that path while personal
grant management and transport used `URL.origin`, targeting the host root. This
change rejects a non-root parsed pathname before admitting a personal BOM binding
or using its frozen write target. It preserves the established root transport.

Source commit: `a14eaf393986b15cf52552055e241e950a5d4d86`.
Parent: `b067193daa524d0ce2afddcd7c9bb3d0c4a528d1`.
Branch: `codex/plm-personal-source-root-path-20261102`.
This is a local static delivery; it has not been pushed or assigned a new PR.

## Behavior and compatibility

The only production change is `origin.pathname !== '/'` in the existing
`resolvePersistedPlmSource` URL guard, with a comment explaining the target
divergence. Both `https://host` and `https://host/` retain their existing behavior.
Parsed `/prefix`, `/prefix/`, and `/%2F` paths fail with the existing forbidden
error. Standard URL parsing and all other validation remain unchanged.

This narrows personal BOM admission for previously accepted prefixed Sources.
Ordinary READ is unchanged. A Source that changes to a prefix after binding cannot
be rebound, used, frozen for a new operation, or sent through a previously admitted
intent. Its owner can still inspect and unlink the old binding under the existing
ownership and membership rules. Retired revocation retries use the original
frozen origin, Native tenant/org, connection, and exact grant.

No binding-service, transport, schema, feature flag, permission, lock, generation
CAS, retired-secret settlement CAS, or intent fingerprint code changed. Owner
cleanup still clears the local binding secret before the remote attempt and keeps
the retired ciphertext for an unknown result until a terminal retry settles it.

## Authored coverage and static review

The three existing test files add or adapt cases for:

- Object and JSON Source configuration with both root spellings, and rejection of
  non-root paths before provider verification, fetch, or binding insertion.
- Same-origin pathname change after an intent commits, using the existing
  no-send assertions.
- A root binding followed by a Source prefix change: denied new use, retained
  frozen target, denied wrong-owner cleanup, owner unlink with the feature disabled
  and membership lost, unknown remote result, and a new service instance retrying
  the original authority. Actual adapter method spies and fetch assertions exclude
  stale adapter URLs and shared credentials from the personal request.

Grok Build session `gbt-5e78-1a198150359-3` implemented the bounded change and
corrected one mock parameter type issue in the same session. Requested model and
effort were Grok4.7/high; the CLI TUI reported Grok4.7/xhigh. Backend deployment
identity is UNKNOWN. The session completed and was closed after review; the coding
bridge remains available. Terminal retention has a gap, so the evidence does not
claim a complete command history.

Independent review requested Sol6.1/high, with actual model/effort UNKNOWN. Its
final delta review found no known static blocker. Root verified the seven-member
artifact SHA256/byte map, the unchanged read-only inputs, and byte-exact integration
of the four source/test files. `git diff --check` passed. The earlier mock typing
finding and preliminary candidate are retained in the evidence.

## Validation limits

Tests, type checking, lint, builds, application imports, HTTP, databases, browser,
and product runtime are **NOT_RUN**. The new cases are authored and statically
reviewed; no execution or PostgreSQL concurrency result is claimed. Existing
passed qualifications were not replayed. Old compiled artifacts do not contain
this local increment.

Head-only remote observation before this commit found main
`5d0798ce59e88a71ae4fa37ea16e08f0636f9906` and the unchanged published #6684 head
`8d237dac8ef6f168353d7cf8806a878e026bd0e5`. This local stack is not main-rebased.
Existing #425/#6425/#6684 source and document heads remain fixed; no new CI was
started or old terminal jobs polled. Future integration and runtime gates remain.

Evidence is retained under
`artifacts/plm-listener-review-20261015/unattended-12h-20261101/grok-tool-restore-20261101/personal-source-root-path-20261102/`
in the state-owning review worktree. Key receipts are
`Root-final-artifact-receipt.json`, `Sol-final-delta-independent-review.json`, and
`Root-static-integration-acceptance.json`.

The N2 lease and all HOLDs remain untouched. This delivery does not qualify the
real Meta/Native Source and grant pair, BOM write, installation, browser, or
business acceptance. All seven packages remain OPEN. No merge or deployment is
authorized. This is the single closeout document for this source slice; later
results update records or PR body only.
