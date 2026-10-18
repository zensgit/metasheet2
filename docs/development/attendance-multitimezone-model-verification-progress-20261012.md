# 考勤多时区：模型分工及验证进度

日期：2026-10-12。状态：验证进行中；Draft PR #6350 未更新到当前实现，整体验收未完成。

## 设计与模型参与

合同见 attendance-multitimezone-design-lock-20261012.md 与 attendance-multitimezone-implementation-contract-20261012.md。关闭使用组织默认考勤时区；开启按有效批准出差 > 员工配置 > 有效计算考勤组 > 组织默认。时间以 UTC 瞬间存储，已开始班次冻结上下文；关联考勤单据沿用目标班次上下文。保留整班边界及同日多上下文拒绝。

实际分工：Sol 6.1/high 实现及合成夹具；Astra/high 合同审阅与反证；Luna/medium 文档和证据整理；Kimi CLI 2.1.1 的 kimi-code/k3 已完成只读检查，CLI 未暴露独立 effort，采用配置默认；Grok CLI 1.0.50 / Runtime 0.8.11 的 grok-4.7 已完成只读检查，TUI 显示 xhigh。模型意见不替代测试或最终整 PR review。

## 源码基线与 PR

实现提交 f54132801562d31614bf221b119fd02640e8de70 已正常合并 main 625d18ae47671d0010c0b8cb1629ac4cd427df17。隔离工作区的当前源码基线为 5f41bddb5f509c0ffa9538633abec2458899f3e0，tree a4d4ded5e95af77c8dbab9bf10018dfbbc6983cb。该表述是源码基线，不代表后续文档提交后的 HEAD。d6-final-main-alignment.json 记录 main 对齐未改变 core、plugin-attendance 或 apps/web。Draft PR #6350 远端仍停留在旧 head af39645247c38e96637d12552dfd0addeacaff61，当前实现尚未 push；该旧 head 的 CI 不验证当前实现。新 head 的 CI 尚待运行。Ready/merge/deploy/enable 未获授权。

## 已有验证证据

| 项目 | 实际结果 | 证据边界 |
|---|---|---|
| typecheck-v3 | exit 0 | 仅 typecheck 结果。 |
| d6-authority-native-root-v3：store/runtime/read/membership/write/browser | 19 + 65 + 21 + 10 + 9 + 8 = 132 assertions PASS | 按 verification receipt 的分套件状态。 |
| native approval | beforeAll 120000 ms timeout；1 sentinel PASS、17 PENDING | 不属于业务 PASS；不得把 sentinel 或 pending 计入 132。 |
| migration | full migration、replay、cleanup 均 exit 0；sourceDrift=[] | 不替代 down/up、有数据阻断或其他迁移门槛，除非相应 receipt 明确覆盖。 |
| schema guard red | d6-schema-guard-red-root：22 pass / 6 fail | 两个 false-presence 案例实际解析为 undefined，按真实失败保留。 |
| schema guard green 初次 | d6-schema-guard-green-root：25 files，711 pass / 1 fail | 失败是旧缺表 fixture 没有合法 group/user；不能宣称全绿。 |
| schema guard 修 fixture 后 | d6-schema-guard-green-root-v2：whole 3 files，41/41 | 只报告该回执范围；不得合并成 712/712。 |

## 审阅发现与未完成复验

Astra 发现 schedule 缺 companion 表可绕过 guard，以及 trip 取消文案仍指向 leave。本轮验证记录这两项已修复，但对应 native 和新 UI 尚未运行，暂不关闭。

新增 runtime 非法 zone、OFF 下真实已批准 trip、两个持久 Node 策略读取补证；mobile 4 类截图；4 个 P1 native cases 尚待执行。MT16 的移动证据缺口已补 test，仍待 run。最终 CI、Linux checkpoint 四项 CLEAN/零扫描和整 PR Astra 终审均 pending。

## MT 范围裁定

Root 对照设计锁裁定：MT02 由纯/loader 加 native calendar/scheduled 组合覆盖原锁逐层继承；MT05 由 same-epoch 挂载 UI 加 native 午夜场景覆盖原锁；MT13 的真实 DST 120/240 场景覆盖分钟口径，不额外强制所有 writer、双 browser、overnight 420/540。MT16 移动证据有新增 test 待运行。按裁定逐项挂接证据，不增添原锁没有要求的额外证明，也不将待运行证据判通过。

## 当前结论

总体状态：PENDING / NOT COMPLETE。132 项 native 通过不覆盖 approval 超时、P1 native/UI 待复验、完整 MT01–MT20、最终 PR CI 与 checkpoint。PR 远端仍是 af396 旧 head，不能把其状态或 CI 当作新实现验证。每份后续 receipt 均需注明源代码基线、具体 suite、断言状态、exit、cleanup、source drift 及限制。Ready、合并、部署、启用仍需用户另行授权。
