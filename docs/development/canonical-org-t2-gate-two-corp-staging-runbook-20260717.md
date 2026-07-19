# T2-Gate — Two-Corp Coexistence Proof · Staging Runbook (2026-07-17)

Milestone: Canonical Org & Provider Transfer v1, Transfer MVP row **T2-Gate**（§3.4 of
`provider-org-transfer-development-plan-20260709.md`; sequencing per
`canonical-org-provider-transfer-v1-mvp-implementation-plan-20260713.md` §2）。
Owner ruling (2026-07-16): **T2.5 is an explicit decision branch** — a CONFIRMED collision requires
the tenant-scoped key migration `(provider, tenant_key, external_key)` to land **before any T3
work**; a DISPROVED collision skips T2.5 and unlocks T3; **anything INCONCLUSIVE keeps T3 frozen**.

## 0. What is already proven vs what only staging can prove

**Proven in CI, permanently** (suite
`directory-account-external-key-collision-mechanism.db.test.ts`, real sync + real Postgres):

1. `directory_accounts` is UNIQUE on `(provider, external_key)`
   (`idx_directory_accounts_provider_external_key`) — same key across two integrations is
   **uninsertable**; distinct keys coexist.
2. The sync derives `external_key` as the **bare `unionId || openId || userId`** — no corp
   scoping (`directory-sync.ts`, account upsert loop).
3. The account upsert loop has **no per-account savepoint**, so a cross-corp collision does not
   skip one account — it aborts the apply transaction and the **second corp's sync run FAILS
   wholesale** (`status='failed'`, with server-side classification
   `duplicate_key_detected=true` AND `expected_constraint_detected=true` for
   `idx_directory_accounts_provider_external_key`), with **zero** rows written for that corp.

**Only staging can prove** (this runbook): whether real DingTalk actually hands the same person
the same `unionId` across two different corps for our app identity. That is a provider-behavior
fact, not a schema fact — the sandbox cannot create real corps. **Do not fabricate or simulate a
staging verdict** — leave §4 TBD until owner/ops execute against real two-corp staging.

## 1. Prerequisites (ops)

- Staging deploy at a recorded **exact SHA** (write it into §4's evidence block).
- **Two real DingTalk corps** (A and B) with app credentials each, and **one real person who is a
  member of BOTH corps** (the "overlap person").
- Platform-admin access to staging's directory admin API; read access to the staging Postgres.
- The staging DB migrated through the current main (no pending directory migrations).

## 2. Procedure (values-free evidence)

**Values-free** here means: no raw **provider identity** (unionId / openId / userId / corpId),
no **business values**, and no **raw SQL error text** (PostgreSQL duplicate-key messages can
embed the real `external_key` / `unionId`). SQL outputs stay **booleans / counts / statuses**
only.

**Provenance is allowed** (and required in §4): exact staging **SHA**, **execution date /
actor**, and **internal integration resource IDs** (platform `directory_integrations.id` for
corps A and B). Those are not provider secrets or business values.

1. Create integration A (corp A credentials), run a sync, confirm `status='completed'`.
2. Record the overlap person's key shape under A (values-free — length/equality booleans only;
   do **not** paste provider union/open/user IDs into the evidence pack):
   ```sql
   SELECT length(external_key) AS key_len,
          (union_id IS NOT NULL) AS has_union,
          (external_key = union_id) AS key_is_bare_union
     FROM directory_accounts
    WHERE integration_id = '<A>' AND external_user_id = '<overlap userId in A>';
   ```
