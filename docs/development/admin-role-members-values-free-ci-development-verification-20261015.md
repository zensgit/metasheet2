# Role-members values-free coverage: CI follow-up

## Scope and failure

Bounded follow-up to the already authorized #6410 release slice; no deployment or real-environment configuration changes. Production code, API behavior, and original guard assertions are unchanged.

At published head `6abf4f0183`, Plugin run `38599085010` failed one test among 21,143 passing tests: the newly mounted `admin-role-members.ts` router was absent from the values-free scanner coverage registry. Native reproduction on the qualified combined source `d72982143f` confirmed the same one failure with 137 passes across the coverage guard, AST scanner, and neighboring route suite. Earlier targeted route tests had not covered this separate mount registry.

The same head's Web run `38599085008` reported two failures (11,869 passes): the stock-preparation main-entry import and a multitable rule-editor case, with timeout/dynamic-module errors. Native isolated runs of the unchanged two files passed all 243 tests at `d72982143f`, without timeout increases, test skipping, or configuration changes. This is not proof that the remote failures are permanently resolved; the new exact head must pass fresh full Web CI. No unrelated production or test changes were made to mask those failures.

## Minimal correction

Grok implemented the two-file test correction, frozen at `f3d04a25c0f4d25a9e04045577d3d62456e88e03`:

- Add the route to `SCANNED`, the exact root-mount pin, and the by-name reachability assertion.
- Add a real, live scanner helper/test for this route outside the discovered admin-router tree. Assert its actual source has no caught-error response text.
- Inject a caught-error `.message` into the route's 503 response in a self-proof and assert the exact matching scanner offender shape.

No allowlist, scanner algorithm refactor, weakened assertion, production edit, or changed CI rule is involved. Sol 6.1 medium independently reviewed the exact two-file delta and returned bounded static PASS; the parent separately ran native validation.

## Verification and limits

| Source | Check | Result |
|---|---|---|
| `d72982143f` | Native original coverage/scanner/route suites | One failure, 137 passed: exact missing-registration reproduction |
| `d72982143f` | Two unchanged files from the remote Web failures | 243 passed; no timeout adjustment |
| `f3d04a25c0` | Native coverage guard + AST scanner + neighboring role route | 140 passed |
| `f3d04a25c0` | `validate:all` | Passed |
| `f3d04a25c0` | Delete registry entry, remove live scanner target, inject actual route error echo | All three matching assertions red; original bytes restored and tracked source clean |
| `f3d04a25c0` | Sol independent source review | PASS; does not independently attest native test results |

Mac mini checks used the owned synthetic source/runtime. No backend, web, or database process was started for this follow-up; the prior complete 445-table restore and owned-runtime stop remain intact. Mutation temporarily modified only the owned native source and restored it byte-for-byte.

Only #6410 receives these two test files and this MD. Its future replay onto main must retain these scoped follow-up paths alongside the originally approved independent slice. Common registration and latest-main UNION source remain unchanged. Existing publication/merge authorization applies, but CI success is required on each new head; this report does not claim merge or final main CI completion. Private values-free receipts and the independent review are in `artifacts/admin-issues-20261014/`.
