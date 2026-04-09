# DingTalk PR1 CorpId Rollout Gate

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Purpose

`DINGTALK_CORP_ID` makes DingTalk identity lookup strict by requiring corp-scoped external keys and corp-matched fallback rows.

That is the correct runtime behavior, but it introduces a rollout requirement for legacy `user_external_identities` rows written before corp scoping was enforced.

## Required Precondition

Before enabling `DINGTALK_CORP_ID` in any shared environment:

1. run the one-time backfill dry-run and export candidate rows
2. review the exported candidates and create a manual allowlist
3. confirm there are no legacy rows with:
   - `provider = 'dingtalk'`
   - `corp_id IS NULL`
   - `provider_open_id IS NULL`
4. confirm there are no conflicts for the target corp-scoped key:
   - `external_key = <corpId>:<provider_open_id>`

## Script

Use:

```bash
scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId> --export-file /tmp/dingtalk-corpid-candidates.csv
```

Dry-run output reports:

- `candidate_rows`
- `missing_open_id_rows`
- `conflict_rows`
- `apply_rows`

Apply only after manual review and allowlist creation:

```bash
scripts/ops/backfill-dingtalk-corp-identities.sh \
  --corp-id <corpId> \
  --allowlist-file /tmp/dingtalk-corpid-allowlist.txt \
  --apply
```

The allowlist file contains one `user_external_identities.id` per line. Empty lines and `#` comments are ignored.

The script refuses to apply if:

- any legacy row is missing `provider_open_id`
- any target corp-scoped `external_key` would collide
- the allowlist contains unknown ids
- the allowlist contains ids that are not eligible legacy DingTalk candidates

## Expected Data Rewrite

For each allowlisted eligible legacy DingTalk binding:

- `corp_id = <target corp id>`
- `external_key = <corpId>:<provider_open_id>`
- `updated_at = now()`

## Verification

After `--apply`, rerun dry-run and expect the reviewed subset to be cleared:

- no remaining reviewed ids in the exported candidate set
- `missing_open_id_rows=0`
- `conflict_rows=0`

Only after that should `DINGTALK_CORP_ID` be enabled in runtime configuration.
