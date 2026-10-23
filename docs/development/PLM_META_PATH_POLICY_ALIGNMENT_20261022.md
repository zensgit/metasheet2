# PLM path policy alignment — 2026-10-22

Source `27abfadecf3cec7fd0a89c9b26e95b7fe8253339`; base `c61f9e47d31b0c4228c53230d1b45af0ab40a542`. This is a separate three-file repair of two existing API path guard findings.

## Behavior and assumptions

The ingress exception still requires POST, an `mst_` bearer, exact `true` configuration, and the exact ingress path. It now uses the established route-specific anchored allowlist form. A final end-of-input assertion preserves string equality even for trailing line terminators; no lowercase, trimming, trailing-slash or query normalization is introduced.

Discussion response projection follows the actual call contract: the credential exchange has no bearer and returns its credential envelope unchanged; every subsequent Discussion operation uses the validated nonempty purpose credential and applies Visual projection. Source inspection covered every call site. No inbound path policy or extra shared credential fallback is introduced.

The existing path-policy scanner, patterns and exemptions are unchanged. This does not waive the guard or add a file exemption.

## Verification

- Before: unchanged guard reported the ingress equality and outbound Discussion prefix comparison, 3 passed / 1 failed.
- After: **208 tests passed across five files**, zero failures/skips, in 1.79 seconds: API policy, its guard, ingress routes, Discussion relay and the OAPI scope/route tripwire.
- Added ingress exclusions cover LF, CRLF, Unicode line/paragraph separators, changed case and a query suffix, alongside the existing exact positive, method and flag controls. Existing actual-loopback Discussion tests retain independent read/write exchange, identity/source isolation and Visual redaction checks.
- Core `npm run type-check` passed. All dirty source hashes were stable across the check; each of the three committed repair files matches its tested hash. `git diff --check` passed.

Commands (Node 20, from `packages/core-backend`): `./node_modules/.bin/vitest run --config vitest.config.ts tests/unit/api-path-policy.guard.test.ts tests/unit/api-path-policy.test.ts tests/unit/plm-record-ingress-routes.test.ts tests/unit/plm-managed-discussion.test.ts tests/unit/multitable-oapi-allowlist-guard-tripwire.test.ts`; `npm run type-check`.

Receipt: `artifacts/plm-meta-path-policy-alignment-20261022/verification.json`. Immutable red/green evidence manifest: `78874cc507af6416fbabeb4f97fcf71a89faf1d8a10bb69b2882cc62fd5a7ff8`; typecheck/closeout manifest: `9a8b6a6226a711d6da1f9752a71b39691c556516f3bc1d0541d1934661e0e29e`.

## Limits

These checks ran in the isolated working tree with renewal B still uncommitted. Only the three named repair files are qualified here; renewal B still awaits independent drain-race and PostgreSQL acceptance. Publication remains held behind active parent CI. Exact-head CI, original iframe continuity, real elapsed hour, current distribution images, installation/restore and whole-goal acceptance remain separate and open. No merge or production enablement is authorized by this record.
