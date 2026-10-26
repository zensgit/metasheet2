# W6 aggregate real-authentication evidence supplement — 2026-10-26

Status: test-only derived proof slice, Draft/HOLD. Base fetched main 40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b. This is not a new capability, permission, owner ratification, rollout or production acceptance.

## Authority and exact gap

The existing W6 group-effective-policy design-lock (20260805), W6-R1/R2/R3/R6/R7/R8 and sections 4.1/7.2, requires a GET-only aggregate, authenticated org identity, attendance:admin, active membership for delegated admins, values-free replies and refusal before aggregate SQL. Parent advanced-capability R7/section3.5 and frontend section7.5 remain authoritative.

The existing real-DB W6 suite injects req.user and mocks rbacGuard. That is valid route/service evidence, but does not establish the real JWT/session hydration and DB-RBAC assembly. Other endpoints' actual-auth proofs cannot substitute. This slice adds exactly that missing layer for five named reachability arms. It creates no all-roles x every-policy Cartesian denominator, employee aggregate projection or per-group punch enforcement.

Fresh main advanced from 4c4cd3ab to 40ce1b47 only through nine stock-preparation paths. AuthService, attendance-admin route, canonical fixture, attendance plugin, dependency lock and workflow bytes were independently compared and unchanged; unrelated stock changes are retained.

## Frozen request matrix

Exactly five aggregate GET requests after synthetic fixture setup:

| Case | Actual actor/context | Expected result |
|---|---|---|
| A1 | Non-platform delegated attendance admin, active member of A; saved underconfigured scheduled group A | 200, exact existing aggregate shape and needs_configuration; genuine scoped aggregate SQL |
| A2 | Delegated admin with real B membership/session requests group A | 404 existing values-free shape; B-scoped lookup, no foreign payload |
| A3 | A1 supplies mismatching x-org-id B | 403 original selector refusal, no aggregate SQL |
| A4 | Active A group owner without DB attendance:admin | 403 real RBAC refusal, no aggregate SQL; ownership alone does not add v1 aggregate privilege |
| A5 | Reuse A1 token after active A membership is revoked in the fixture | Original real AuthService removes an unpermitted tenant, then unscoped403; no aggregate SQL |

The injected-principal delegated-nonmember404 test remains valid for its layer. It is not a reason to forge a real JWT principal to force that status. No new fallback, trust flag, RBAC bypass, permission or auth middleware modification is allowed.

## Assembly and gates

- Actual canonical MetaSheetServer, original core router and attendance plugin, actual JWT/session verification and DB-backed roles/permissions/namespace/membership. No req.user injection, service/RBAC mock, provider/customer data or external write.
- UUID-namespaced synthetic fixture only, owned UTF8 PG with explicit matching DATABASE_URL and ATTENDANCE_TEST_DATABASE_URL. Preserve original test/fixture budgets, server cleanup and configuration restoration.
- Auth-profile positive controls must prove genuine persisted activation/name/permission data rather than trusted-token or development-user fallback.
- B membership must precede real B session minting. Revocation is a fixture mutation between requests, never attributed to an aggregate write.
- Non-mutating driver observation records actual SQL. A1 must make aggregate SELECT observations nonempty; denial assertions distinguish authentication/RBAC SQL from aggregate SQL.
- Business fingerprints unchanged and aggregate business DML zero for every request. Classify any auth/session writes separately; do not claim zero SQL globally.
- Run only these five newly introduced cases. Stop and diagnose unexpected results before extending scope. Do not repeat all fixture shapes, frontend suites or previously green neighbors.
- A proof-removal mutation must turn its corresponding named case red, then exact restore. No production guard or assertion is weakened.
- Register the new DB suite in real-DB execution, no-DB exclusion and strict wiring corpus; preserve existing set-equality/once-only tests and budgets.
- Focused lint/syntax, affected registration guards, pnpm validate:all, independent review, exact source manifest and Draft PR. Published-head required CI is separate and must reach actual terminal success before final evidence.

## Limits

This does not close actual-entry browser labels, human assistive technology/native menus, parent owner acceptance, #6512 approval, frozen TRANSFER, W8/PQA/manual/combined-soak/24h/TXN caller acceptance, live/provider/2000-user/Redis/secrets or UAT. All PRs stay Draft/HOLD; no merge, deployment, R71/tag/release or business configuration change. Stream/lifecycle OFF. Real UAT and business50004 excluded; historical08PUT remains INCONCLUSIVE.
