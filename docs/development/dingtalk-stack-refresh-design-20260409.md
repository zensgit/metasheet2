# DingTalk Stack Refresh Design

Date: 2026-04-09
Stack: `#725 -> #723 -> #724`

## Objective

Refresh the stacked DingTalk branches so review can proceed without waiting for a second round of stack-conflict cleanup after `#725` approval.

This pass keeps the stack shape unchanged:

- `#725` remains the first PR and stays `Ready for review`
- `#723` stays draft, but is rebased onto the latest PR1 head
- `#724` stays draft, but is rebased onto the latest PR2 head

## Chosen Strategy

### 1. Stop PR1 at the review gate

`#725` already has:

- latest security and correctness fixes
- full GitHub checks green
- `mergeStateStatus=BLOCKED`

At this point the remaining gate is reviewer approval, not more code churn.

### 2. Refresh PR2 against the latest PR1 head

`#723` previously depended on an older PR1 head and showed `DIRTY` against its current base branch. The safest acceleration step is to rebase PR2 onto the latest `codex/dingtalk-pr1-foundation-login-20260408`.

Expected effect:

- drop the stale PR1 commit that Git can now recognize as already applied
- keep only the directory-sync slice on top of the refreshed PR1 chain
- reduce retarget churn once `#725` merges

### 3. Refresh PR3 against the latest PR2 head

`#724` stays stacked on PR2 for now, but rebasing it onto the refreshed PR2 head keeps the rest of the stack coherent.

Expected effect:

- preserve the current draft/review order
- avoid a second cleanup pass inside PR3 after PR2 changes land
- keep downstream attendance/admin-control review isolated from stack-drift noise

## Validation Scope

Only narrow, stack-safe validation is required in this pass.

### PR2 validation

- backend directory/admin route tests
- auth route regression because PR2 still carries auth whitelist changes
- frontend directory and DingTalk callback tests
- backend build
- web type-check

### PR3 validation

- DingTalk robot notification tests
- delegated-admin and RBAC tests
- DingTalk login gate tests carried in PR3
- role delegation frontend test
- backend build
- web type-check
- attendance integration regression

## Non-Goals

This pass does not:

- retarget `#723` or `#724` to `main`
- merge any PR
- add new DingTalk features
- change the current production rollout target

