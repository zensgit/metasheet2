# GIP B1a-2 Canonical Registry Brand-Rethrow Fix — Development and Verification

**Status:** BUILT and independently verified, **HELD** as a child fix for Draft PR
`zensgit/metasheet2#4610`. This document does not authorize merging, runtime
wiring, deployment, or activation.

## 1. Scope and evidence boundary

The review started from exact parent head
`1e761bc2450ad66e850624bf479be259319bb592` and was revalidated after the
parent advanced to
`c79576296e` (`#4610` round 10).

The new parent commit changes only the connector-kind registry's rejection
wording and its boundary tests. It does not touch the canonical-object
registry fixed here. The child was rebased onto that exact parent, and its net
diff remains the same canonical implementation/test pair plus this DEV/V file.

The parent slice remains LATENT:

- the connector-kind and canonical-object registries ship empty;
- the trusted system-identity service and inventory attestation have no call
  sites;
- no route, scheduler, flag, or runtime consumer imports the three B1a-2
  modules.

The defect below is therefore not a production-path exploit in the shipped
tree. It is still a real, parent-PR-blocking breach of the closed error
contract on an exported `__internals` mechanism.

## 2. Confirmed defect

`gip-canonical-object-contract-registry.cjs` exported both:

- the `GipCanonicalObjectContractError` constructor; and
- `__internals.computeActivationReadiness(registry, references)`.

The latter caught `registry.lookup(...)` errors but rethrew every
`GipCanonicalObjectContractError` unchanged. A hostile registry could therefore
throw a forged instance carrying an arbitrary reason, message, details, cause,
and stack. Those caller-controlled values crossed the boundary unchanged even
though a raw `TypeError` from the same callback was converted to the fixed
`CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID` error.

The pre-fix probe reproduced three sentinel hits in the escaped
message/details/stack. The production activation gate was also probed and
correctly rejected the hostile registry at its private-identity trust check;
that negative control is why this document does not claim live production
reachability.

## 3. Repair

`computeActivationReadiness` now:

1. reads and validates each `contractId` and `version` with the module's own
   `requiredIdentityToken` before entering the foreign callback;
2. passes only those validated tokens to `registry.lookup`; and
3. discards every exception from `registry.lookup` unconditionally, replacing
   it with the fixed, values-free registry error.

Pre-validation preserves the existing malformed-reference contract:
`contractId: ""` still fails with
`CANONICAL_OBJECT_CONTRACT_DECLARATION_INVALID` and
`details.field === "contractId"`. The callback catch no longer needs a branded
exception exemption because no module-authored validation is left inside it.

The regression test supplies a hostile registry that throws a forged branded
error with distinct reason, message/details, and cause sentinels. It asserts
that none survive and keeps the malformed-token case as a positive control.

## 4. Independent review

- **Codex:** reproduced the pre-fix leak, inspected all eight parent-PR files,
  verified zero runtime consumers, and reviewed the final diff.
- **Grok 4.5:** independently reproduced the same branded-rethrow hole,
  implemented the two-file repair, and ran the focused suite.
- **Kimi K3:** read-only review independently confirmed the defect and the
  pre-validate-then-unconditionally-discard repair; it found no additional
  confirmed defect in the eight-file parent scope.

The reviewers agree on the boundary: real contract defect, LATENT-only
reachability at this head, no claim of production exploitation.

## 5. Verification

All commands ran in the isolated child worktree based on the exact parent head.

| Check | Result |
| --- | --- |
| Eight plain-Node `gip-*.test.cjs` contract files | PASS |
| `npm --prefix plugins/plugin-integration-core run test:gip-canonical-object-contract-registry` | PASS |
| `git diff --check` | PASS |
| Tree-wide import/symbol search excluding the three modules and paired tests | zero runtime consumers |
| Mutation: restore `instanceof GipCanonicalObjectContractError` rethrow | expected RED, exit 1 |
| Mutation discriminator | forged `UNREGISTERED` reason escaped instead of fixed `DECLARATION_INVALID` |
| Restore fixed implementation and rerun focused test | PASS |

The mutation changed only the catch branch, was not committed, and was restored
before the final test run.

## 6. Remaining gates

- Parent PR `#4610` remains Draft/HOLD.
- This child fix must be reviewed against its exact head and merged only into
  the parent branch before any parent ratification decision.
- No connector kind, canonical contract, trusted service, or inventory
  attestation is populated by this change.
- Runtime wiring, migration, deployment, and feature activation remain outside
  this authorization.
