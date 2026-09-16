# Pull Request（中文模板）

文档：请参考 `AGENTS.zh-CN.md`（含“本地开发与排障”）。

## 目的
- 变更做了什么？为何现在做？

## 变更内容
- 代码/路由/契约等关键改动概述

## 验证
- 本地命令（构建/测试）：
  - `pnpm install --frozen-lockfile`
  - `pnpm -F @metasheet/core-backend test`
  - `NODE_ENV=test pnpm -F @metasheet/core-backend test:integration`
- 契约（如适用）：`curl -s http://localhost:8900/api/plugins | jq`

## 风险与回滚
- 潜在影响与回滚方式

## 清单
- [ ] 单一关注点，避免无关改动
- [ ] 锁文件已提交，CI 通过
- [ ] 遵循编码规范（ESM、TS、2 空格）
- [ ] 文档按需更新
- [ ] 遇到问题时已参考本地排障
  - 参见 `AGENTS.zh-CN.md` → “本地开发与排障”
  - 一键修复脚本：`bash scripts/fix-local-core-backend.sh`

## 硬门

- [ ] **新增操作 / 新增插件消费者 / 部署或授权边界变更必须配套独立 ADR**：以下三类变更，代码与对应 ADR 必须分别提交为不同 PR，不得夹带在功能 PR 里顺手改：
  - 新增操作：新端点、新动作（route/action/RPC）。
  - 新增插件消费者：某插件首次拿到宿主 facade，或已有插件的 facade 能力范围被扩大。
  - 部署边界或授权边界变更，例如：把某路径加入全局门豁免表、扩大 `mst_` allowlist、给 fail-closed 门加旁路开关。
  - 自查：本 PR 若命中以上任一类型但未在描述中链接对应 ADR，视为未完成，需拆分 PR 或补 ADR 后再合并。