3. Create integration B (corp B credentials), run a sync.
4. Read the outcome — **closed classifications only**. PostgreSQL duplicate-key text can embed
   the real `external_key` / `unionId`; **never** project, print, grep, copy, or persist
   `error_message` / err-head into the evidence pack. Derive booleans server-side and record
   only the booleans + status:
   ```sql
   SELECT status,
          (error_message IS NOT NULL
            AND position('duplicate key' in error_message) > 0) AS duplicate_key_detected,
          (error_message IS NOT NULL
            AND position('idx_directory_accounts_provider_external_key' in error_message) > 0)
            AS expected_constraint_detected
     FROM directory_sync_runs
    WHERE integration_id = '<B>'
    ORDER BY started_at DESC LIMIT 1;
   ```
   And the cross-corp key comparison:
   ```sql
   SELECT count(*) FILTER (WHERE integration_id = '<A>') AS corp_a_rows,
          count(*) FILTER (WHERE integration_id = '<B>') AS corp_b_rows,
          count(DISTINCT external_key) AS distinct_keys
     FROM directory_accounts
    WHERE integration_id IN ('<A>', '<B>');
   ```
   And the OVERLAP PERSON's presence on each side (the row-2/row-3 discriminator — values-free):
   ```sql
   SELECT (count(*) FILTER (WHERE integration_id = '<A>' AND external_user_id = '<overlap userId in A>')) AS present_in_a,
          (count(*) FILTER (WHERE integration_id = '<B>' AND external_user_id = '<overlap userId in B>')) AS present_in_b,
          (count(DISTINCT external_key) = count(*)) AS keys_all_distinct
     FROM directory_accounts
    WHERE (integration_id = '<A>' AND external_user_id = '<overlap userId in A>')
       OR (integration_id = '<B>' AND external_user_id = '<overlap userId in B>');
   ```

## 3. Decision matrix (owner ruling 2026-07-16)

| Observation | Verdict | Consequence |
|---|---|---|
| Corp-B run `status='failed'`, `duplicate_key_detected=true`, `expected_constraint_detected=true`; corp B row count 0 | **Collision CONFIRMED** | **T2.5 MUST land before T3**: tenant-scoped key migration `(provider, tenant_key, external_key)` + backfill + uniqueness proof on staging data |
| Both runs `completed`; presence query shows `present_in_a=1 AND present_in_b=1 AND keys_all_distinct=true` | **Collision DISPROVED** | T2.5 skipped; **T3 unlocked** (owner-accepted disproof only) |
| Both runs `completed` but `present_in_b=0` (overlap person missing under corp B), or any other shape (including failed without both closed classifications true) | **Inconclusive** | **T3 remains frozen** — capture the full values-free evidence and return to the owner |

Either way, attach provenance + closed SQL outputs: staging SHA, execution date/actor, internal
integration resource IDs, the SQL outputs (**booleans/counts/statuses only**), run timestamps.
**No** names, raw provider union/open/user IDs, DingTalk corp IDs, credentials, URLs, SQL error
strings, or business values in operator evidence.

## 4. Evidence block (fill at execution — leave TBD until real two-corp staging; do not simulate)

```
staging SHA:                    _TBD_
executed by / date:             _TBD_
corp A integration id:          _TBD_
corp B integration id:          _TBD_
corp A run status:              _TBD_ (completed|failed|…)
corp B run status:              _TBD_ (completed|failed|…)
corp B duplicate_key_detected:  _TBD_ (true|false)
corp B expected_constraint_detected: _TBD_ (true|false)
key comparison:                 _TBD_ (corp_a_rows / corp_b_rows / distinct_keys)
presence:                       _TBD_ (present_in_a / present_in_b / keys_all_distinct)
verdict:                        _TBD_ (CONFIRMED / DISPROVED / INCONCLUSIVE)
```

## 5. Cleanup / rollback

- The proof writes only `directory_integrations` / `directory_accounts` / `directory_departments`
  / `directory_sync_runs` rows under the two new integrations. Removing both integration rows
  cascades all of it away (archive-not-delete does not apply to a staging proof fixture).
- If corp B's failed sync left alerting noise, note the **closed classification** (failed +
  both booleans true) in the evidence block — that is the EXPECTED confirmed-collision
  signature, not an incident. Do **not** paste the raw `error_message`.
- **Do not** attempt the proof against production corps, and do not leave either staging
  integration `sync_enabled` on a schedule after the proof.
