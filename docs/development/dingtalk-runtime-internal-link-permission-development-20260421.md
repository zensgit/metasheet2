# DingTalk Runtime Internal Link Permission Development

- Date: 2026-04-21
- Branch: `codex/dingtalk-runtime-internal-link-permission-20260421`
- Scope: backend DingTalk automation message runtime

## Goal

Make DingTalk group/person messages explicitly state that an internal processing link still requires local system access.

This addresses the collaboration case where a DingTalk group can see the message, but recipients without local table/view permission must not be able to open the internal table.

## Implementation

- Added a runtime helper in `AutomationExecutor` for internal processing link permission text.
- Appended `处理权限：需登录系统并具备该表格/视图访问权限` below generated `处理入口` links.
- Applied the same message shape to:
  - `send_dingtalk_group_message`
  - `send_dingtalk_person_message`
- Kept all existing permission enforcement unchanged. The link remains a normal internal multitable route protected by login and local ACL.
- Updated backend unit tests to assert the runtime DingTalk markdown includes the permission line.
- Updated DingTalk operations/capability docs so the documented behavior matches the delivered message.

## Runtime Message Shape

```markdown
**快捷入口**
- [填写入口](...)
- 表单访问：钉钉登录 + 本地授权
- 允许范围：1 个本地用户、1 个本地成员组通过钉钉校验后可填写
- [处理入口](...)
- 处理权限：需登录系统并具备该表格/视图访问权限
```

## Files

- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- A table can still associate multiple DingTalk group destinations.
- DingTalk group destination management remains governed by existing sheet automation permissions.
- This slice does not add new access rules; it only makes the existing internal-link security boundary visible in delivered DingTalk messages.
