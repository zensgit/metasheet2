# 文件证据安全 / 存储完整性线 — 硬化池收官（CLOSED）— 2026-07-11

> **Status: CLOSED**（owner ratify 2026-07-11，基于 `origin/main@320d37f66` 独立复核，APPROVE 0 P1 / 0 P2）。
> 本文收口的是 **2026-07-10 owner 审阅 REOPEN 的硬化池中「文件证据安全 / 存储完整性」余量**——即
> `attendance-hardening-wave2-verification-20260710.md` §C 与 `attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
> §2 记为「F1/F2 落地并复审通过前保持 OPEN」的那部分。该前置条件已满足并经 owner 复核通过 → 本池 CLOSED。
>
> **范围界定（勿过度声张）**：本收官**仅**关闭文件证据 / 存储完整性硬化池。**更广的考勤线有其独立待办**
> （owner 门与命名前置、DingTalk backlog 池等车道另行跟踪）——**本文不对更广考勤路线作任何收口声明**，不在覆盖内。

## 1. 收官依据 = owner 复核轨迹（如实，不留假象）

| 日期 | owner 结论 | 触发的修复 |
|---|---|---|
| 2026-07-10 | CHANGES-REQUESTED，0 P1 / **3 P2**（multitable sibling 漂移删 / files fallback-key 未回写 / poison 饿死 F5 队列）+ 2 P3 | **F9**（#4094） |
| 2026-07-11（一次） | CHANGES-REQUESTED，**新 P1**（sweep 默认删除器裸 `path.join` 绕过 F3 containment，`../victim.txt` 删 root 外文件；owner 亲手 repro `purged=1, victimExists=false`）；同时**接受**原三项 P2 已修、撤回旧结论 | **F10**（#4122） |
| 2026-07-11（复核） | **APPROVE，0 P1 / 0 P2**。`origin/main@320d37f66` 独立复核：两默认删除器均在 unlink 前过 `resolveWithinBase`；重跑原攻击路径 → 补偿 sweep `inspected=1,purged=0,skipped=1`、草稿 cleanup `inspected=1,deleted=0,skipped=1`，两 root 外 victim 均保留；default-deleter real-DB/real-fs 测 4/4；sibling 扫描无第二条绕过 containment 的 unlink | — |

## 2. 已交付（全 on main）

| 刀 | 内容 | PR → main sha |
|---|---|---|
| F1+F2 | files 四端点资源级 ACL + tombstone-first 删除 + 存储补偿 | #4055 |
| F3 | storage-key DB 权威直读（消路径穿越 / 重启漂移 / admin 绕 tombstone）+ POISON 碰撞策略 | #4063 `7d4cb8027` |
| F5 | blob 补偿删除 + delete 路径根因修（`deleteByKey`） | #4072 `0012422fe` |
| F6 | 存储层 S3 死码删 + doc 清理 | #4076 `a9ceef97e` |
| F9 | owner 3 P2 修（sibling 漂移删 / fallback 回写 / poison SQL 排除） | #4094 `66f9edae5` |
| F8 | vestigial 接口 / plugin 契约清理（listFiles + setStorage/getStorage） | #4103 `befcbebaf` |
| **F10** | **P1 root-escape 修：两默认删除器过 `resolveWithinBase`** | #4122 `af822d1d7` |
| 设计 / 验证 MD | 逐刀 + owner-复审章 + §F8 + §F10 + 四教训 | #4077 / #4095 / #4108 / #4123 |

**迁移 on main（3 个）**：`zzzz20260710140000_add_files_storage_key`（F3）· `zzzz20260710150000_add_files_blob_purged_at`（F5）·
`zzzz20260711090000_add_multitable_attachments_blob_purged_at`（F9）。**部署 SOP：先迁移后代码 + auth round-trip 验证。**

## 3. 四条教训（进本线永久记录）

1. **opus「0 P1/P2」在本线四次不足以预测 owner 验收**（F1/F2→F3、F5→3 P2、F9→P1）。opus-clean 是闸不是判决；owner 复核是判决。
2. **「已在别处修」≠「这条平行路径也修了」**——sibling delete 路径必须一起修，否则半修 = P2（F9 P2-1）。
3. **注入安全实现的测试会掩盖生产默认路径的漏洞**——F9 的 real-DB 测注入已过 containment 的 `StorageServiceImpl`，
   使 opus + 自查都走过裸 `path.join` 的默认删除器（F10 P1）。安全修的测试必须跑**生产实际会走的分支**（此处 = 不注入 storage 的默认删除器）。
4. **既有平台缺口挂 OUT 的前提是边界未动**——敏感照片证据接入后，files ACL 缺口即失效（F1 由 OUT 转 P1）。

## 4. 明确未交付 / 非本池范围（owner 点名，勿冒称已交付）

- **F4 审批人 approval-scoped 照片读授权 = 未授权后续**。它开 owner-or-admin 之外的**第三条读授权路径 = 权限层扩张**，
  红线只由 owner **逐刀显式授权**解除；且**当前无真实审批 UI 消费方**（apps/web 零 `photoFileId` 渲染），
  owner 决定**不为潜在需求提前扩大权限面**。设计已锁（`f4-design-lock`，机制 A），**实现仍 gated，未交付**。
- **retention env 生产启用 = operator 动作，未交付**。`FILES_ORPHAN_BLOB_RETENTION_ENABLED` /
  `MULTITABLE_ATTACHMENT_BLOB_RETENTION_ENABLED` 默认 **OFF**；它们只兜「同步删除真失败」的残留尾，**主修（同步
  `deleteByKey` + 交互同步 stamp）always-on、不依赖该 env**。是否启用是**部署方的运维决定**，本池**不代为启用、不冒称已交付**。
- **F7 深度图片校验** = owner 已接受 lazy-forgery 为 **P3**，默认不做。
- **N1**（`isDatabaseSchemaError` 未认 42703）= **不修**：cosmetic 日志文案、默认配置零暴露；「清爽修法」把 42703 加进
  共享 util 是净负（会静默吞其它模块的真列名 typo）——默认-ON 草稿 sweep 的 UPDATE 42703 报文含「of relation…does not exist」
  已被现有 message-fallback 兜住，仅 env-gated（默认 OFF）补偿 sweep 的裸 SELECT 落通用 warn 分支，两者均 benign 自愈。

## 5. 结论

文件证据 / 存储完整性硬化池 **CLOSED**。F1/F2/F3/F5/F6/F8/F9/F10 全 on main，owner 2026-07-11 复核 APPROVE 0 P1/0 P2。
tracker（§C / benchmark §2）由本文收口。**第 4 节所列均为未交付后续 / 运维动作，不计入本池交付。**
