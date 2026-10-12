# Time Machine object wire contract correction

Owner authorized continued local development, testing and review on 2026-10-12.
Staging and native recovery exercises remain conditional on explicit review approval.
This correction extends the existing test resource adapter contract, not production
resource selection or feature enablement.

Base: `8f2d9eba6116d5ff323e1ea18afa63273c105d8a`, dependency Draft #6334.
The adapters are absent from main at `b7096129df281708cd48e6add64696a601e9fdf6`.
Keep the frozen candidate and unrelated worktrees unchanged.

## Required behavior

- Preserve the base provider's supported zero-byte object semantics through remote
  PUT and GET. Empty object bytes must still match the exact size and SHA binding.
  Empty custody/key material remains invalid; malformed nonempty Base64 remains invalid.
- Every object RPC carries the configured expected store identity in a closed request
  envelope. The server rejects a missing, malformed or mismatched envelope before any
  provider call. A rejected response after mutation is insufficient.
- Preserve all seven operations, the inner discard/status identity checks, transaction
  refusal, exact result bindings, TLS validation and existing size/deadline limits.
- Require the new envelope on both sides. No fallback to the old unbound request
  format. Client and server must be deployed together after separate authorization.
- Keep default startup/flags, schema, permissions and the shared custody decoder unchanged.

## Local evidence gates

| Gate | Required evidence |
| --- | --- |
| Baseline | Reproduce empty-object refusal and wrong-store provider mutation with mocked transport |
| Correction | Empty PUT/GET exact result; wrong/missing namespace causes zero provider calls |
| Negatives | Malformed Base64, wrong byte binding and empty key material still refuse |
| Existing coverage | Preserve the meaning of existing malformed-request tests under the new envelope |
| Regression sensitivity | Removing namespace or empty-object corrections makes the respective tests fail |
| Required lane | Mocked suite collected by default backend tests and named focused resource step |
| Review | Independent source/test review and root verification of exact candidate |

Mocked HTTP/server execution does not prove TLS deployment, durable POSIX behavior,
real custody service behavior, same-archive native recovery, or staging rollback.
Those gates remain separate. No live resource writes or native exercises are part
of this local correction.

## Verification

- Baseline against unchanged adapters: 26 mocked cases passed and 10 failed,
  including zero-byte handling and provider calls before wrong-store refusal.
- Corrected mocked suite: 36 passed. Removing namespace validation, closed-envelope
  validation, empty PUT handling, or empty GET handling made the respective cases
  fail; both source files were restored byte-identically after each mutation.
- Root ran all six resource unit files with Node 20.20.2: 76 passed. Existing
  localhost TLS and temporary-file fixtures passed, including object service
  restart and default-OFF application refusal. No native 5001-row recovery, APFS
  volume provisioning, real database or staging execution occurred.
- Repository `pnpm validate:all` and both resource TypeScript configurations passed.
  Focused workflow syntax and changed-step ShellCheck passed; full workflow
  ShellCheck still reports unrelated pre-existing findings.
- The same six-file run using the local Node 24.14.1 runtime passed 74 tests and
  failed two launcher tests on named imports from TypeScript modules. This is an
  unresolved runtime-compatibility issue outside the object codec/wire changes;
  the local acceptance claim here is explicitly for Node 20.20.2.

The client/server request format changes together. Existing clients sending bare
requests are rejected; no legacy compatibility fallback is provided. These
candidate adapters remain unmerged and must not be deployed independently.
