# Managed Discussion view and existing panel transport

Source `b6d241c0bf3595a48d3c23379f9205f606b3e2ca` adds the managed frame route `/plm/managed-discussion` and a same-origin managed transport to the existing Discussion panel. List, detail, create, comment, resolve and reopen use the existing panel and engine. No Visual UI or shared-credential fallback is admitted. A supplied empty source remains a refused managed request rather than selecting legacy transport.

Initial parent messages are candidates until the authenticated context endpoint checks the current managed source and Native origin. Only the actual parent is accepted; repeated initial messages do not repeat the context probe. Tokens remain in memory. Each later operation uses the existing fresh-token protocol. Source changes, browser identity changes and unmount clear context and invalidate old asynchronous responses. Missing Meta authentication opens the existing explicit managed-entry flow in a new noopener/noreferrer tab, preserving the Native frame owner; an opener is never an authority source. Backend cookie/JWT checks remain mandatory even though this bare page bypasses shell bootstrap.

## Verification

Actual Vitest reports establish **55 distinct passed assertions**: one full53-case run, two added late-response cases, and targeted final versions of initial-message deduplication and the six-operation panel journey. The targeted reports exclude other cases; their aggregate `numPassedTests` fields incorrectly include excluded cases, so the receipt counts individual assertion statuses. Excluded tests are not counted as passed. Vue full build-mode types pass. The existing consumer workflow adds the exact55-case UI gate and keeps the prior174 backend gate.

The production SPA was built from exact source `b6d241c0bf3595a48d3c23379f9205f606b3e2ca` using offline frozen pnpm10.16.1 dependencies, Node20, vue-tsc and Vite. All1971 tracked input blobs match before and after. The output contains167 files with content digest `46fbd4d866ad0fcf639576d7ba16bdbe942f06dca0ce994e50f335d495d2f868` and no symbolic links. This is a real static production build, not an installed package or browser acceptance.

## Remaining acceptance

Native first-party entry, actual edge CSP/same-site cookies, rendered browser operations, installed key-enabled disable/recovery and backup/restore remain separate acceptance work. The earlier917 package71 checks predate this view and cannot qualify it. Current-source Visual and the whole W01–W23 goal remain open. Raw failures, including an initial missing dependency and the corrected detail-selection test fixture, are preserved outside Git; neither was treated as a passing run.

All changes remain local pending #363's valuable queued perf job. Keep Draft, no merge, deployment or production enablement.
