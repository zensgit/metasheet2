# DingTalk Public Form Unbound Contract Design - 2026-04-29

## Goal

Lock the backend contract for signed-in users who can open a public multitable
form link but have not bound a DingTalk identity.

This covers the remaining access-matrix cases where the user is known to
MetaSheet but still cannot satisfy DingTalk-protected form policy:

- DingTalk-protected form, no explicit allowlist, signed-in user is not bound.
- DingTalk-granted selected-user form, signed-in user is selected but not bound.
- DingTalk-protected submit request, signed-in user is not bound.

## Design

No runtime behavior change is required in this slice. The existing backend gate
already evaluates DingTalk public-form access in this order:

1. Public token must be valid and unexpired.
2. Anonymous DingTalk-protected access receives `DINGTALK_AUTH_REQUIRED`.
3. Signed-in users must have a DingTalk binding before grant or allowlist
   evaluation.
4. `dingtalk_granted` users must have an enabled DingTalk grant.
5. Selected-user or member-group allowlists are evaluated last.

The new tests make that ordering explicit. In particular, a selected but
unbound user must receive `DINGTALK_BIND_REQUIRED`, not `DINGTALK_GRANT_REQUIRED`
or `DINGTALK_FORM_NOT_ALLOWED`.

## Safety

Submit denial is asserted before `INSERT INTO meta_records`, so an unbound user
cannot create a record through a stale form context or direct API request.

No DingTalk webhook, signing secret, access token, JWT, or real public form
token is stored in this design note or in the test fixtures.

## Files

- `packages/core-backend/tests/integration/public-form-flow.test.ts`
- `docs/development/dingtalk-public-form-unbound-contract-design-20260429.md`
- `docs/development/dingtalk-public-form-unbound-contract-verification-20260429.md`
