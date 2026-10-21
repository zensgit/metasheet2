# Automation rerun safety development

Status: bounded implementation; Draft/HOLD publication only. Not product FINAL.

## Baseline and scope

- Base: `6624cd74056a09d25958d2fda2768f5022bc313d`.
- Source: `apps/web/src/views/AutomationExecutionsView.vue`.
- Dedicated test: `apps/web/tests/automation-rerun-execution.spec.ts`.
- This is a fresh fix-forward over the already-merged rerun control, not a replay
  of an older branch or a new execution capability.
- Before editing, the OPEN-PR file census covered all 234 PRs, including the full
  file pagination of two large PRs; neither authorized path overlapped.
- The companion verification report binds code blobs and local evidence. The
  successor PR metadata records its final exact head and remote check state.

## Behavior

1. Preview every possible supported action kind in the stored snapshot, including
   condition branches, their default branch, and parallel branch children. This
   is an action-kind preview, not a prediction of which branch will be selected
   and not a replacement for server rule validation. Unknown action vocabulary
   or unreadable child-action structure discards the entire partial enumeration
   and retains the existing separate unknown-actions acknowledgement.
2. Bind loaded detail and confirmation to the live component, selected execution,
   detail generation, and shared auth context. Use existing `getAuthPrincipalKey`
   and `authHeaders`: the context includes explicit session-org epoch, effective
   tenant, and token. Compare only; never render, persist, or log the context.
   An unreadable explicit session transition fails closed.
3. Reserve the control before awaiting either confirmation. Recheck after the
   first dialog, before sending, and on success/error return. A cancelled or
   stale operation releases its loading state but does not send or publish stale
   results. Same-row detail responses from an earlier expansion are discarded.

## Preserved boundaries

- The original 22 tests remain; no test was removed or weakened.
- Ordinary list reload, per-step resume, backend eligibility, error-code mapping,
  and the existing unknown-actions acknowledgement retain their contracts.
- No shared auth, API, workflow, test selector, backend, migration, flag, or
  dependency changes. This does not harden the separate per-step resume flow.
- No database access, real automation execution, dispatch, staging, deployment,
  production action, branch-protection change, or Ready/merge authorization.
- The record-detail contracts, attachment census, and staging migration questions
  remain separate owner-gated work; this patch does not resolve them.
