# Approval batch-transfer navigation regression coverage

## Scope and status

- Base: `4cf17e9d379c19995f0a305a91cd811c1e33579d`.
- Test-only closeout of the previously disclosed navigation-consumer coverage gap.
- No runtime defect is claimed: the unchanged production implementation passes all new cases.
- One existing test file and these development/verification reports; no product, API, database,
  feature flag, workflow, selector, dependency, or permission changes.
- Draft/HOLD delivery. Ready, merge, activation, and deployment are separate owner gates.

## Existing behavior and added evidence

`App.vue` mounts `ApprovalBatchTransferNavEntry.vue` behind the existing shell gate. The entry
uses `useApprovalAdminCapability.ts`, whose invalidation callback synchronously retires pending
reads and whose microtask reads the session after `useAuth` updates storage. The resolver remains
the existing `adminCapability.ts`; server-side authorization is unchanged.

The existing navigation suite covered settled logout and identity refresh, but not a deferred
grant arriving after logout. The batch-transfer page already had coverage of the shared guard;
this change adds independent proof at the mounted navigation consumer, not a new capability.

The original 13 tests remain. Three tests now additionally prove:

1. A pending grant cannot restore the link after logout, even though no replacement request runs.
   The rest of the navigation remains mounted, so disappearance is not a shell-unmount artifact.
2. A same-subject token refresh re-reads capability and a superseded pending grant cannot replace
   the refreshed denial. This tests consumer response ordering, not the resolver's network cache.
3. When notification precedes token storage, the subsequent capability read observes the new
   subject. The existing mocked `useAuth` harness explicitly reproduces that order; it does not
   claim to test the implementation of `useAuth.setToken` itself.

Existing granted-user, denied/unavailable, translated-label, ordinary-user, route, teardown,
and shell-error-boundary positives/negatives remain unchanged.

## Model and review division

Codex implemented and ran the regression/mutation checks. A separate `gpt-5.6-terra` agent
audited the production call chain and test scope. Its initial audit correctly noted existing
page coverage; this report consequently distinguishes shared-helper coverage from independent
navigation-consumer coverage. No Grok/Kimi/Claude model verdict is claimed.

## Integration boundaries

The existing spec is already selected by `approval-web-guard.yml` and the required web script;
neither selector was edited. Main's automatic image-publication path is a separate operational
blocker and is not resolved by these tests. No further main merge is part of this delivery.
