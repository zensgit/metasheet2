# 多维表线 W0 收官 → W1 完成 → W2 解锁 — 设计与验证记录(2026-07-15)

**类型**:goal 周期收官记录(设计 + 验证台账,docs-only,零 runtime)。
**范围**:自 W0-1 改道令(owner 2026-07-14「generation-aware contiguity + site disposition」)至本文,统一路线(真源 #4211)上的全部落地。前序 W0 主体台账见 `multitable-w0-trusted-substrate-design-and-verification-20260714.md`(#4254),本文与其衔接、不重复。
**纪律基线**:每条 runtime PR 独立对抗门禁(Opus);verdict 绑 exact head SHA,**任何 rebase(含内容零变)⇒ 重跑 mutation + Node 20 CI 才可 arm**(owner 硬规则 2026-07-14);arm 前查 owner review;测试合同类 PR 由协调层直接实审(非橡皮章,见 §4 两次实抓)。

---

## §0 一句话

W0 可信底座在 owner 复审(PASS + 两 Medium)后**全部闭环**(contiguity 纠错、最后一个具名 revision 缺口、补救 rung、规模化启用门前置);W1(P2-2 三部曲 + G-10 术语映射)**开发侧完成**;W2 以 PROPOSED 设计锁解锁,等 owner 裁 OD-W2-1..8。

## §1 落地台账(本周期 11 PR,全 MERGED)

| # | 件 | PR | merge SHA | 门禁/审 |
|---|---|---|---|---|
| 1 | **W0-1 generation-aware contiguity**(替换 live-vs-latest;4 marker 站点/统一 isSystemSheet/C4 fence+C8 同事务) | #4269 | `3356a7ed6` | Opus ×5 轮(3 轮实质硬化)+ owner 复审 **PASS** |
| 2 | **field-undelete revision emit**(最后一个具名缺口;KNOWN_REVISION_GAPS 清空) | #4279 | `8b483b7f5` | Opus ×3 轮;owner 复审 = 核心正确 + 两 Medium(→#4286) |
| 3 | **补救 rung**:双点接线 ×6 spec + 原子性 golden(scoped trigger 全回滚) | #4286 | `b6b7dc85a` | 协调层实审(owner findings 逐条验) |
| 4 | print-test 硬化(空转断言→真读 SFC,mutation 双向咬) | #4285 | `2f8980b48` | 协调层实审(空转类当场抓) |
| 5 | **W1 P2-2c 响应式 rail**(768px 折叠/抽屉;桌面零变结构性证明) | #4290 | `a52f55845` | Opus ×2 轮(真浏览器 harness 反空转审计) |
| 6 | **W1 G-10 术语映射**(~75 zh 串→工作区/数据表/视图/记录;key/EN/标识符零动) | #4295 | `dde71a441` | Opus ×4 轮(不变量独立重导 + 正控) |
| 7 | **W2 统一记录检查器设计锁(PROPOSED)** | #4287 | `e5a5fbddb` | 设计交付物;OD-W2-1..8 留 owner |
| 8 | 5 个孤儿 web spec 接线(4 新 +1 显式化) | #4298 | `98bf851d8` | 协调层实审(token 精确性 +27 恒等式) |
| 9 | 测试补强:deleteScopeHash 漂移 golden + autoNumber 快照钉实 + reset-pit 半接线补 | #4300 | `949dc5396` | 协调层实审 |
| 10 | **批量 revision emit + 规模基准**(启用门前置;769× 语句缩减 @N=10k) | #4299 | `818e5b91c` | Opus ×3 轮(跨 chunk 原子性构造证) |
| 11 | comment-inbox-view 隔离修复 + 接线(root cause 纠错:Node 版本敏感 flush,非批内污染) | #4306 | `0279acf80` | 协调层实审 |

## §2 设计要点(每件一段,为什么是这个形)

**W0-1 contiguity(#4269)**:世代模型 = delete revision 切分的链段;当前世代 = 最后一个 delete 之后的后缀;判据 = [genStart..liveVersion] 每个 version 恰一个 canonical 占位(create/update revision 或 lock/unlock marker)。**链序比较器 = (epoch-ms, version, delete-last) 结构化比较**——不是打包数值(见 §4 catch-2);同 ms 多 vintage 翻转(delete@2/create@3/delete@4 同 T)靠 version 主序;同 (epoch,version) 的 delete-reuse 靠 delete 后置。marker 走独立表 `meta_record_version_markers`(规避 C7 action-CHECK 迁移涟漪,owner §6.3 预许的路径)。保留 live content projection 为第二层(owner 复审点名认可「不是换成另一个脆弱 count」)。

**field-undelete emit(#4279)+ 批量化(#4299)**:rehydrate 写必 bump 新 version + full snapshot 同事务(contiguity 相容形:同 version 双占位 = duplicate_version_event 拒);零行不写(FK-less 幽灵);`recordRecordRevisionsBatch` = 1000 行/语句分块的多行 INSERT,列语义与单行 helper **逐列一致 + 双路写入 byte-identical 实证**;跨 chunk 原子性由 caller 事务保证(第 2 chunk 触发失败 ⇒ 第 1 chunk 也回滚,构造证)。基准:N=10k 语句 10,003→13(769.5×),wall 3.2×(下界,顺序偏暖);N=50k 为线性外推(如实标注)。**flag 仍 OFF——本件只满足启用前置,启用本身 = owner 决策。**

**P2-2c(#4290)**:断点 768px 只在 JS(单一常量,无 CSS media query 复制);<768 自动折叠到既有 36px 图标条;窄屏再展开 = absolute overlay 抽屉(tokens 阴影/底色);Escape 作用域限定 rail 内(不抢单元格编辑器);**桌面不变性是结构性的**(宽视口分支不写状态,非仅测出来的)。已知外观残余:窄屏挂载有一帧未折叠闪现(onMounted 在首绘后),注释如实声明。

**G-10(#4295)**:两不变量 = ①i18n key 集 + EN 值集 byte-identical ②零代码标识符/路由/API 变动——门禁独立重导 + 正控(注入 key 重命名必被抓)。新增回归锁 spec 钉词典值(在 required web-tests 内,mutation 咬)。两个 owner 口味项开放:grid aria `数据表`、规则编辑器 `数据表 ID`。

**W2 锁(#4287,PROPOSED)**:实况 = 三个组件抢右缘(`MetaRecordDrawer`/`MetaCommentsDrawer`/权限 modal);统一 = 单一 `MetaRecordInspector` 壳复用既有面板。硬不变量 HI-1 = **零新数据路径**(每面板只走既有 read gate,approval 面板因此出局);R11 `restored_from_version` 未达记录抽屉 = 真缺口(OD-W2-5);restore 需迁 preview-first。8 个 OD 全开放,附推荐。

## §3 验证台账(不是绿了,而是为什么信)

- **mutation 全覆盖**:每条 runtime 守卫至少一次「变异落地→红→复原→绿」闭环;变异**先证自己落地**(#4299 门禁自抓了一次 perl \n 未替换的假变异)。
- **真库都在 CI 真跑**:六件 realdb spec 双点接线(no-DB 不 collect + DB 白名单真跑,双向 collect-delta 证明);原子性 golden 在 CI DB 步真执行后才 merge。
- **真浏览器**:P2-2c 的 drawer CSS 在真 Chromium 读 getComputedStyle + 正控(position:absolute→static 必红);门禁 diff 了 harness CSS vs 组件源(防复制漂移空转)。
- **CI-mirror 全量**:每件合前跑完整 CI 步(core-backend 全量 no-DB / 202 文件 DB 白名单 / run-required-web-tests.sh 全量),不再手挑子集(§4 catch-1 的教训)。
- **规模**:chunk 边界 999/1000/1001/2000 真库钉;参数预算 12k≪65535。

## §4 本周期抓住的三类「绿着的假」(留档防再犯)

1. **层叠遮蔽**:#4269 的 unit 步红把 DB 白名单步整个遮蔽,守卫窗口修好后 DB 步**首次真跑**才暴露 orderKey bug——「required job 红」可能盖着第二层红;修好第一层必须重看全部步。
2. **float64 打包吞 tiebreak**:`epoch*1e6+version` 在 2026 纪元 ULP≈256,version 被吞;注释自称「sub-ms tiebreaker」= 未测不变量;三轮门禁没抓到,因 unit goldens 用小整数——**数值断言必须用生产量级输入测**。
3. **空转/自指测试**:#4285 的 print 测试断言自声明字符串含自身子串;#4306 的「批内污染」实为 Node 版本敏感的固定 tick flush(CI Node 20 下隔离跑也 5/5 红)——修法 = flushUntil(谓词) 有界轮询,不猜 tick 数。

## §5 owner-gated 残余(明标,不被本文的「完成」掩盖)

- **W0-1 锁仍 PROPOSED**:C2(时间单调;fail-open 跨 ms 时间倒转可遮洞——门禁实证旧编码同样接受,非回归)/C3(跨世代重建)/C6(trusted-since 锚)未裁未做。
- **field-undelete flag 启用**(前置已满足)与一切 flag/W5 分档启用。
- **W2 实现**:等 OD-W2-1..8 裁决,按锁 §7 切片跑。
- G-10 两个口味项;多维表-browser-verify 的 harness 复制漂移残余;5 个新接线 dingtalk spec 的 guard 路径触发(advisory 面)。
- W3(应用化)/W4(受治理 AI)按 owner 排序在 W2 实现之后。

## §6 本文不主张什么

不主张任何锁被 ratify(#4287、W0-1 §6.5 均 PROPOSED);不主张 flag 开启;不主张 C2/C3/C6 已解;不主张「全部开发好了」——主张的是:**decision-clean 池已清空,剩余 = owner 裁决项 + 其下游切片**。
