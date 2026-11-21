# 自助读取可信租户：GOV-08 独立决策

状态：2026-10-17 owner 明确批准本地实施；代码核验基线 `dcc82a1de0c3434342fc8fdb3f7aa0b3b3de1395`。本文先于代码修复落地。2026-10-18 owner另行批准：先独立提交、推送本文并开文档PR，再将已验证补丁及MD推入既有草稿#6337，运行既有合成CI。独立决策与代码分别提交为不同PR；仍不授权合并、部署、客户读取或真实发送。文档PR以创建时最新main为基底，不把代码基线混称为当前main。

## 决策与范围

只保护下列16个既有接口，不增加端点：

| 接口族 | 操作 | 原权限 |
| --- | --- | --- |
| `/api/integration/read-source-configs` | save / list / get / audit / approve / retire / read | save、approve、retire 为 write；其余 read |
| `/api/integration/read-source-compositions` | save / list / get / audit / approve / retire / run | save、approve、retire 为 write；其余 read |
| `/api/integration/external-systems/:id` | read-smoke / read-source-probe | write |

16个 handler 在原身份与权限检查成功后、参数处理和任何配置/凭据/适配器IO前，统一验证可信租户。直接调用导出的 createHandlers 也必须经过该门，不只包注册路由。

可信值只来自真实JWT中间件设置的 `authenticatedTenantId`，复用现有 `resolveVerifiedClaimTenantId`。无可信claim统一403 `TENANT_CLAIM_REQUIRED`；user携带租户、body/query/params的显式tenantId或x-tenant-id与claim冲突，以及非字符串/空显式租户载体，统一403 `TENANT_MISMATCH`，不回显任何租户值。相同的显式租户保持兼容；缺少身份仍401，缺少原权限仍403，原read/write分层不变。

全局JWT中间件、全局W4开关及其默认、其它旧integration入口、workspace选择及Connection owner合同均不改变。不新增开关，不扩大接口允许的参数；明确拒绝而不重解释含糊的租户载体。合法claimless多组织账号须使用包含已验证tenant的会话；不以header自证或自动membership回退绕过本决策。

## 原因与边界

现有JWT链先保存可信claim，但缺claim时会用header回填user.tenantId；旧scope比较在W4 OFF时可能成为header与自身比较。非SQL的K3 Binding读取不会经过SQL Connection owner resolver。单读、组合运行和探测均有相同入口风险，因此不能只补一条/read。

该决策仅关闭上述16个入口的claimless/显式tenant steering路径，不声明全平台租户隔离已完成，也不授予任何真实客户读取或宜搭发送许可。K3永久禁写、宜搭默认OFF、Bridge plugin分派保持不变。

## 验证合同

- 用真实AuthService验签、JWT中间件及注册插件路由运行合成负例；正常DB/RBAC/session路径不以假的verifyToken替代。W4 OFF依然拒绝claimless请求。
- 16口逐一验证无claim+header、可信claim+foreign显式scope、畸形载体；拒绝前零配置/凭据/适配器依赖IO。真实JWT正常用户、原权限不足、无token、坏签名与过期token分别有控制。
- 合法同tenant正常请求继续进入原实现；现有K3 POST只读、分页、重定向与永久禁写回归保留。
- 内存删除守卫后原负例必须红；错scope/只保护配置不保护组合或probe等有限变异须被真实路径断言拒绝。报告未覆盖的变异，不把源文本扫描当执行证明。
- http-routes.cjs 属被pin文件；最终LF候选重算实际模块清单并跑完整provenance，不能以哈希前归一化掩盖差异。

## 回滚与交付

无DDL/新权限/新环境变量。回滚局部代码会重新打开已知claimless路径，不视作安全回滚；若兼容问题出现，应停用这组自助入口并保留审计，而不是翻全局开关旁路。生产兼容、发布和部署另行裁决。

2026-10-18授权扩大到上述独立文档PR、原草稿推送及既有合成CI，不扩大产品范围。实际结果续记#6337的`docs/development/integration-existing-pr-closeout-verification-20261012.md`；本文不能冒称完整集成目标或新候选正式CI已经完成。

## 本地实施结果（2026-10-17）

已按以上决策完成局部 helper 与16个 handler 接线；生产修改只在 `lib/http-routes.cjs`，另更新三个既有测试文件及实际 provenance 清单中的一个哈希。无全局身份/默认开关改动、无DDL、新端点或新权限。独立 Astra high 前置调查、Astra ultra 补丁只读复核均已完成，后者无新增阻断；不是全仓安全扫描。

真实 AuthService/JWT/宿主/PG 整文件最终40/40（23原测试+16入口矩阵+1隔离哨兵）；直接 handler 矩阵通过；K3八整文件130/130。删除门的真实JWT变异使16条新增用例全红；另23种有限内存变异全部被直接handler测试杀死。provenance与四条原类型检查、额外宿主测试类型检查通过。完整命令、范围限定、初次临时类型配置失败及修正、清理与哈希记录在既有[代码草稿#6337](https://github.com/zensgit/metasheet2/pull/6337)对应的验证MD中；独立文档PR不夹带该代码分支的验证文档或运行时改动。

此结论为本地候选 `fixed`，不意味着代码已上线或新候选正式CI通过；CI结果须按实际推送head另记。现存claimless会话调用这16口将被拒绝，这是本决策明确批准的兼容收紧；其它历史入口不在本次保证范围。
