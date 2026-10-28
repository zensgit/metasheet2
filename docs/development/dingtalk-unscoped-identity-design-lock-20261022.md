# DingTalk unscoped identity resolution — R71 candidate

Base: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d` (includes #6484).

## Reproduced risk

`findIdentityUser` used `ORDER BY identity.updated_at DESC LIMIT 1` across enterprise namespaces when `DINGTALK_CORP_ID` was absent. The schema intentionally permits provider identifiers in different enterprise namespaces. A synthetic OAuth profile matched two local users; the newer account was selected, including an administrator account. Grants were then checked on that selected account, not used to establish the intended enterprise. This is an account-selection / privilege-boundary defect, not proof that arbitrary external users can forge provider identifiers. Rejected callbacks could also enrich the wrong candidate. Unscoped self-bind ignored scoped ownership and could introduce a duplicate association.

## Contract

- Count the complete existing lookup predicate, including external key, OpenID and UnionID alternatives. More than one candidate yields values-free `409 identity_ambiguous` before email fallback, provisioning or enrichment. Inactive/disabled candidates are not discarded to make an ambiguous identity appear unique.
- Preserve a unique optional-corp candidate, including legacy key-only namespaces, and explicit-corp lookup. Missing enterprise configuration is not inferred from email, role, grant or latest update time.
- For unscoped implicit writes, rejected-login enrichment and self-bind, use READ COMMITTED from the first transaction statement, then canonical users mutex, then `SHARE ROW EXCLUSIVE` on `user_external_identities`, before checking candidates/current ownership. Hold through commit. This follows directory sync's existing users-before-identity-table order and excludes identity DML even from writers without an advisory-lock convention.
- This table lock deliberately serializes unscoped callbacks with identity writes. Explicit-corp callbacks retain existing row/index concurrency. Configure the intended enterprise to avoid unnecessary broad contention.
- A scoped writer may legitimately create another enterprise association after the protected transaction commits; subsequent unscoped login must reject ambiguity. This change does not prohibit valid cross-corp identity rows, choose a default tenant, or alter membership / role policy.
- Auto-provision requires a configured enterprise in addition to the existing allowlist. An allowlist with no enterprise to compare previously admitted a new ordinary account; real DB reproduced this. Reject `409 auto_provision_corp_required` before creating any user/grant/identity. Existing unique optional-corp associations remain compatible.
- Administrator activation remains separate: explicit corp, unique active directory source, authenticated platform administrator and state-bound target, with transactional target/source revalidation. No loosening of activation rules.

## Gates

Real PostgreSQL ordinary/admin/disabled/inactive cross-corp rejection; OpenID-only / UnionID-only / external-key-only / legacy NULL-corp matches; configured-corp and unique legacy positive controls; full identity-row no-write readback; before-recheck and after-recheck interleavings; rejected enrichment; self-bind; container login; email association; repeatable-read connection default. New tests extend an existing required real-DB file (no skip-when-unreachable). Focused unit / route neighbors, quality checks, mutation checks and exact-head required CI evidence belong in the PR.

Synthetic provider transport only; no real UAT, deployment or flag changes. Stream/lifecycle OFF. No schema migration. Submit Draft PR for R71; do not merge. A PR is not a packaged or deployed R71 artifact.
