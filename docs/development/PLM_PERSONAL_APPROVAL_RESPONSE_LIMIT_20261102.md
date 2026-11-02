# Bounded personal approval response reads

As of 2026-11-01T20:02:24.982148+00:00, this slice is a local static source delivery. Execution qualification remains open.

- Source: `77c7f38c989bcf3b63760bac556423d1bd7d0927`; parent: `56dd5f97eabd7d1e38920e66dc246b0c4a292e0a`.
- Branch: `codex/plm-approval-response-limit-20261102`.
- Two files changed: only the successful-body reader in `PLMAdapter.personalApprovalRequest`, plus appended cases in the existing transport unit file.
- No push, new PR, CI, test, build, import or product runtime was started. Main observed before commit: `b28538e328f754abba38553766537af2c4651894`; published 6684 remains `8d237dac8ef6f168353d7cf8806a878e026bd0e5`. This local stack has not been rebased to main.

## Problem and preservation contract

The existing method called `response.text()` before checking the decoded text's UTF-8 byte length against 2,000,000. A successful response could therefore be fully buffered before the size refusal. The new reader bounds retained incoming chunk payload before concatenation and parsing.

The existing acceptance rule is preserved: default UTF-8 decoding, including removal of one initial UTF-8 BOM, followed by the unchanged decoded 2,000,000-byte check and JSON parsing. This was not an existing promise of a raw 2,000,000-byte threshold. Decoding can reduce the raw byte count only by the one initial three-byte BOM; malformed UTF-8 replacement does not reduce it. Therefore a previously admissible decoded body has at most 2,000,003 exposed raw bytes. This small raw allowance preserves exact-limit JSON with a BOM; it does not admit decoded text above the original limit.

The implementation reads through the response reader, counts actual `Uint8Array.byteLength`, cancels on raw overflow before retaining that chunk, and releases the reader lock in `finally`. It decodes the bounded concatenation once with default `TextDecoder`, then keeps the original decoded-byte check and `JSON.parse`. `Content-Length` does not decide admission, preserving the old treatment of exposed bodies whose header describes a different representation or is inaccurate. Read or cancellation failure maps through the existing fixed 503 error family without provider details.

Direct reuse of the existing Visual reader was rejected during design review: its raw threshold and declared-length fast refusal would narrow the old personal-transport acceptance. No Visual helper or caller was changed. The personal purpose/CID/grant/scope gates, operation/path/method/body selection, personal-only headers, single fetch, `redirect:error`, `AbortSignal.timeout(8000)`, non-OK typed status mapping and outer catch remain byte-exact. No fallback, retry, login, source/config, license, permission, schema, migration or policy change was added.

## Code and static evidence

Grok task `gbt-5e78-1a1989a125f-6` implemented the bounded fragment and append-only tests. Requested: Grok4.7/high. Root observed the new-session CLI TUI Grok4.7/xhigh; backend deployment ID UNKNOWN. The original author's actual-model/effort UNKNOWN report is retained. Independent Sol high was requested; actual model/effort UNKNOWN.

The final v2 archive is 14,049 bytes, SHA256 `a088c03d3a7ec00cdd0e42fffdbfcb5fc0a0420643f95572dafb193e602c8ddd`. All seven members were verified by SHA256 and byte length; four read-only inputs remain exact. Root replaced only the supplied method in the complete adapter and proved the inverse replacement restores every original byte. All other adapter bytes, including Visual code, are unchanged. The complete original 4,374-byte test file remains a byte-exact prefix. Root made no source delta from the final Grok candidate.

Appended cases cover exact-limit JSON with/without a split BOM, split multibyte UTF-8, overflow with absent/small declared length, cancellation before an unread tail, unchanged rejection of decoded expansion and decoded limit+1, acceptance of an actual small body with a large declared length, stream read failure and lock release, unchanged 8,000ms timeout argument, and cancellation rejection with lock release and fixed 503. Controlled streams use zero high-water mark where pull order matters; these are synthetic body tests, not real network compression or timeout measurements.

Static review found one newly added cancellation-failure fixture could produce indefinitely if the method regressed to a full-text reader. The same Grok handle corrected it to emit one chunk and close on the second pull. Thus the correct cancellation path still sees an open stream, while the wrong full-read path has a finite EOF. The original v1 snapshot and blocking review remain immutable. No old/faulty implementation was executed and no observed RED/PASS test result is claimed.

| Check | Result |
| --- | --- |
| Independent final v2 delta/source/test review | No known static blocker; v1 fixture finding resolved |
| Full adapter inverse-byte proof and old complete test prefix | PASS |
| Input/final member SHA and byte comparisons | PASS within the stated scope |
| `git diff --check` | PASS |
| Tests, mutation execution, tsc, lint, build, imports | NOT_RUN |
| HTTP, PostgreSQL, browser, installation/runtime/business qualification | NOT_RUN |
| Push, new PR, new CI | NOT_RUN |

The bounded property concerns retained application chunk payload before concatenation. It does not bound compressed wire bytes, native fetch/decompression buffers, the incoming chunk's own allocation, array overhead or absolute process RSS. No complete terminal command/global side-effect audit is claimed. The erroring-stream path is not claimed to explicitly cancel every error; overflow explicitly cancels, and read/cancel failures release the acquired lock.

Grok model 8476 was closed after idle/done and all seven final file hashes/lengths matched. Bridge 24184 remains ready with zero model sessions; parent 7375 is retained, without a global idle or N2 lease-release claim. No hooks repair was needed for this task; existing hooks were true14/14.

Private artifact records remain in `unattended-12h-20261101/grok-tool-restore-20261101/approval-response-limit-20261102/`: `Root-final-v2-export-acceptance.json`, `Root-final-v2-reassembly-static-guards.json`, `Sol-final-v2-independent-static-review.json`, `Root-model-close-acceptance.json` and the retained v1 blocking review. The preservation contract review is `Sol-personal-approval-response-limit-preservation-review-20261102.json`, SHA256 `a12659a0506f181d73435deecdd96d35641c246584ce05f230de792c49c6d3e5`.

## Remaining scope

All seven product packages remain OPEN. This local source is absent from earlier compiled/c24/runtime qualifications and published source heads. Ordinary paired Source/grant/write/revocation, full N08, T2/T3/full T4 under the existing H3 contract, three-SKU signing/entitlement, install/upgrade/mirror/restore, browser/IdP and business acceptance remain separate. N2 retained lease, Source23/W2/Claude/P16/Work-browser and all HOLDs remain. No runtime permit or replay follows from this source delivery.

This slice has one source and one closeout-document commit. Later qualification results belong in state/PR-body records, without recurring source/document commits. Draft and separate merge/deploy gates remain.
