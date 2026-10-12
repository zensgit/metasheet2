# 考勤多时区：模型分工与验证计划

日期：2026-10-12。状态：Draft 验证计划；不代表整体验收、PR Ready、合并、部署或启用。

## 目标与边界

按已批准合同完成多时区实现的最终验证。行为以 attendance-multitimezone-design-lock-20261012.md 与 attendance-multitimezone-implementation-contract-20261012.md 为准：关闭用组织默认考勤时区；开启按有效批准出差、员工配置、有效计算考勤组、组织默认解析；UTC 瞬间为存储基准，班次上下文冻结。保留整班边界及同日多上下文拒绝，关联考勤单据沿用目标班次上下文。

不扩展管理员单据关联矩阵、通用任务/待办时区或通用规则引擎。局部测试、旧 head CI、模型意见和 provenance 都不能替代最终门槛。PR 保持 Draft；Ready、合并、部署、启用及真实数据操作不在本任务授权内。证据须 values-free。

## 模型分工及实际记录

| 工作 | 模型及实际设置 | 边界 |
|---|---|---|
| 实现与合成夹具 | Sol 6.1，high | 以源码、原始测试和 receipt 为证据；模型结论不构成审阅结论。 |
| 合同审阅及反证 | Astra，high | 对最终 diff 独立审阅；旧发现必须有修复后的复验依据。 |
| 文档及证据索引 | Luna，medium | 只按实际回执整理，不推断缺失结果。 |
| 第二意见 | Kimi CLI 2.1.1，kimi-code/k3；CLI 未暴露独立 effort，采用配置默认 | 只读建议，由主审依据代码或原始测试核实。 |
| 第二意见 | Grok CLI 1.0.50 / Runtime 0.8.11，grok-4.7，TUI 显示 xhigh | 只读建议，不代替运行时、数据库或 CI 证据。 |

## 按难度调整 effort

明确的小修复采用 Sol 6.1/medium，跨模块常规实现用 high；事务、权限、竞态与时区边界先用 Astra/high，仅在复杂反例无法收敛时升级 xhigh/max。文档与证据整理用 Luna/medium。Grok 和 Kimi 承担边界清楚的独立检查；记录实际 CLI 模型和设置，不把未提供的 effort 参数写成已设置。模型升级不改变验收标准，也不扩大开发范围。

## 收尾顺序与成功条件

1. 记录当前源代码基线、tree、main 基线及 PR 远端 head/status。文档自身后续提交不得倒写成代码源码基线。
2. 汇总 v3 native 七套件的逐套状态，按原始 assertion status 分类；区分业务断言、sentinel、pending、cleanup 与 source drift。
3. 解决独立审阅发现，并在修复后重跑相应 P1/native/UI 案例。模型审阅或局部修复不能自动关闭该门槛。
4. 根据已裁定的 MT02/MT05/MT13 范围映射证据，不增加原设计锁未要求的 writer/browser/班次组合。MT16 桌面/移动证据仍须按合同逐项闭环。
5. 完成 MT01–MT20、migration/replay/rollback、Web 双门禁与后端 CI、最终 13 项 CI、Linux checkpoint 四项 CLEAN/零扫描及最终 provenance。每项记录命令/场景、源码基线、receipt、结果和限制。
6. Astra 在最终 diff 上复审，主审核对最终 PR head、CI、checkpoint 和所有门槛，更新最终验证 MD。

成功条件是适用门槛均有最终源码绑定的可复核证据且无未解决审阅项。此结果仍不改变 Draft，也不授予外部操作权限。

## 当前源码和门禁状态

实现提交 f54132801562d31614bf221b119fd02640e8de70 正常合并 main 625d18ae47671d0010c0b8cb1629ac4cd427df17 后，隔离工作区的源码基线为 commit 5f41bddb5f509c0ffa9538633abec2458899f3e0，tree a4d4ded5e95af77c8dbab9bf10018dfbbc6983cb。使用“源码基线”称呼该状态；后续文档提交不属于此代码 SHA。d6-final-main-alignment.json 记录此次 main 对齐未改变 core、plugin-attendance 或 apps/web。Draft PR #6350 远端仍是旧 head af39645247c38e96637d12552dfd0addeacaff61，尚未 push 当前实现；最终新 head CI 与 Linux checkpoint 均 pending。

typecheck-v3 exit 0。d6-authority-native-root-v3/verification-receipt.json 记录 store 19、runtime 65、read 21、membership 10、write 9、browser 8，共 132 个 assertion PASS；full migration、replay、cleanup exit 0，sourceDrift=[]。approval suite 的 beforeAll 在 120000 ms 超时，仅 1 个 sentinel PASS、17 项 PENDING，不能判为业务 PASS。不得把 approval sentinel 加入上述 132，也不得把 pending 当通过。

## 尚待复验的审阅项与补充

Astra 独立审阅指出 schedule 缺 companion 表时可绕过 guard，以及 trip 取消文案仍指向 leave。本轮两项已修复，但 native 与新 UI 验证尚待执行。schema guard 的历史结果须分开写：修复前 d6-schema-guard-red-root 为 22 pass / 6 fail，其中两个 false-presence 案例确实解析为 undefined；修复后 d6-schema-guard-green-root 为 25 files、711 pass、1 fail，失败为旧缺表 fixture 未提供合法 group/user；修 fixture 后 d6-schema-guard-green-root-v2 为 whole 3 files、41/41。不得合并表述为 712/712。

另有 runtime 非法 zone、OFF 下真实已批准 trip、两个持久 Node 策略读取补证；4 类 mobile 截图；以及 4 个 P1 native cases 待执行。上述局部补证和修复不等同最终 MT PASS。

Root 对 MT 审计范围的裁定：MT02 由纯选择/loader 与 native calendar/scheduled 组合覆盖原锁逐层继承；MT05 由 same-epoch 挂载 UI 与 native 午夜场景覆盖原锁；MT13 以真实 DST 120/240 分钟场景证明分钟口径，不额外强制所有 writer、双 browser 或 overnight 420/540。MT16 移动证据缺口已补 test，仍待 run。最终逐门槛记录须尊重此裁定，不能扩大或缩小原合同范围。

## 状态约定

PASS 仅用于最终源码绑定且该门槛全部断言完成的证据。PARTIAL 表示有局部证据但仍缺场景或最终源码绑定。FAIL 表示最终源码绑定的适用门槛存在可复现失败。PENDING 表示尚未运行、未终态或结果未核实。NOT APPLICABLE 必须有合同及实现依据，不能把未运行写作不适用。
