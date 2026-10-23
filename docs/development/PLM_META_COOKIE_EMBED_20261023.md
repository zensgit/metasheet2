# Managed BOM embed cookie route — C2b

Source commit: `23a2374545f351ba269b26c52117e92498bf59db`. Backend slice accepted locally; unpublished. Whole window goal remains in progress.

The existing server-configured BOM embed route now authenticates the dedicated managed cookie through the existing JWT middleware and AsyncLocalStorage before using the existing personal relay. Signed native embed claims independently match native subject, tenant, organization, root part and Meta OAuth client origin. Meta subject/tenant/organization are never substituted. Frozen Native installation origin remains the existing relay fingerprint. Ordinary or mixed Authorization is refused, and a managed request cannot switch to the legacy adapter after unlink or another refusal. Proven unbound sources retain the token-only legacy path without credential conflicts. Existing shared single-use JTI consumption remains fail closed.

## Independent validation

- Full backend typecheck (including recovery archive project): exit 0.
- Embed routes and JTI unit suites: 54 passed.
- Full owned PostgreSQL 16.15 / UTF8 managed gate: 133 passed in 4 files, zero skipped, 52.63 seconds. Native transport is explicitly a process-local fixture; Redis is a process-local double.
- Two additional root PostgreSQL probes: both immutable identity guards reject direct identity changes; actual unlink and provision of a new subject during the JTI wait causes the old cookie request to refuse 403 without the shared adapter. The 14 reused fixture tests were unselected only in this focused probe.
- Both root-owned clusters stopped and removed with matching ownership nonce; `65ed5874c0d5b678` and `92fc907bb74ff7bb`.
- Final four source hashes remained unchanged during validation. Evidence manifest: `3720176d48a348c8f0704544dece3815bb1e2de3668603c9328ae2fed216c0f0`. Local immutable bundle: `/Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/w10-meta-c2b-root-green-20261023`.

## Counterexamples and limits

Root initially reproduced incorrect comparison of Meta embed origin with Native frozen origin. The repaired fixture uses distinct Meta and Native origins, and the original RED is retained in `w10-meta-c2b-origin-red-20261022`.

Two exploratory raw-UPDATE probes expected 403 but observed 401/503 because immutable database triggers rejected their attempted mutation. These are failed probe assumptions, not demonstrated identity leakage. The explicit guard and actual unlink/reprovision probes above replaced that assumption without disabling any guard. Exploratory outputs remain in `w10-meta-c2b-root-review-20261023`.

Grok 4.7 implementation report was independently checked. Its prior session handle was no longer available and runtime listed zero active sessions before root committed; no concurrent writer was observed. No code in accepted C2a was changed.

This does not establish original iframe continuity, cross-process Native/Meta transport, real elapsed-hour behavior, current fixed-image installation, upgrade, backup/restore, production or business acceptance. Continue the original window goal and preserve Draft publication ordering.
