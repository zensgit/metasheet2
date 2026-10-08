# Approval Lock-2B Contact Multi-Select Verification Report

Date: 2026-09-03
Status: IMPLEMENTATION AND STAGING CENSUS COMPLETE; OWNER READY/MERGE GATE
Implementation under test: `0bc10532f4af2b0668094223bb0ae0097d434df4`
Parent: `c7ef42a221ec8f3a04a8702fe89a6fa145b6e211`

## 1. Verdict

Refute-first review found and fixed one P2 before checkpoint: a `selection:'multi'` field accepted a scalar by implicitly wrapping it as a one-element list. Multi now requires an array and a dedicated mutation proves the boundary is load-bearing.

Final implementation verdict: **0 P1 / 0 P2**. The ratified staging props census is complete and found no compatibility blocker. Ready/merge remains a separate owner gate; staging UAT, flags, deployment, production, and any production-data census are outside this report.

## 2. Test Evidence

| Gate | Result |
|---|---|
| Focused frontend Vitest, 7 files | 328/328 PASS |
| Backend resolver/executor/product-service neighbors, 3 files | 295/295 PASS |
| Restored executor exact file | 69/69 PASS |
| PostgreSQL 15.17 isolated integration | 15/15 PASS, 0 skipped |
| Lock-7 field-edit real-DB neighbor after required-pin fixture migration | 19/19 PASS, 0 skipped |
| Legacy contact-dependent integration fixtures on a fresh PostgreSQL database | 21/21 PASS, 0 skipped; database dropped |
| Curated Required Web | 411 files, 5300/5300 PASS |
| Core backend TypeScript | PASS |
| Web TypeScript and approval verification TypeScript | PASS |
| Changed production source ESLint | 0 errors; 3 pre-existing unused-symbol warnings in `ApprovalProductService.ts` |
| `git diff --check` | PASS |
| Published exact-head CI for `0bc10532f4af...` | 49 SUCCESS, 1 intentional SKIP, 0 pending/failure; 13/13 required contexts SUCCESS |

The PostgreSQL run exercised save/publish/create/freeze/dispatch against a freshly migrated isolated database. It covered direct multi UNION, contact-manager UNION, cap overflow, server-side `allowSelf`, inactive contacts, empty-anchor precedence, manager/head pointer distinction, temporal freeze, policy failure, and handler-node dispatch.

The first exact-head CI run exposed a stale Lock-7 fixture whose `form_field_user` driver was optional. That is no longer a legal authoring shape under ratified OD-L2-4. The fixture was migrated to `required:true` and its generic create helper now supplies a seeded active contact; its own 19 Lock-7 assertions then passed unchanged.

Plugin-loader messages for optional local plugins missing frontend/telemetry packages were non-fatal baseline diagnostics; the named integration suite completed 15/15 and its database sentinel ran.

## 3. Discriminating Mutations

Each mutation was applied alone, the named gate was run, and the production source was restored without committing the mutation.

| Mutation | Expected red |
|---|---|
| Truncate `resolveFormUserValues` to the first array entry | Direct multi UNION test fails |
| Disable the server `allowSelf` refusal | Real-DB self-selection negative changes from 422 to 201 |
| Remove the inspector merge of off-page selected defaults | Off-page designated-default test fails |
| Disable the multi-array shape guard | Executor contact-shape suite: exactly 1 failed / 68 passed |

Restored results were green after every mutation. The four checks distinguish resolver completeness, server authority, authoring identity safety, and transport shape; they are not source-text assertions.

## 4. Census Evidence

The isolated database returned:

```json
{"user_fields":0,"user_fields_with_props":0,"distinct_prop_keys":[]}
```

That result proves the query and zero-result handling only. It is not evidence about staging or production. On 2026-09-03, the owner separately authorized the same aggregate-only query against staging. It ran inside an explicit read-only transaction with a statement timeout and `ROLLBACK`; it selected no form values, user ids, tenant ids, or template payloads. Staging returned:

```json
{"user_fields":1,"user_fields_with_props":0,"distinct_prop_keys":[]}
```

The empty key set is compatible with the five-key allowlist. No rewrite or exception is required. Production was not queried. The executed query was:

```sql
WITH user_fields AS (
  SELECT v.id AS version_id, f.field
  FROM approval_template_versions v
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(v.form_schema->'fields', '[]'::jsonb)
  ) AS f(field)
  WHERE f.field->>'type' = 'user'
)
SELECT
  COUNT(*) AS user_fields,
  COUNT(*) FILTER (WHERE field ? 'props') AS user_fields_with_props,
  COALESCE(
    jsonb_agg(DISTINCT key) FILTER (WHERE key IS NOT NULL),
    '[]'::jsonb
  ) AS distinct_prop_keys
FROM user_fields
LEFT JOIN LATERAL jsonb_object_keys(
  CASE
    WHEN jsonb_typeof(field->'props') = 'object' THEN field->'props'
    ELSE '{}'::jsonb
  END
) AS keys(key) ON TRUE;
```

Any non-empty key outside `allowSelf`, `selection`, `defaultMode`, `defaultUserIds`, and `maxSelections` is an escalation, not an automatic rewrite.

## 5. Residue and Boundaries

- Isolated database `metasheet_lock2b_20260902_1907` was dropped after the final run; a catalog check returned zero matching databases.
- No migration was added or applied outside the disposable database.
- No feature flag was enabled or added.
- No workflow, shared required-test manifest, branch protection, dispatch, deployment, production system, or production/customer data was touched. The only staging action was the owner-authorized aggregate-only read described in Section 4.
- External Grok/Kimi review was not used as a completion gate; the exact-head Codex review and behavior/mutation evidence are authoritative for this checkpoint.

## 6. Remaining Gates

1. Re-run exact-head CI after this evidence-only report update.
2. Obtain separate owner authorization for Ready/merge. Staging UAT, flags, deployment, production, and any production-data census remain later independent gates.
