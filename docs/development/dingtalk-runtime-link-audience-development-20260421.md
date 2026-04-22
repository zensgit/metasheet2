# DingTalk Runtime Link Audience Development

- Date: 2026-04-21
- Branch: `codex/dingtalk-runtime-link-audience-20260421`
- Scope: backend DingTalk automation message runtime

## Goal

Make the actual DingTalk group/person message show the public-form access mode and local allowlist audience beside the fill link.

Before this slice, the editor and rule cards could show `Public form access` and `Allowed audience`, but the message sent to DingTalk only included `填写入口` and `处理入口` links.

## Implementation

- Added runtime helpers in `AutomationExecutor` to describe public-form access modes.
- Appended `表单访问` under the generated `填写入口` link.
- Appended `允许范围` for DingTalk-protected forms, including:
  - all bound DingTalk local users
  - all authorized DingTalk local users
  - local allowlist user/member-group counts
- Reused the same parsed public-form config already loaded for runtime link validation.
- Updated backend unit tests for group robot messages and person work notifications.
- Updated DingTalk operations/capability docs to state that runtime messages now include access/audience text.

## Runtime Message Shape

For a public form:

```markdown
**快捷入口**
- [填写入口](...)
- 表单访问：任何获得链接的人可填写
```

For a DingTalk-protected form with allowlists:

```markdown
**快捷入口**
- [填写入口](...)
- 表单访问：钉钉登录 + 本地授权
- 允许范围：1 个本地用户、1 个本地成员组通过钉钉校验后可填写
```

## Files

- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`
