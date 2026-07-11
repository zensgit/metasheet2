# 集成线收官后四条线 — 开发完成汇总 — 2026-07-08

## 0. 结论

owner 2026-07-08 授权「根据这 4 条线路开发」。**设计层 4 条全出 design-lock;runtime 层 3 条建到首个
gate-clear rung 并全部 MERGED;第 4 条(REC)按 owner 亲设的 demand-gate 忠实留门未建。**
每个 rung 均过独立 mutation 质量闸。

## 1. 四线终态

| 线 | design-lock | 首个 runtime rung | 状态 |
| --- | --- | --- | --- |
| **1 BA 受控 apply** | #3876 BA-APPLY-0..3 | BA-APPLY-1 变更建议→机读实施清单**导出** | ✅ #3894 MERGED |
| **2 写自助化 W2** | #3878 W2 dry-run/token | W2-a dry-run preview(零外呼写,sandbox-first) | ✅ #3899 MERGED |
| **3 递归 REC** | #3877 R1 就绪 + demand-gate | — | ⛔ **不建**(demand-gate 未满足) |
| **4 连接器/模板目录** | #3879 TC-0..3 | TC-1 seed-向导(8 模板,零后端) | ✅ #3906 MERGED |

## 2. 各线 runtime 的硬保证(mutation 独立复验)

```text
BA-APPLY-1  零平台写(唯一 write 命中 = 浏览器 clipboard.writeText)· op enum 精确注册
            (add_readonly_object|add_readonly_field;注入 delete_object → 红)· identifier-gate
            sentinel(secret/host 形名不入清单 → 红)
W2-a        零外呼写【结构性】:模块内零 fetch/upsert/save/adapter 调用 + 静态源扫描 + WriteDispatchGuard
            计数器 fail-closed 再检查。独立 mutation 全 KILLED:sandbox-only 放宽(接受 production id)/
            注入真 adapter.upsert(spy+静态扫描)/ fail-closed status(放行 draft)/ evidence-builder
            派生 marker 硬编。**闸内修正**:agent 自证的"硬编 externalWriteAttempted → 红"实为
            可达状态**等价 mutation**(调用点 guard.writeAttempts>0 恒 false,因 >0 已更早 fail-closed),
            无法 kill;真正可 pin 的是 buildSuccessEvidence 忠实携带派生值 —— 已补直接单测钉死。
TC-1        零后端(diff 无 plugins/route/migration)· single-source tripwire(requiredFieldKeys 硬编 → 红)
            · seed round-trip deep-equal(seed 改错值 → 红)· values-free 扫描(真实 catalog 串内注入
            host → 红)
```

## 3. REC 的 demand-gate(为何不建 —— 已核实,非跳过)

owner 硬约束:「REC 是能力扩展非收尾必需;**只在现场有多层 BOM 展开需求才开 REC-R1;否则暂缓**」。
2026-07-08 核实:**零 open issue 涉多层 BOM 展开;REC-R0 方向锁内无现场需求记录** → demand-gate
**未满足**,R1 runtime 不建。#3877 已锁定 R1 会是什么(有界深度/循环检测/逐层预算/只读)+ 开门条件
(具名 ≥3 层用例 **且** owner opt-in)。有需求即可开。

## 4. 剩余 gated rung 台账(各需 owner opt-in)

```text
BA-APPLY-2 🔒 后端受控 config-apply 端点(只读 allowlist 白名单 + 审批 + 审计)
BA-APPLY-3 🔒 apply 后自动复探测确认
W2-b       🔒 write-token 签发(token 非写授权;兑付属 W3)
W3         🔒 sandbox 兑付   W4 🔒 生产写(customer-barred)
REC-R1     🔒 demand-gated(见 §3)  REC-R2+ 🔒
TC-2+      🔒 onboarding 引导流 / marketplace / 客户自撰模板
```

## 5. 已披露的 follow-up(非阻塞,记档)

**W2-a wiring rung**:本 slice 的 `configRecord` 是 4 键投影(id/status/version/config),真 store 行约
14 字段;byte-identity 归一化仅对合成 fixture 测过,未过真 store 的 sanitize/version-injection 往返。
**两者均 fail-closed(非静默错误)**,归 W2-b/wiring rung 的真机验证,与读线"合成 fixture 优先"同精度纪律。

**TC-1 v1 范围**:bridge 模板为 data-only seed(Bridge-Agent 区是只读可观测,v1 无 authoring draft 可
seed)——刻意的 v1 裁断,非遗漏。

## 6. 边界(全程零跨越)

生产写(W4 customer-barred)· K3 Save/Submit/Audit · delete · raw SQL · host-allowlist 放宽 ·
凭据前端化 · 递归展开 · Agent 变可写 —— 全部未触碰。BA-apply 只扩只读暴露面;W2-a 零外呼;
TC-1 零后端;REC 未开。

## 7. 文档索引

设计锁:#3876 / #3878 / #3877 / #3879 · 验证 MD:apply1-export / w2a-dryrun / tc1-template-catalog
(均 `docs/development/*-20260708.md`)。
