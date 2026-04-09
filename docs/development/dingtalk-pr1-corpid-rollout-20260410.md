# DingTalk PR1 CorpId Rollout Gate

Date: 2026-04-10
PR: `#725`
Branch: `codex/dingtalk-pr1-foundation-login-20260408`

## Purpose

`DINGTALK_CORP_ID` makes DingTalk identity lookup strict by requiring corp-scoped external keys and corp-matched fallback rows.

That is the correct runtime behavior, but it introduces a rollout requirement for legacy `user_external_identities` rows written before corp scoping was enforced.

## Required Precondition

Before enabling `DINGTALK_CORP_ID` in any shared environment:

1. run the one-time backfill script
2. confirm there are no legacy rows with:
   - `provider = 'dingtalk'`
   - `corp_id IS NULL`
   - `provider_open_id IS NULL`
3. confirm there are no conflicts for the target corp-scoped key:
   - `external_key = <corpId>:<provider_open_id>`

## Script

Use:

```bash
scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId>
```

Dry-run output reports:

- `candidate_rows`
- `missing_open_id_rows`
- `conflict_rows`
- `apply_rows`

The script refuses to proceed if:

- any legacy row is missing `provider_open_id`
- any target corp-scoped `external_key` would collide

Apply only after dry-run is clean:

```bash
scripts/ops/backfill-dingtalk-corp-identities.sh --corp-id <corpId> --apply
```

## Expected Data Rewrite

For each eligible legacy DingTalk binding:

- `corp_id = <target corp id>`
- `external_key = <corpId>:<provider_open_id>`
- `updated_at = now()`

## Verification

After `--apply`, rerun dry-run and expect:

- `candidate_rows=0`
- `missing_open_id_rows=0`
- `conflict_rows=0`

Only after that should `DINGTALK_CORP_ID` be enabled in runtime configuration.
