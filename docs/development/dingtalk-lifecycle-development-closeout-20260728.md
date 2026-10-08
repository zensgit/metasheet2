# DingTalk lifecycle development closeout (2026-07-28)

Status: **development delivered / landing and runtime acceptance pending**

This record closes the implementation work authorized by the admission/activation
and deprovision/reactivation design locks. It does not declare the stack merged,
deployed, enabled, or production-accepted.

## 1. Authority and baseline

- Design locks:
  - `dingtalk-directory-admission-activation-lifecycle-design-20260723.md`
  - `dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md`
- Main observed while preparing this record: `ed7a739537d33f7a9a128d58d14468b79164454e`.
- The delivery remains a draft, unarmed stack. All lifecycle flags remain OFF.
- Historical PR #4579 remains HELD and is not part of this landing chain.

## 2. Reviewable delivery stack

| Order | Slice | PR | Exact review head | Current base |
|---:|---|---:|---|---|
| 1 | D3 evidence-ledger schema | #4646 | `4c75a93d0` | `main` |
| 2 | D4 atomic writer and evidence | #4647 | `cb0454065` | D3 |
| 3 | D5a admin access-writer mutex | #4648 | `33fa24ea6` | D4 |
| 4 | D5b account-binding mutex | #4651 | `75ba0f6b8` | D5a |
| 5 | D5c sync/OAuth access mutex | #4653 | `a40ccd63b` | D5b |
| 6 | D6 restore transaction | #4655 | `b20f33e75` | D5c |
| 7 | D7 evidence API and UI | #4656 | `a0bcdcafe` | D6 |
| 8 | Preview/apply policy parity | #4659 | `8328e2890` | D7 |
| 9 | Activated-user alias writers | #4658 | `8b356ec8e` | D7 |
| 10 | T3 source-link hardening and batch activation | #4660 | `14a0c4580` | alias writers |
| 11 | OAuth `intent=activate` | #4662 | code commit `c4f5f8dce` | T3 |

PRs #4658 and #4659 are sibling stacks over D7. Before landing, choose a
single order, retarget the second sibling onto the first merge, and rerun its
ticket-specific evidence. No merge SHA exists yet for any row above.

## 3. Final OAuth activation contract

- `activate` has a distinct, one-time OAuth state shape. Unknown or incomplete
  persisted intent values fail closed.
- Launch binds the pending target and the authenticated platform administrator.
- Callback rechecks that the administrator is still active, activated, and holds
  the RBAC admin role.
- The DingTalk code exchange does not enter login auto-provision/JIT.
- The source account must be exactly one active DingTalk account under an active
  DingTalk integration, with matching configured corp and callback openId/unionId.
- The activation transaction rechecks the active link to the same pending user
  and derives membership org from the locked integration row.
- The session is issued only after activation returns and the activated user row
  is reloaded.

## 4. Verification completed

OAuth final-head local evidence:

- backend TypeScript: clean;
- OAuth/auth/admin regression battery: 129/129;
- real PostgreSQL lifecycle battery: 17/17;
- parent alias-writer regression battery after fixture correction: 122/122;
- T3 replay after restack: 114/114 unit/error tests and 16/16 real-DB tests.

Load-bearing mutations were run separately and restored:

1. accept an unknown persisted OAuth intent;
2. ignore callback identity during the transactional source check;
3. remove callback administrator recheck;
4. issue a session without awaiting activation;
5. accept a disabled state-bound administrator;
6. use caller-supplied org instead of the source integration org.

Each mutation reddened its dedicated assertion. The final worktrees contain no
mutation residue.

## 5. Remaining owner and operations gates

1. Review each exact head in order. A review applies only to that SHA.
2. Retarget/rebase one PR at a time, replay that ticket's mutations, run full
   required CI, and merge only after a fresh owner verdict.
3. Record the real merge SHA for every row above.
4. Keep `AUTH_LOGIN_USE_ALIASES`,
   `DIRECTORY_PENDING_ACTIVATION_ENABLED`, and
   `DIRECTORY_DEPROVISION_ENABLED` OFF through landing.
5. Run real enterprise UAT and evidence review after deployment.
6. Canary requires a separate explicit GO and remains ordered:
   alias-only, pending admission, then deprovision. Do not enable multiple
   lifecycle flags in one window.

The honest closeout statement is therefore: the locked development scope is
implemented and reviewable; repository landing, deployment, UAT, and canary are
still open gates.
