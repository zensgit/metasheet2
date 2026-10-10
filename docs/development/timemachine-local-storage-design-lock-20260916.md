# Time Machine local-first storage

Status: bounded implementation candidate, runtime OFF; NAS and local key custody NOT ratified by this file.

## Scope and authority

The owner requested local-first support for customers using a single server or NAS, then asked to continue. This slice implements the existing object-store interface on private local POSIX storage. It does not change recovery permissions, the archive format, retention durations, capture policy, key custody, or default startup. It does not purchase, mount, enable, or access customer storage.

The existing test provider remains test-only. This separate provider must rediscover state after process restart. Local storage protects against logical loss only while the storage and custody remain available; it is not independent-host disaster recovery. A provider implementation alone does not make archive recovery deployable.

## Local provider contract

- Require an existing private service-owned directory; provision a caller-selected canonical UUID sentinel explicitly, never as a side effect of ordinary reads/writes.
- Bind the root's real path, exact bigint device/inode and sentinel. Missing/replaced roots refuse, never mkdir/fallback. Root administrators and same-UID hostile mutation are outside the threat model. Hot-remount and NAS operation are not supported in this slice.
- Admit only explicitly recognized local filesystem types on Linux/macOS. Unknown/network filesystems refuse pending separate acceptance. No process-local map is metadata authority.
- Store one immutable envelope per generation/object identity, carrying the exact descriptor and ciphertext. Publish only a complete, fsynced temporary file using exclusive hard-link creation, then fsync the directory. Never overwrite a committed object.
- Retention is monotone: active -> pinned OR active -> deleted. Both transitions compete to exclusively publish the same immutable retention-marker name; each marker binds the exact immutable descriptor. A delete winner prevents all subsequent pins/recreation, and a pin winner prevents deletion.
- Persist and fsync the delete marker BEFORE removing ciphertext. Retry a committed delete after interruption; never remove the tombstone. A concurrent put must recheck the tombstone before reporting success. Crash-lost temporary files are not visible objects and are not automatically garbage-collected in this slice.
- External filesystem work must remain outside database transactions. Fixed errors carry no paths, hostnames, payloads, or provider causes.
- Validate ciphertext digest/size before admitting reads or an existing object. Refuse malformed metadata, symlinks, extra fields and unsafe roots. Require an explicit object-size limit, capped at 256 MiB for this implementation.
- Return a raw provider to the existing caller-side transaction/result wrapper. Share canonical request parsers rather than nest result wrappers; both raw-provider entry and caller entry reject transaction-bound I/O.

## Remaining work (not supplied by this provider)

1. Explicit local-custody security contract: encrypted/offline key backup, restoration and rotation; do not silently claim the existing KMS-attestation guarantee.
2. Standard-startup composition, capture/coverage construction and policy selection.
3. NAS adapter acceptance per protocol/filesystem, including mount loss during I/O, server restart, locking/publication semantics and durable flush behavior; no promise from a local test result.
4. Full-system recovery of object storage, catalog, and custody together. This is separate from the existing logical restore tests.

## Verification gates

Focused real-filesystem tests must prove persisted read/pin/delete after new provider creation, concurrent independent contenders with one retention winner, interrupted-delete retry, immutable put replay, mismatched bindings, corrupt bytes/metadata, missing/wrong root identity, no automatic root creation, symlink refusal, transaction no-I/O and values-free failures. Mutation removal of the tombstone, root identity or exclusive publication guard must turn a matching test red. Existing object-store and application tests remain neighbors. CI must collect the whole new unit file. No NAS/power-loss/production evidence may be inferred from these tests.
