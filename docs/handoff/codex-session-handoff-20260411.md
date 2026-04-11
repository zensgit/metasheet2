# Codex Session Handoff

- Date: `2026-04-11`
- Repository: `metasheet2`
- Created from: `origin/main`
- Baseline commit: `063d1543b`

## Purpose

This file is the Git-synced replacement for the transient Codex chat thread.
It does not try to preserve the raw conversation. It preserves the decisions,
delivery status, and restart context needed to continue on another machine.

## Current Delivery Status

The multitable `pilot / on-prem` delivery line is complete at code level.

Final status already reached before this handoff:

- `pilot ready`: passed
- `on-prem release gate`: passed
- `release-bound handoff chain`: passed
- follow-up operator-chain fixes were merged

The correct posture now is:

- do not continue feature work on that delivery line
- use handoff / UAT / staging feedback to drive any future follow-up

## Canonical Delivery Artifacts

Local stable artifacts were rebuilt into:

- `output/delivery/multitable-pilot-final-20260407/`

Important note:

- `output/` is local/generated state and is not assumed to be Git-synced
- on a new machine, regenerate artifacts instead of expecting them from Git

Key local artifact files on the source machine:

- `output/delivery/multitable-pilot-final-20260407/README.md`
- `output/delivery/multitable-pilot-final-20260407/HANDOFF-SUMMARY.md`
- `output/delivery/multitable-pilot-final-20260407/pilot-ready/readiness.md`
- `output/delivery/multitable-pilot-final-20260407/onprem-gate/report.md`
- `output/delivery/multitable-pilot-final-20260407/handoff/handoff.md`
- `output/delivery/multitable-pilot-final-20260407/release-bound/report.md`

## If You Need To Rebuild Delivery Artifacts

Use a clean worktree from `origin/main`, then run:

```bash
PILOT_DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
pnpm verify:multitable-pilot:ready:local

PILOT_DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
pnpm verify:multitable-onprem:release-gate
```

Then bind the resulting readiness root and on-prem gate report into:

```bash
READINESS_ROOT='<fresh readiness root>' \
ONPREM_GATE_REPORT_JSON='<fresh on-prem gate report json>' \
ENSURE_PLAYWRIGHT=false \
PILOT_DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
DATABASE_URL='postgresql://metasheet:metasheet@127.0.0.1:5432/metasheet_gate_20260407' \
pnpm prepare:multitable-pilot:release-bound
```

## Staging / UAT Status

Real staging smoke was not executed in the last session because these env vars
were missing:

- `STAGING_BASE_URL`
- `API_TOKEN`

Recommended next action if continuing validation:

1. provide staging credentials
2. run the smallest staging smoke
3. only open a follow-up PR if staging or UAT shows a real defect

## Backend Architecture Findings

These findings materially affect future multitable work:

1. There is no dedicated backend `MultitableService`
2. Multitable backend logic is primarily in:
   - `packages/core-backend/src/routes/univer-meta.ts`
3. `univer-meta.ts` is a route-heavy monolith with inline SQL
4. The multitable data model is based on:
   - `meta_bases`
   - `meta_sheets`
   - `meta_fields`
   - `meta_views`
   - `meta_records`
5. `meta_spreadsheets` does not exist

Pragmatic conclusion from the prior discussion:

- do not claim that backend multitable already has a clean service layer
- for future plugin provisioning work, prefer a minimal internal helper extract
  from `univer-meta.ts` over:
  - plugin-side raw SQL coupling
  - backend self-calling its own HTTP routes

## After-Sales Plugin Decision Snapshot

At the end of the prior discussion, the recommended direction for the
`plugin-after-sales` C-min path was:

- do not use plugin-side raw SQL as the primary design
- do not self-call backend HTTP from backend/plugin code
- do use a minimal internal backend helper extraction for multitable
  provisioning
- plugin installer can keep an injectable adapter interface
- tests should continue to use fake adapters where possible

For `installedAsset`, the recommendation was:

- keep C-min minimal
- do not add fake business fields just to make the table look complete
- prefer the smallest meaningful schema, not a broad v1 field surface

## Local Environment Notes

- A clean artifact rebuild worktree needed a real `pnpm install --frozen-lockfile`
  because symlinked/shared `node_modules` initially missed required frontend
  dependencies for Vite resolution
- `psql` was not available on PATH in that environment
- Docker Hub pulls were unreliable in an earlier attempt; local PostgreSQL on
  `127.0.0.1:5432` was used for the successful rebuild

## Practical Resume Guidance

If resuming on another machine, start like this:

1. fetch latest `origin/main`
2. read this file
3. decide whether you are:
   - doing validation/handoff only
   - or opening a brand new follow-up workstream
4. if validation only, do not reopen the delivered multitable line for feature work
5. if opening a new workstream, branch from latest `origin/main`

## Recommended Next Step

The default next step is not development.

The default next step is:

- handoff
- staging / UAT
- wait for real feedback

Only after feedback should a new PR be opened.
