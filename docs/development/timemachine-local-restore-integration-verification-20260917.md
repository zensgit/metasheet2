# Local Restore Integration Verification

Status: LOCAL CHECKPOINT; full database/process restore acceptance remains open.

## Binding

Integration parent: `ad1462dec2a9922e3f4b743876b808d8526164bf`.
This report accompanies the narrow application compatibility fix and two unit
test extensions. Historical source PR evidence is not new integration CI.

## Results

- Required-web selector census: main 390, archive parent 391, union 392;
  missing parent selectors 0/0.
- New application positive before fix: 1 failed / 33 passed, with
  `RECOVERY_ARCHIVE_APPLICATION_COMPOSITION_FACTORY_FAILED`.
- After fix, eight unit files: 174/174 passed.
- Core `type-check`: PASS.
- ESLint for `src/multitable/recovery-archive-application.ts`: PASS.
- `git diff --check`: PASS.
- Required-web shell syntax (`bash -n`): PASS; full Web suite not run here.

## Independent Review

Sol high reviewed the exact three-file uncommitted implementation/test delta
over the integration parent. Verdict: 0 P1 / 0 P2 / 0 P3. Review covered
capability authenticity/revocation and test false-green risks. It was static
only: no reviewer test/DB/network execution. Session
`01a0abb1-db97-72b3-8e1c-80f0fe0c35ba` completed and was closed.

Unit invocation from repository root:

```sh
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/multitable-recovery-archive-reader.test.ts \
  tests/unit/multitable-recovery-archive-file-store.test.ts \
  tests/unit/multitable-recovery-local-custody.test.ts \
  tests/unit/multitable-recovery-local-custody-store.test.ts \
  tests/unit/multitable-recovery-archive-crypto.test.ts \
  tests/unit/multitable-recovery-archive-application.test.ts \
  tests/unit/multitable-recovery-archive-preview.test.ts \
  tests/unit/multitable-recovery-archive-authenticated-manifest.test.ts \
  --reporter=dot
```

## Discriminating Evidence

The application test accepts the genuine opaque local capability and rejects a
spread copy before resolving database runtime. Existing KMS missing-method and
flag-off tests remain green. The real old composition guard produced the RED;
the compatibility fix produced GREEN.

The persistent-reader test writes actual encrypted objects through the POSIX
provider, writes encrypted custody packages through the custody store, rotates
keys, locks the writer, and constructs fresh store/session instances. Exact
recovered payloads include one existing record and one tombstone. Wrong-secret
unlock stays locked; deleted synthetic custody/object files fail closed. Test
cleanup removes only its unique temporary roots and scrubs the two secrets.

This test runs in one process. Its selected binding is a fixture, and nonce
reservation is a no-op fixture. It does not prove database publication, process
restart, actual row writes, or restore-job completion.

## Remaining Gates

- Full isolated PostgreSQL + persistent objects + custody restore drill.
- Broad merged-tree gates and remote exact-head CI before publication claims.
- No Ready, merge, flag, dispatch, deployment or customer-storage action.
