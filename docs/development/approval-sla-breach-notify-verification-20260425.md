# Approval SLA Breach Notify Verification - 2026-04-25

## Commands

```bash
# Inside the worktree at /tmp/ms2-breach-notify
cd packages/core-backend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run \
  tests/unit/approval-breach-notifier.test.ts \
  tests/unit/dingtalk-breach-channel.test.ts \
  tests/unit/approval-sla-scheduler.test.ts \
  --reporter=verbose
```

> Note: this worktree was baselined without a local `node_modules` tree.
> A symlink to the main repo's installed deps was used to satisfy
> `tsc` / `vitest` without invoking `pnpm install` (which the task spec
> forbids):
>
> ```bash
> ln -s /Users/chouhua/Downloads/Github/metasheet2/node_modules \
>       /tmp/ms2-breach-notify/node_modules
> ln -s /Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/node_modules \
>       /tmp/ms2-breach-notify/packages/core-backend/node_modules
> ```

## Results

- Backend TypeScript check: passed with exit code 0 (no diagnostics).
- `tests/unit/approval-breach-notifier.test.ts`: 8/8 passed.
- `tests/unit/dingtalk-breach-channel.test.ts`: 6/6 passed.
- `tests/unit/approval-sla-scheduler.test.ts`: 7/7 passed (regression
  green after notifier wiring).

Aggregate: 21/21 tests, ~300ms total wall clock.

## Covered Scenarios

### `ApprovalBreachNotifier`
- Empty id input is a no-op; no metrics fetch, no channel call.
- Both DingTalk and email channels receive every breached instance in
  parallel; each call sees a Chinese-language title, body, and link.
- Channel failures (thrown errors and `{ ok: false }` returns) are logged
  but do not block sibling channels.
- `ok: false` from a channel does not throw; the notifier reports
  `failed: 1` in `NotifyResult.perChannel`.
- Idempotency: two consecutive calls with overlapping ids re-dispatch only
  the genuinely new ids; previously-notified ones are reported in
  `skipped`.
- Recovery: an instance whose every channel failed is **not** marked as
  notified, so the next tick will re-dispatch and succeed once the
  transient fault clears.
- Zero configured channels reports a graceful `skipped` count without
  hitting the metrics service.
- Missing context (notifier given an id whose JOIN returns nothing) still
  composes a usable message with `未命名模板 / 未知申请人 / 未知节点`
  fallbacks.

### `ApprovalBreachDingTalkChannel`
- Returns `{ ok: false, error: 'webhook not configured' }` when the env
  var is unset.
- Same fallback when the configured URL fails the HTTPS / host /
  access_token validation in `normalizeDingTalkRobotWebhookUrl`.
- Posts a `msgtype: markdown` payload (title + `### title\n\nbody +
  link`) to the signed webhook URL. The signed URL contains both
  `timestamp=` and `sign=` query params when a `SEC...` secret is
  provided.
- Surfaces upstream HTTP errors as `HTTP <status>: <body>`.
- Surfaces non-zero `errcode` JSON bodies via
  `validateDingTalkRobotResponse`.
- Wraps network errors so the notifier sees `{ ok: false, error: <msg> }`
  instead of a thrown exception.

All HTTP paths use a mocked `fetchFn`; no real HTTP calls are made.

### `ApprovalSlaScheduler` regression
The seven existing scheduler tests (happy path, error swallow, reentrancy
guard, leader/follower election, takeover, and Prometheus gauge
transitions) all pass unchanged after the notifier wiring landed. Wiring
flows exclusively through the existing `onBreach` parameter, so no
scheduler internals were modified.

## Sample DingTalk Payload

The body of the POST issued by the channel for a breached instance with
template `请假申请`, requester `张三`, current node `manager`, started at
`2026-04-25T08:00:00Z`, SLA `24` hours, breached at
`2026-04-26T08:00:00Z`, observed at `2026-04-26T10:00:00Z`:

```json
{
  "msgtype": "markdown",
  "markdown": {
    "title": "审批超时告警 | 请假申请 | 实例 #inst-1",
    "text": "### 审批超时告警 | 请假申请 | 实例 #inst-1\n\n- 申请人：张三\n- 启动时间：2026-04-25 08:00:00 UTC\n- SLA 阈值：24 小时\n- 超时时长：2 小时\n- 当前节点：manager\n- 详情链接：https://app.example.com/approval/inst-1\n\n[查看详情](https://app.example.com/approval/inst-1)"
  }
}
```

## Local Validation

1. Pick a DingTalk group, add a custom robot with 加签 + a keyword (e.g.
   `审批超时` so the message title matches), copy the webhook URL and
   `SEC...` secret.
2. Export the env vars on a backend dev process:
   ```bash
   export APPROVAL_BREACH_DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=..."
   export APPROVAL_BREACH_DINGTALK_SECRET="SEC..."
   export PUBLIC_APP_URL="http://localhost:3000"
   ```
3. Confirm webhook reachability with a manual `curl` (no signing required
   if the robot is configured with keyword-only):
   ```bash
   curl -X POST -H 'Content-Type: application/json' \
     -d '{"msgtype":"markdown","markdown":{"title":"审批超时告警 (preflight)","text":"### 审批超时告警 (preflight)\n\nready"}}' \
     "$APPROVAL_BREACH_DINGTALK_WEBHOOK"
   ```
   Expected response: `{"errcode":0,"errmsg":"ok"}`.
4. Trigger an SLA breach by inserting a row with `started_at` older than
   `sla_hours`:
   ```sql
   INSERT INTO approval_metrics (instance_id, template_id, tenant_id, started_at, sla_hours)
   VALUES ('demo-overdue', NULL, 'default', now() - interval '48 hours', 1);
   ```
5. Force a tick (the scheduler's default interval is 15 minutes; for a
   faster feedback loop, set `intervalMs` lower in a one-off REPL script
   or restart the backend with the row already present).
6. Verify the DingTalk group received the markdown card with the title
   `审批超时告警 | <模板名> | 实例 #demo-ove…`.

## Not Run

- Live DingTalk integration test. The channel uses a mocked `fetchFn` in
  unit tests; the section above documents the manual curl verification
  path.
- Email channel — currently a logging stub. No transport exists in the
  repo and adding `nodemailer` is out of scope per the task spec; tracked
  as a follow-up.
- Multi-process leader/notifier handoff. The notifier is leader-only by
  construction (it sits behind the scheduler's `onBreach`, which the
  follower never invokes), and the in-memory dedupe is documented to
  re-notify after a leader change.
