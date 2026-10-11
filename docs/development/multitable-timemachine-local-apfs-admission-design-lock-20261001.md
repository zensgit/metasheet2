# Time Machine LOCAL APFS admission repair

Status: bounded repair of existing local filesystem admission; Draft/HOLD. Standalone repair based on current main `ef9eb2d86cf4cbef7327036368f92ca3eb0f53d3`, including its private-database drain increment. This repair has no dependency on PR #6195 or the abandoned-object cleanup protocol. No actual staging is authorized by this lock.

## Reproduced defect

Archive and LOCAL custody directory admission both identify Darwin APFS by numeric `fs.statfs().type === 25`. The current owned-root probe returns `26` on Node 24.14.1 and 20.20.2, while the OS reports local APFS. Provider tests refuse before provisioning. Apple's `getattrlist(2)` documents the numeric filesystem type as generally not useful; the named filesystem type is the relevant identity. Earlier type-25 APFS acceptance remains historical evidence and is not relabelled as current acceptance.

## Minimal repair

Share a narrow internal filesystem admission helper between the two existing providers. Preserve the existing Linux numeric supported set and unknown-platform refusal. On Darwin, query the exact already-resolved absolute root through the trusted OS executable `/bin/df`, using argument-array execution without a shell: local and `apfs` selection arguments, POSIX mode, explicit filesystem type and libxo JSON output. Use a clean locale environment, bounded output, timeout and forced termination. Apple's implementation applies `statfs` to the named path and reports `f_fstypename`. Its local/type selectors interact: a local APFS path with `-l -T nfs` can succeed and still report `apfs`. Neither exit status nor filtering arguments independently prove APFS; the parsed literal name is load-bearing.

Require successful execution, exactly one well-shaped filesystem record with literal type `apfs`, an absolute mounted-on path and no ambiguous/error output. Resolve/stat that mount and match its device to the original root; compare the original root's resolved path/device/inode before and after the probe. Re-probe through existing directory/root checks on subsequent IO. Do not assume that the root's path is prefixed by the mounted-on path: macOS Data firmlinks have different textual prefixes. No global cached verdict, numeric Darwin fallback, pathname interpolation or probe output in errors/evidence. Existing provider and custody error codes remain values-free.

## Verification

- Native name `apfs` accepts synthetic numeric types 25 and 26; `nfs`, `smbfs`, unknown, malformed/missing/multiple records, errors and timeouts refuse even with numeric 25. Linux supported/unsupported types retain their behavior and do not launch a child command.
- Exact hostile/space-containing path remains one argv; root/mount device or inode/realpath drift refuses. Two roots cannot share a cached admission. Refusal occurs before marker, ciphertext or custody publication; existing transaction-depth and namespace guards remain active.
- Reproduce current actual APFS failure without mocks, then run both provider suites plus cleanup/receipt neighbors on repaired source with cache disabled. Mutation-removing name/local/mount/root guards must make the corresponding negatives RED and restore exact bytes.
- Run fresh exact-SHA ordinary manual capture/restore and combined same-manual-generation backup, source-loss restore and flag-OFF rollback on owned APFS roots and disposable PostgreSQL. Preserve source/helper composition, command/log hashes, child exits and zero-residue census. CI proof belongs to the repaired head and actual merge checkout.

## Boundary

No schema, route, flag, provider/profile selection, storage defaults, retention, lease policy, customer data, remote provider/KMS IO, production or actual staging. This repairs recognition of the already-supported local APFS filesystem; it does not attest a physical root or independent fault domain, ratify mount-loss/NAS/power-loss behavior, or close full D7. Runtime defaults remain OFF. Ordinary push and Draft/HOLD publication follow standing authorization; Ready and merge remain owner gated.
