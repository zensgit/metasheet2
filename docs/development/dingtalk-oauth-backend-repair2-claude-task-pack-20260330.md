# DingTalk OAuth Backend Repair-2 Claude Task Pack

日期：2026-03-30

## 目标

只修 `dingtalk-oauth-backend-repair1` 之后剩下的最后一个 blocker：

- OpenAPI 必须与当前 runtime 的 callback `state` 校验逻辑完全一致

本轮是 **micro repair**。不允许再动任何运行时代码、测试代码、前端代码或部署代码。

## 当前阻塞

以 [dingtalk-oauth-backend-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-oauth-backend-verification-20260330.md) 的最新 Codex 独立验收为准，当前唯一 blocker 是：

- [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml) 里 `/api/auth/dingtalk/callback` 仍然只写 `required: [code]`
- `400` 仍然只描述 “Missing code parameter”
- 但运行时代码已经要求 `state` 必填，并对 missing / invalid / expired state 都返回 `400`

## 允许写入

- `packages/openapi/src/paths/auth.yml`
- `docs/development/dingtalk-oauth-backend-verification-20260330.md`
- `docs/verification-index.md`

## 明确禁止

本轮不允许修改：

- `packages/core-backend/src/**`
- `apps/web/src/**`
- `apps/web/tests/**`
- `packages/core-backend/tests/**`
- `scripts/**`
- `docs/deployment/**`
- `docs/development/dingtalk-oauth-backend-design-20260330.md`
- `output/**`

## 必做项

### 1. OpenAPI 对齐

把 `/api/auth/dingtalk/callback` 契约改成和当前 runtime 一致：

- `required: [code, state]`
- `400` 描述不再只写缺 code，要覆盖：
  - missing code
  - missing state
  - invalid / unknown state
  - expired state

不要求把 4 种错误拆成 4 个 status code，继续保持 `400` 即可，但文档描述必须真实。

### 2. 验证文档回填

更新 [dingtalk-oauth-backend-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-oauth-backend-verification-20260330.md)：

- 补上本轮 `repair-2` 的实际修复内容
- 补上本轮命令执行结果
- 如果修完后你认为已通过，文档里必须明确写“当前 blocker 已关闭”

## 必跑命令

```bash
node scripts/openapi-check.mjs
```

## 交付物格式

Claude Code 回传时必须包含：

- 改动文件列表
- `node scripts/openapi-check.mjs` 的结果
- `/api/auth/dingtalk/callback` 最终 request/400 响应语义
- 验证文档回填了哪些段落
- 未解决风险

## Codex 独立验收标准

我会独立复核：

- 是否只改了允许文件
- [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml) 是否与当前 runtime 一致
- `required: [code, state]` 是否真的落下
- `400` 描述是否覆盖 missing / invalid / expired state
- 验证文档是否真实回填，而不是泛泛写“已修复”

## 给 Claude Code 的直接提示词

```text
Implement the "dingtalk-oauth-backend-repair2" task pack in /Users/huazhou/Downloads/Github/metasheet2.

This is a micro repair. Do not modify runtime code.

Write boundary:
- packages/openapi/src/paths/auth.yml
- docs/development/dingtalk-oauth-backend-verification-20260330.md
- docs/verification-index.md

Do not modify:
- packages/core-backend/src/**
- packages/core-backend/tests/**
- apps/web/src/**
- apps/web/tests/**
- scripts/**
- docs/deployment/**
- docs/development/dingtalk-oauth-backend-design-20260330.md
- output/**

Goal:
Align the OpenAPI contract for /api/auth/dingtalk/callback with the current runtime state-validation behavior.

Required changes:
1. auth.yml must require both code and state
2. auth.yml must describe 400 cases for missing code, missing state, invalid/unknown state, and expired state
3. verification doc must be backfilled with this repair-2 result

Required command:
- node scripts/openapi-check.mjs

Return:
- changed files
- openapi-check result
- final /api/auth/dingtalk/callback request + 400 semantics
- what was added to verification doc
- unresolved risks
```
