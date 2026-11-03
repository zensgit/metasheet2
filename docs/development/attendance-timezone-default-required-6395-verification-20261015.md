# #6395 调查复审与 #6419 两项 P2 验证

日期：2026-10-15，Asia/Taipei。范围：修正 #6419 的调查与操作说明；无运行时、测试接线、迁移、目标配置或开关改动。不合并、不关闭 #6395；#6396 的合并、真实回填、部署和启用仍分别先批后动。

## 冻结基线与结论

- 文档修订起点：#6419 `39e92496f9101c6c77f784d9a63410f639c06b2a`；对应源码基线 `42984091d7fe0e4f81ac026243200840c314bb79`。
- 本轮只读核查 main 快照 `6c5597a310ddd89b95203a4a5a30246e9d14ab90`；`index.cjs`、timezone policy store、context loader、runtime 相对上述基线无差异。未合入 main，也未修改 #6396。
- 三个原总览错误码均为 `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED`，与严格 reader 的本组织缺默认行判定一致；宽松 `/rules/default` 回退显示 UTC 不足以证明该行已持久化。
- [最新 QA 留言](https://github.com/zensgit/metasheet2/issues/6395#issuecomment-6189251143)报告配置写入后五个相关接口为 200。这是他方报告的 QA 配置恢复，不是本轮独立目标复测或产品修复。仅名称/时区的 PUT 会补入未确认的其他字段；完整规则和打卡/补卡/请假等业务验收仍待确认。Issue 保持 OPEN，是否关闭由 owner 验收决定。

## 两项 P2

| 发现 | 修正 | 验证 |
|---|---|---|
| 将 PUT 当作只补时区，遗漏字段会变成内置默认值 | 中英文均要求另获目标写入授权，确认并显式提供完整名称、时区、工时、工作日、宽限、迟到/缺勤分层和舍入字段；依据不足停止；接口200后还须核对规则及业务结果 | 从冻结源码提取真实 payload 构造器：仅时区输入精确得到全部内置值；完整合成规则的所有字段保留，两项断言通过 |
| 缺少 id 被误用来反推会话组织为 default | 中英文均说明普通/哨兵组织都可能收到无id内存结果；有id也须核对行归属；可信 actor/tenant 另核对，不从回退响应推断身份 | 从冻结源码提取 loadDefaultRule：普通组织、哨兵组织无行时均无id；注入合成 schema 错误分支也回退，三项断言通过 |

保留业务守卫：缺默认来源保护返回503时停止，其他非预期错误同样停止；不写SQL绕过、不接受静默UTC回退、不将一个组织配置成功推广为全部旧历史兼容。

## 实际验证

在既有 Mac mini 合成隔离环境使用 **Node v20.20.2**，未启动数据库进程，未连接目标环境。

| 检查 | 结果 |
|---|---|
| 精确源码提取的 payload / fallback 反例及正控 | 5 PASS，两个构造器来自固定基线；仅合成适配器 |
| `attendance-timezone-policy-routes.test.ts` | 与下项合计2文件 / 121 PASS，0失败/跳过 |
| `attendance-timezone-context-loader.test.ts` | 覆盖严格默认、关闭态不读取覆盖来源、权限/非法输入等既有回归 |
| 邻居源码归属 | 执行文件与相关模块已核对固定基线 SHA；Mac执行目录虽为隔离候选缓存，不将该候选全树冒称 #6419 |
| 文档变更边界 | 仅调查MD与本验证MD；`git diff --check`通过 |
| #6396 / 目标环境 | 没有合并、真实回填、部署、启用或本轮目标请求 |

定向命令（Mac 的既有依赖环境）：

```bash
node source-counterexamples.cjs
# 从 packages/core-backend 执行；固定 Node20、隔离空配置目录、合成测试环境
node node_modules/vitest/vitest.mjs run \
  tests/unit/attendance-timezone-policy-routes.test.ts \
  tests/unit/attendance-timezone-context-loader.test.ts
```

`source-counterexamples.cjs` 是本轮报告目录里的提取脚本，不新增产品测试或CI接线。schema错误用合成适配器触发，只证明回退分支行为，不冒称真实SQL错误复现。现有测试也使用合成适配器，不是目标DB/HTTP业务验收。本次没有重跑全工作区测试、冷依赖安装或部署演练。

本轮收据位于工作区 `artifacts/6419-p2-20261015/verified-summary.json`、`neighbor-results.json`、`counterexamples.log`；Mac同名报告目录保留脚本、固定源码摘要与日志。原始issue内容仅保存在私有本地快照，公开文档不复制主机、账号、业务数据或凭据。

## CI 与后续门槛

文档更新推送后由现有工作流产生新head检查；旧head的通过状态不能移用于新head。本MD记录的是上述实际执行的5项构造检查和121项邻居测试，不宣称最终13项CI已通过。准确状态查看 [#6419 检查](https://github.com/zensgit/metasheet2/pull/6419/checks)。

本轮完成判定是两项P2文档修正及可复核反例验证，不是目标环境已完成业务验收。后续应由 owner 确认完整实际规则及关联业务结果，再决定 #6395 是否关闭；#6419 保持 Draft，#6396 独立审批边界不变。

调查正文：[修订后的调查结论](attendance-timezone-default-required-6395-investigation-20261015.md)。
