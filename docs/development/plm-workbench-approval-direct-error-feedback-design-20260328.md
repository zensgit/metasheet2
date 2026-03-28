# PLM Workbench Approval Direct Error Feedback Design

## Problem

`Approval Inbox` 的 direct `approve / reject` route 还会返回一批 legacy 顶层字符串错误：

- `401` `User ID not found in token`
- `404` `Approval instance not found`
- `400` `Cannot approve/reject: ...`
- `500` `Failed to approve/reject request`

但前端 `approvalInboxFeedback` 只优先识别 `error.message` 或顶层 `message`，不识别顶层字符串 `error`。这样 direct route 一旦命中这些分支，Inbox 仍会退化成泛化 HTTP 文案。

## Design

- 在 `resolveApprovalInboxErrorRecord(...)` 里补上顶层字符串 `error` 分支。
- 继续保持现有优先级：
  - 先吃结构化 `error.message`
  - 再吃 legacy 顶层字符串 `error`
  - 再回退到顶层 `message`
  - 最后回退到 HTTP fallback

## Expected Outcome

Inbox 对 direct approval route 的错误反馈会同时兼容结构化新契约和 legacy 顶层字符串错误，不再把真实后端文案降级成 `404 Not Found` / `500 Internal Server Error`。
