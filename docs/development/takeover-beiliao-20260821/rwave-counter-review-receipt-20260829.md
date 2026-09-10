REVIEW-BASE: 94b6788e7

# R-wave 反向复核回执:四条 P1 确认,前向修复(2026-08-29)

> 来源:外部复核对 R-wave(#5323,已合入 `94b6788e7`)与 O1-A(#5321,在途)的反审。**裁定:接受 Request Changes 精神,四条 P1 全部确认为真,前向修复支 `sec/runner-seam-harden-r2`(R2)已开。** #5321 暂停,待 R2 先行。values-free。
> **诚实定性:R-wave 我合快了。** 我的合并前亲手 RED 只验证了"门会触发",未验证"门能否被绕过 / lookup 是否也武装 / 两次读之间是否可变"。复核方验的正是这些对抗路径。教训见文末。

## 逐条确认(对 `origin/main` 亲验)

| # | 裁定 | 证据 | 影响面 |
|---|---|---|---|
| 1 原型链绕 marker | **真** | 门读 `input[C6_WRITE_LIFECYCLE_CONTEXT] === true`(`pipeline-runner.cjs` `assertC6WriteLifecycleContext`)走原型链;清洗 `withoutServerOnlyRunMarkers`(`index.cjs:159`)用 `hasOwnProperty` 只删自有——**不对称即漏**。Symbol 导出,同进程跨插件可 require。`B2A_AUTHORIZED_RUN_ID` 续用读同病 | latent:dormant 时门不启用 |
| 2 lookup 第二 SQL 未武装 | **真** | `applyLookupProjection`(`data-source-sql-readonly-source-adapter.cjs`)的 `api.select` 四参无 armed/strict;W-5 floor 只覆盖基表 | latent |
| 3 配置 TOCTOU | **真** | 授权用 `getExternalSystemAdapterConfig`(非解密,`pipeline-runner.cjs:~507`)、建 adapter 用 `loadExternalSystemForAdapter`(解密重读,`:~365`);两读间 `lookupObject` 可变,无快照/摘要绑定 | latent + 需并发改配置 |
| 4 replay 运行时未消费 limit | **真** | `artifactReplayLimit` 仅加载期拒非零(`b2a-trial-registry.cjs:673-685`),运行时从不消费;**新登记放旧制品无人拦**。我 R-wave 裁定只想到"同登记复用"(fresh runId 拦得住),漏了这条 | latent |
| 5 confirm 非 CAS(#5321) | **已披露** | O1-A 文内明言 lease renew 非原子、confirm 非 CAS,列 owner 方向题;标注正确,非新缺陷 | 保持披露 |

R-06 lookup schema-pin 的 `TODO(R-02-LOOKUP-SCHEMA-PIN)`(`b2a-trial-registry.cjs:1594`)确未随 O1-A 关闭——复核方指出无误,保持 TODO(需 table-actions 接线,属后续)。

## R2 修复(每条带对抗性常驻负控)

- H-1:所有 server-only Symbol 读改为 own-property 门控(`hasOwnProperty.call && ===true`),与清洗对称;负控=原型携带 marker 被拒(修前接受)。
- H-2:把基表 select 收到的 armed/strict 同样穿入 lookup select;负控=armed + requestTimeoutMs=0 在 lookup 腿也被拒。
- H-3:授权期配置快照/摘要绑定到 adapter 创建,不一致 fail-closed;负控=两读间篡改 lookupObject 被拒。
- H-4:armed 的制品 replay 运行时消费 limit(本刀恒 0 → 恒拒),dry-run/普通运行不受影响;负控=新登记 replay 旧制品被拒(并修正 `b2a-trial-registry-wiring.test.cjs:1930` 原本"允许"的期望)。

## 列车重排

原顺序失效(#5322 已合)。新序:**#5320(已合)→ R2(修 R-wave 缺口)→ 重算 provenance 后的 #5321**(其 fencing 属已披露 owner 方向,不阻合,但 confirm/lease 的结构性修复列为独立 owner 决策)。每步基于前一步实际 merge SHA 重跑 CI、重算 pins。

## 教训(入文,与"绿见过红"同源的进阶)

**验证一道门,必须验它的规避路径,而不止"正常用时会挡"。** 我对 R-wave 的亲手 RED 是"切除门→套件红",证明了门在正常调用下有效;但一道授权门的价值在于**对抗下**是否有效——原型链、未武装的第二跳、TOCTOU、跨制品重放,都是"门在,但绕过门"。此后守卫类变更的合并前亲验,必须包含至少一条"门在、走旁路"的负控,而非只有"门被拆、正门红"。
