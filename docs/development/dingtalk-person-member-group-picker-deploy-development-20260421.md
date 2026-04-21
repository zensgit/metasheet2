# DingTalk Person Member Group Field Picker Deploy Development

- Date: 2026-04-21
- Scope: production rollout verification for `#965 feat(dingtalk): add member group field picker`
- Base commit on `main`: `c4093dcb813f734a32c8ded5bc9d280feec6fcb3`

## Goal

Confirm that the DingTalk personal-message member-group field picker was not only merged to `main`, but also built, deployed, and smoke-checked in production.

## What Was Done

1. Confirmed `#965` merged into `main` at `c4093dcb813f734a32c8ded5bc9d280feec6fcb3`.
2. Checked GitHub Actions runs triggered by that merge.
3. Verified the real production path came from `Build and Push Docker Images` run `24699127741`.
4. Confirmed the deploy job inside that workflow finished successfully.
5. Reused the downloaded deploy artifact already present locally and inspected:
   - deployed image tag
   - `.env` tag persistence
   - deploy / migrate / smoke markers
6. Recorded the rollout evidence into repository docs.

## Deployment Evidence Used

- Merge PR:
  - `#965`
  - `https://github.com/zensgit/metasheet2/pull/965`
- Workflow run:
  - `Build and Push Docker Images`
  - run id `24699127741`
- Deploy job:
  - job id `72238527775`
- Supporting workflow status:
  - `Plugin System Tests` run `24699127731`
  - `Phase 5 Production Flags Guard` run `24699127750`
  - `Observability E2E` run `24699127754`
  - `.github/workflows/monitoring-alert.yml` run `24699127733`
  - `Deploy to Production` run `24699127734`
- Artifact:
  - `deploy-logs-24699127741-1`
- Local evidence path:
  - `output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/deploy.log`
  - `output/dingtalk-965-deploy-20260421/deploy-logs-24699127741-1/step-summary.md`

## Notes

- The authoritative deploy evidence for this rollout is the `Build and Push Docker Images` workflow, because it contains the successful `deploy` job.
- The separate `Deploy to Production` workflow also ran for the same merge, but in this case only its `test` job executed; it should not be treated as the source of truth for the actual remote rollout.
- This turn did not add new runtime code or migrations. It only documented the already-completed production rollout.
