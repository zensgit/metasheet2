# Multitable Embed Host Gate Hardening

## Context

上一轮已经把 embed-host 两层证据都推到了更上层 artifact：

- protocol evidence
- navigation protection evidence

但 readiness 和 release gate 还留着两个偏旧的口径：

1. readiness 仍把 embed-host 当作“出现时才检查”的 optional evidence
2. release gate 的 focused contract suite 还没有把 `multitable-embed-host.spec.ts` 纳入

这和当前 committed smoke 不一致。现在的 `verify-multitable-live-smoke.mjs` 已经固定运行：

- `verifyEmbedHostProtocol(...)`
- `verifyEmbedHostDirtyFormNavigation(...)`

因此 embed-host 不再是可有可无的附加能力，而是 pilot/ship bar 的正式一部分。

## Goal

把 embed-host 从“可选 evidence”升级成“默认 required evidence”，并让 release gate 的 focused contract suite 在 live smoke 之前先覆盖 host protocol contract。

## Design

### 1. Readiness now expects embed-host by default

`summarizeEmbedHostProtocol()` 和 `summarizeEmbedHostNavigationProtection()` 不再使用 “required when present” 语义。

改成：

- `available: true`
- 缺任何 required check 都直接 fail

这样 smoke 只要成功运行，embed-host 的完整性就是明确的 release bar，而不是条件性 bar。

### 2. Test fixtures should mirror real smoke shape

`multitable-pilot-readiness.test.mjs` 的 baseline fixture 现在直接包含：

- core multitable smoke checks
- full protocol embed-host checks
- full navigation-protection embed-host checks

之后 focused regressions 通过“删掉一项 required check”来验证 failure，而不是再伪造“partial evidence appeared”这种旧语义。

### 3. Runbook should stop speaking conditionally

operator 文档不再写：

- “if smoke includes any `ui.embed-host.*` checks ...”

因为现在 smoke 本来就应该产出它们。runbook 要直接把这两组 evidence 写成固定 acceptance bar。

### 4. Release gate should run the focused host contract suite

在 live smoke 之前，canonical release gate 的 `web.vitest.multitable.contracts` 要显式包含：

- `tests/multitable-embed-host.spec.ts`

这样 host protocol 的 focused contract regressions 会先于更重的 browser smoke 失败，调试成本更低。

## Outcome

这轮之后：

- readiness 不再把 embed-host 当附加项
- runbook 不再用条件语气描述 embed-host
- release gate 在 focused contract 层就会覆盖 host protocol

这让 multitable embed-host 从“增强能力”正式进入 ship bar。
