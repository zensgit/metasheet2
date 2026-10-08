# Time Machine local APFS identity repair

Status: bounded repair candidate; activation and staging remain owner-gated.
Source baseline: `f817f010fce37e903440eb8a2a5ca69caf070c6f`.
Refreshed main: `57621d240314328463e35c5d1b265f846b7edc20`.

## Problem and scope

Both local archive and encrypted custody stores admit Darwin `statfs.type === 25`.
Darwin assigns filesystem type numbers through its runtime registry. On this host,
APFS is 26 and HFS is 25; real private APFS roots are rejected before publication.
Changing the number to 26 would retain the same incorrect identification method.

The owner selected isolated local APFS. This repair implements that existing local
storage boundary, with no HFS, NAS, key-retirement, format or startup expansion.
Existing local storage and LC-1 through LC-6 contracts remain authoritative.

## Minimal implementation

- Share one small filesystem admission helper between the two existing stores.
- Linux retains exactly its current numeric allowlist and custody mountinfo policy.
- Darwin invokes only `/bin/df`, with fixed arguments `-P -Y -T apfs` and the
  canonical directory operand, without a shell. Never add `-l`: Apple's local/type
  selection combines those predicates additively and would admit other local types.
- Use a clean `LC_ALL=C` child environment, a bounded timeout and output buffer.
  Require successful execution, empty stderr, exactly one known header and one
  well-formed data row with explicit literal Type `apfs`. The mountpoint is the
  row remainder and may contain spaces; it need not equal the child directory.
- Unsupported options, unknown types, malformed/extra/control output and execution
  failures refuse with fixed values-free errors; no numeric or alternate-command
  fallback. Existing leaf error classes remain unchanged.
- Retain owner/private-mode, no-symlink, realpath, exact bigint device/inode,
  sentinel, immutable publication, transaction and per-operation checks.

## Acceptance boundary

Native acceptance uses newly created private synthetic directories on the selected
local APFS volume with ownership checking enabled. Preserve native evidence of
filesystem name and ownership configuration for that volume. The type repair does
not newly prove automatic rejection of arbitrary APFS volumes configured noowners.
Hostile same-UID/root mutation, hot-remount, NAS and power loss remain outside scope.
An actual non-APFS writable test root is required for provider-level negative proof;
`/dev` alone proves only native filesystem classification, not private-root admission.
No existing custody packages or recovery secrets may be deleted or changed.

## Verification gates

1. Preserve a whole-file baseline failure on real APFS before production edits.
2. Test exact command/environment/bounds and positive APFS output, spaces in the
   mountpoint, non-APFS/missing Type, malformed/multiple/control output, stderr and
   execution failure. Unsupported platforms refuse. Linux behavior stays exact.
3. Run both complete existing file-store suites and neighboring custody/object-store
   tests. Genuine native tests must not mock platform, statfs or subprocess results.
4. Independently reopen actual providers and prove immutable object and encrypted
   package persistence, pin/delete arbitration and root/transaction refusal.
5. Remove the Type guard and a leaf helper call separately: matching negative tests
   must fail, then restore exact source bytes and rerun the relevant whole files.
6. Verify actual CI collection, backend type check, configured validation and diff.
   Publish a bounded Draft/HOLD PR with evidence and remaining gates; no merge.

This slice does not close whole-system same-archive restore, interrupted owned
continuation, lifecycle, scheduled Phase 5 attribution or staging acceptance.

Primary implementation reference: Apple's `file_cmds/df/df.c`, directory `statfs`
and type selection, `-Y` native Type column, and local/type predicate combination:
https://github.com/apple-oss-distributions/file_cmds/blob/main/df/df.c

Ownership boundary reference: Apple's File System Programming Guide, macOS file
system security and removable-volume ownership configuration:
https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemDetails/FileSystemDetails.html
