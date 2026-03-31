# DingTalk Ops Hardening Repair-2 Claude Task Pack

日期：2026-03-30

## 背景

`dingtalk-ops-hardening-repair` 之后，Codex 独立验收只剩两个未收口点：

1. `/api/admin/users/batch` 的 OpenAPI 与真实后端返回值不一致
2. `dingtalk-ops-hardening-design-20260330.md` 仍残留上一轮旧描述

真相源文档：

- `docs/development/dingtalk-ops-hardening-verification-20260330.md`

## 本轮目标

本轮是 **micro repair slice**。

只修：

1. OpenAPI 契约与真实运行时代码对齐
2. 设计 / 验证文档与当前实现对齐

本轮 **不允许** 改运行时代码，不允许碰前端，不允许补新功能。

## Canonical Source Rule

本轮明确规定：

- **运行时代码为唯一事实源**
- 不改 `packages/core-backend/src/routes/admin-users.ts`
- 不改任何 Vue 视图
- OpenAPI 和文档必须跟着现有运行时代码走

## 允许写入

- `packages/openapi/src/admin-directory.yml`
- `docs/development/dingtalk-ops-hardening-design-20260330.md`
- `docs/development/dingtalk-ops-hardening-verification-20260330.md`
- `docs/verification-index.md`

## 明确禁止

本轮 Claude Code 不允许写入：

- `packages/core-backend/src/**`
- `apps/web/src/**`
- `apps/web/tests/**`
- `packages/core-backend/tests/**`
- `scripts/**`
- `docs/deployment/**`
- `output/**`
- `scripts/ops/git-*`
- `scripts/ops/*remote-git-slice*`

## 修复要求

### 1. `/api/admin/users/batch` OpenAPI 必须对齐真实后端

后端真实返回值以当前运行时代码为准：

- `data.processed`
- `data.failed`
- `data.results[].status`

当前不应再描述：

- `data.action`
- `data.total`
- `data.results[].success`

### 2. 设计文档必须删掉残留旧描述

至少修正这两类残留：

- `deprovision_ledger` 标记 `rolled_back = TRUE`
- `DingTalkAuthCallbackView` 保持现有回调处理逻辑

它们都必须改成和当前实现一致的描述。

### 3. 验证文档必须回填本轮微修结果

`docs/development/dingtalk-ops-hardening-verification-20260330.md` 需要新增或更新 repair-2 结果，明确记录：

- 本轮未改运行时代码
- OpenAPI 已与 `/api/admin/users/batch` 真实返回值对齐
- 设计文档残留已清理
- 本轮是否通过

## 必跑命令

```bash
node scripts/openapi-check.mjs
```

## 必交付内容

Claude Code 回传时必须包含：

- 改动文件列表
- `node scripts/openapi-check.mjs` 的 pass/fail
- `/api/admin/users/batch` 最终采用的响应 shape
- 已清理的设计文档残留项
- 未解决风险

## Codex 验收重点

Codex 会独立复核：

- 是否真的没有改运行时代码
- OpenAPI 是否真的跟 `admin-users.ts` 一致
- 设计文档是否真的不再残留旧逻辑
- 验证文档是否真实回填

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-ops-hardening-repair2" task pack in /Users/huazhou/Downloads/Github/metasheet2.

This is a micro repair slice. Do not change runtime code. Runtime code is the single source of truth.

Allowed write paths:
- packages/openapi/src/admin-directory.yml
- docs/development/dingtalk-ops-hardening-design-20260330.md
- docs/development/dingtalk-ops-hardening-verification-20260330.md
- docs/verification-index.md

Do not modify:
- packages/core-backend/src/**
- apps/web/src/**
- apps/web/tests/**
- packages/core-backend/tests/**
- scripts/**
- docs/deployment/**
- output/**
- scripts/ops/git-*
- scripts/ops/*remote-git-slice*

Goals:
1. align /api/admin/users/batch OpenAPI with the current runtime response shape in packages/core-backend/src/routes/admin-users.ts
2. remove stale design-doc statements that no longer match the current implementation
3. backfill the verification doc with the repair-2 result

Required command:
- node scripts/openapi-check.mjs

Return:
- changed files
- command run with pass/fail
- final /api/admin/users/batch response shape
- stale design-doc items removed
- unresolved risks
```
