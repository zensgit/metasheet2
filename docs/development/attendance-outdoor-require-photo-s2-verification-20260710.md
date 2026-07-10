# 考勤外勤打卡照片证据契约 + requirePhoto 强制（S2）验证报告 — 2026-07-10

> 余下开发总目标池（#3925 计划）之 **S2**。PR **#4016** MERGED `0e118283b`。
> design-lock：`attendance-outdoor-require-photo-s2-design-lock-20260710.md`（含可达性诚实声明 + 三条基底修正 AMENDMENT）。

## 1. 三条 core 基底修正（本刀最大发现，全部实证而非静态推导）

1. **files 表 = 僵尸表**：migration 035 建表后全库零读零写；`POST /api/files/upload` 只写内存索引且零调用方。
   → 上传成功路径补 `INSERT INTO files`（失败→清理已存文件+5xx，禁「成功但无行」）。
2. **userId 解析异类**：files.ts 是全仓唯一漏 `.id` 的解析点（永远 'anonymous'）→ 家族对齐
   `req.user?.id ?? req.user?.userId ?? req.user?.sub`（与既有 ~15 处 call site 同型）。
3. **035 superseded-without-successor**：被一揽子 skip 且无现代继任 → 新鲜迁移库无表。
   → 桥接 migration `zzzz20260710120000_create_files.ts`（老库 byte-exact no-op，sentinel 行实证）。
   此发现触发全仓同类审计（`superseded-legacy-migrations-gap-audit-20260710.md`——其余缺口全为僵尸，无立即高危）。

## 2. 契约与强制

punchSchema 加 `photoFileId`；三重校验（存在 / owner=打卡人 / image/*）→ 422 `OUTDOOR_PHOTO_INVALID`；
强制点精确镜像 requireNote 嵌套在 requireApproval 块内（`OUTDOOR_PHOTO_REQUIRED`）；通过的 photoFileId 落
`draft.metadata.outdoorPunch` 供审批人查证；zod 开门 + :21789 latent 注释更新；admin outdoorForm 开关。
**hero punch / punchOutcome.ts 逐字节未动**（git diff 空）——可达性诚实声明成立：web 端 outdoor 分支不可达
是既有状态（requireApproval/requireNote 同样），改可达性 = owner deferred 的 T2 §3.1，本刀红线不碰。
本刀交付的是：任何会发 location/outdoor-marker 的客户端（集成测试、未来钉钉容器外勤流、ext API）从此有完整
照片证据契约可满足。

## 3. 对抗审阅（opus，refute-first）

审阅 MD：`/tmp/pr4016-s2-review-claude-20260710.md`（head `1b04abe48`）。判定 **APPROVE-with-hardening：0 P1 · 0 P2**。

- 关键证伪：上传端点有 authenticate（files.ts:40，100MB 限制既有未变）；SQL 双侧参数化；集成测试走**真
  multipart 上传路由**非 scaffold 行（拆 INSERT → E2E 红 = 真写入器承重，无 wire-vs-fixture 漂移）；
  byte-parity 用 9 键 `Object.keys().sort() toEqual` 钉死 + 审阅者自加反刀转红；老库 no-op 列/索引逐项一致；
  delete handler userId 为 log-only 行为中性；与 S3 #4008 语义不相交。
- mutation 五刀（①强制行 ②ownership ③image/* ④upload INSERT ⑤userId 复原缺陷）全红后还原。
- 实跑：新鲜库集成 26/26 + 邻居 18/18 + FE 116/116 + 双 typecheck 绿。
- **P3 硬化项入池**：P3-1 content-type 客户端自报（无危险二次消费面：无图像库消费 photoFileId、下载
  `Content-Disposition: attachment` 从不 inline 渲染、证据仅人审）→ magic-byte 嗅探；P3-2 `DELETE /api/files/:id`
  删存储对象不删行 → 孤儿行累积 + punch 可引用悬挂证据 → delete 一并删行或审批面容错。

## 4. 过程记录（模型接力 + 三次设计裁决）

Sonnet 首刀实现 G1/G3-G6 途中**逐级上报**三个基底缺陷（而非自行裁量）→ 主循环三次裁决（方案 A 接线 /
两处 core fix + 护栏 / 测试升级含第四、五刀 mutation）→ 额度墙 → Opus 接棒（并修正前任 photoFileId
无条件写入的 byte-parity 缺陷）。「设计基底缺陷上报而非自解」纪律在本刀发挥了决定性作用——照原锁写会掉进
mock-is-not-the-contract 陷阱（测试直插行才能绿，真实上传永远 422）。

## 5. 账本归属

tracker 打卡策略行：`punchPolicy.outdoor` 四键（requireApproval/requireNote/approvalFlowId/**requirePhoto ✅本刀**）
全部 wire-settable + server 强制。剩余相关：外勤打卡客户端可达性 = T2 §3.1 owner deferred；钉钉容器拍照
JSAPI = E 线增量；审批详情照片预览 = 后续小刀。
