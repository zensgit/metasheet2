# DingTalk Group And Person Recipient Rollout Development

Date: 2026-04-20

## Scope

This rollout packet covers the production landing for:

- `#954` `feat(dingtalk): support multiple group destinations`
- `#955` `feat(dingtalk): support person message member groups`

Both features were already merged to `main`. This slice only captures rollout evidence and production verification.

## Included Runtime Changes

### Group Messaging

`send_dingtalk_group_message` now supports multiple DingTalk group destinations in one rule.

- Existing single `destinationId` remains backward-compatible
- New `destinationIds` lets one rule fan out to multiple groups
- Delivery history is still recorded per destination

### Person Messaging

`send_dingtalk_person_message` now supports static local member groups.

- Rule config accepts `memberGroupIds`
- Runtime expands member groups through `platform_member_group_members`
- Only active local users continue to the existing DingTalk-account resolution path
- Frontend authoring supports searching and adding both users and member groups

## Rollout Path

Both changes were deployed through the existing mainline Docker pipeline, not by manual host patching.

Primary production run:

- Workflow: `Build and Push Docker Images`
- Run: `24674833062`
- Head SHA: `0b18d2bc82c4b833d07805b8d77ef096bd65c69f`

The corresponding deploy workflow evidence shows:

- backend/frontend images published with `image_tag=0b18d2bc82c4b833d07805b8d77ef096bd65c69f`
- remote `.env` updated with `IMAGE_OWNER` and `IMAGE_TAG`
- remote deploy stage completed
- migrate stage completed
- smoke stage completed

## Evidence Files

Downloaded artifact evidence lives at:

- [deploy.log](/Users/chouhua/Downloads/Github/metasheet2/output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/deploy.log:1)
- [step-summary.md](/Users/chouhua/Downloads/Github/metasheet2/output/dingtalk-954-955-deploy-20260420/deploy-logs-24674833062-1/step-summary.md:1)

## Notes

- This slice does not add migrations
- This slice does not introduce any manual hotfix on the deploy host
- Production evidence is based on GitHub Actions deploy logs and uploaded deploy artifacts
