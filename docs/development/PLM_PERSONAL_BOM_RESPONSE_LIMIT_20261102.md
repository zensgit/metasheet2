# Personal BOM bounded response reading

As of 2026-11-02 Asia/Taipei, this is a local static source delivery. Tests, typecheck, build, imports, HTTP, PostgreSQL, browser and product runtime were **NOT_RUN**. Nothing was pushed; no new PR or CI was created. All seven delivery packages remain OPEN.

Parent: `51440be3a56de37ad79a7eb71fadf511c7564f8f`.
Source commit: `1fa9d22e9af42cc3094a15203c43761bbd506087`.
Branch: `codex/plm-personal-bom-response-limit-20261102`.

## Problem and resulting behavior

`PLMAdapter.personalBomWriteRequest` previously awaited the complete `response.text()` before the wire parser and conflict sanitizer enforced their existing 8192-byte decoded-text limits. An oversized response could therefore be fully buffered before rejection.

The method now reads delivered chunks with a reader and retains at most 8195 raw payload bytes. The extra three bytes preserve acceptance of an initial UTF-8 BOM: default `TextDecoder` removes that BOM, just as the prior text reader did. A completed body is decoded once and still passes through the unchanged 8192-byte parser/sanitizer checks. Split BOM and multibyte characters are reconstructed before decoding. `Content-Length` does not determine admission.

The crossing chunk is not retained. Cancellation is awaited, and the reader lock is released in `finally`. A confirmed overflow has an explicit result; no retained prefix, fake empty body or fabricated oversized string is passed off as the complete response.

| Response condition | Result retained by the change |
| --- | --- |
| Non-OK, overflow, cancellation succeeds | Existing HTTP status/code, `received=true`, absent conflict detail |
| OK, overflow, cancellation succeeds | 503 / `PLM_BOM_WRITE_UNAVAILABLE`, `received=true`, no partial success |
| Actual stream-read or cancellation rejection | Existing generic 503 path, `received=false`, absent partial detail |
| Complete body within raw allowance | Original decoded 8192-byte checks and existing success/error parsing |
| Null body | Complete empty text; flag-off revoke with 204 still returns `null` |

The existing error factory accepts an optional complete body. An absent body directly produces absent detail; defined strings retain the original sanitizer. Its status/code table and `received=true` construction are unchanged.

These distinctions preserve downstream outcome handling: received 401/403 retains the conservative same-operation retry contract; an oversized 409 body cannot supply safe conflict detail from a valid-looking prefix and remains unknown in the existing relay. The production relay and persistence code were not changed.

## Surgical scope and static verification

Only three source files changed:

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`: the personal BOM method's body-reading region.
- `packages/core-backend/src/services/plm-personal-bom-write-wire.ts`: the existing HTTP error factory's optional body/detail guard.
- `packages/core-backend/tests/unit/plm-personal-bom-write-transport.test.ts`: append-only cases.

Root assembled the exact Grok fragments without further source changes. Replacing each new fragment with its original reproduces the entire original file byte for byte. Consequently, all other adapter bytes, including the previously delivered personal approval reader and Visual helper, and all other wire bytes, including both original 8192-byte guards, are unchanged. The complete original 11747-byte test file remains an exact prefix.

The original purpose/authority/CID checks, personal bearer, prepared paths and request bodies, idempotency/If-Match headers, redirect rejection, 8000ms signal and outer typed catch remain unchanged. No new retry, shared-account fallback, binding, schema, business rule, H3 operation or manager was added.

Independent static review found one preliminary test import error: the pure relay is exported by `plm-personal-bom-write-http`, not the wire module. The same Grok session corrected that single appended import. The preliminary blocker report is retained; final delta review has no known static blocker. This is a source-level conclusion, not a successful test or compile result. `git diff --check` passed.

## Authored checks awaiting execution

The existing transport test now contains finite real `Response` / `ReadableStream` cases for:

- Exact decoded 8192-byte JSON, raw 8195 with BOM, split BOM and multibyte characters.
- Raw overflow with missing/small length headers, early cancellation before an unread tail, non-OK status preservation, received 401/403 relay flags, unknown 409 prefix and OK overflow.
- Complete decoded oversize and malformed UTF-8 replacement expansion through the unchanged semantic guards; small actual body despite a huge declared length.
- Null 204 revoke with the feature flag off, null 200 verify and null 401.
- A valid-looking prefix followed by a read failure; asynchronous cancellation rejection; absent secrets/detail, released locks and one fetch.
- A synthetic signal checking the unchanged 8000ms request option, restored in `finally` without a real wait.

Pull-order cases use high-water mark zero. Every producer terminates under an incorrect continuing/full-text reader as well: finite parts end in EOF, the read-error producer fails on its second pull, and the cancel-rejection producer emits once then closes on a later pull. Each request has its own response. Neither the old implementation nor these new checks was executed, so no actual RED/green claim is made.

## Provenance and limits

Evidence directory: `artifacts/plm-listener-review-20261015/unattended-12h-20261101/grok-tool-restore-20261101/personal-bom-response-limit-20261102/` in the review ledger tree.

- Final eight-member capsule: 19054 bytes, SHA256 `a183cedf0f0fec554d32879add3bf0295a6e1bcf40328e3aead92f305f187666`. Every member's SHA/bytes and four readonly inputs were verified.
- Final independent review: `Sol-final-v1-independent-static-review.json`, SHA256 `40baa4f7e5998ebda96af80cf1cc5e09ec30d95ae3b325a858dd4233014ba974`.
- Integration proof: `Root-exact-fragment-integration.json`.
- Grok handle: `gbt-5e78-1a198c17cfd-7`, requested Grok4.7/high. The CLI displayed Grok4.7/xhigh; backend deployment identity is UNKNOWN. The author's own actual-model UNKNOWN field is preserved separately. Independent review requested Sol6.1/high; returned actual model/effort UNKNOWN.

The finite author stopped. After idle/done and a final eight-file hash check, only that owned Grok session was closed. The coding bridge remains ready with zero model sessions; this says nothing about global host idleness or the retained N2 product lease. Available terminal snapshots do not prove complete command-history or global absence of side effects.

The bound covers retained application chunk payload. It does not bound compressed wire bytes, native buffers, array overhead, backing allocations, the already-delivered crossing chunk or absolute RSS. Early cancellation does not observe a hypothetical later unread-tail error. Release-lock failure, if it occurred, would still reach the unchanged generic catch.

Head-only precommit observation: main `b28538e328f754abba38553766537af2c4651894`; published catalogue child remains `8d237dac8ef6f168353d7cf8806a878e026bd0e5`. This local stack is not main-rebased. Original Native425 / Meta6425 / Meta6684 source and document heads are unchanged. Their old compiled/runtime/CI receipts do not qualify any of the eight new local source increments.

The N2 lease, Source23, W2, Claude/H3, P16 and browser HOLDs remain intact. Actual Source/grant pairing and writes, signed license setup, installation/mirrors, restore, browser/IdP and business acceptance remain OPEN. This single document is the closeout commit; subsequent results belong in the ledger/body rather than additional result-only commits.
