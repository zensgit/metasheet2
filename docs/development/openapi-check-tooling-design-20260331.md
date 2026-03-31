# OpenAPI Check Tooling Design

日期：2026-03-31

## 目标

把当前主工作树里最后剩下的工具脚本 [openapi-check.mjs](/Users/huazhou/Downloads/Github/metasheet2/scripts/openapi-check.mjs) 正式纳入版本控制，作为 OpenAPI 结构校验的轻量入口。

## 背景

在完成：

- generated artifacts cleanup
- Claude task pack archives
- DingTalk rollout docs backlog

之后，主工作树只剩一个未收口路径：

- `scripts/openapi-check.mjs`

这说明总基线已经从“多条业务线和生成物混杂”，收敛到“单一工具脚本未纳管”。

## 工具职责

`openapi-check.mjs` 提供不依赖额外 YAML 解析器的 OpenAPI 轻量 smoke 校验，覆盖：

- YAML 基础结构检查
- main spec / fragment 顶层结构检查
- `$ref` 文件存在性检查
- 跨文件 path 重复定义检查
- path operation 是否带 `responses`

## 设计原则

### 1. 轻量、零额外依赖

脚本只使用 Node 内置模块：

- `fs`
- `path`
- `url`

避免把 OpenAPI smoke 变成依赖管理问题。

### 2. 定位为 smoke，不替代完整 schema validator

它的职责是快速发现明显断层，而不是实现完整 OpenAPI 语义校验。

因此：

- 足够快
- 可直接纳入本地验收和 on-prem rollout 验证
- 失败信息聚焦在仓库自身结构问题

### 3. 与 DingTalk 合同面协同

前面已经把 DingTalk OAuth / directory 的 OpenAPI 合同收口了，因此这个脚本现在是：

- 本地复跑入口
- rollout 复核入口
- baseline reconciliation 的最终工具收尾项

## 非目标

- 不生成 SDK
- 不替代正式 OpenAPI lint / bundling
- 不修改任何 OpenAPI 内容

## 结论

这条工具 slice 的意义不在功能扩展，而在把仓库最后一个遗留的校验入口正式落库，使总工作树真正回到可控状态。
