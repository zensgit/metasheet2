# r7 构建与升级清单(2026-08-30)

> 承接 `r6-upgrade-222-runbook.md`。**r6 的问题不是装错了,而是装早了**:r6 基线 `da1057141` 早于确认队列工作台,
> 所以后端全链能跑、客户操作员的页面却不存在。r7 的唯一目的就是补齐"人能点的那一面",并让下一次部署可自检。
> values-free。

## 一、基线

**r7 基线 = 下列全部合入后的 main**。已在 main 的四件(必须包含):

| 提交 | 内容 | 为什么进 r7 |
|---|---|---|
| `46828d5e4` | O2/R-11 操作员角色 + **确认队列工作台** | **r7 的主要理由**;r6 没有它,客户看不到确认队列 |
| `4ade0bef9` | 部署预检(7 阻塞码,每条自带修复命令) | 升级后第一件事就跑它 |
| `983724d8f` | 沙箱命名空间报错自带答案 + 执行单固定值 | 首次部署踩过:自拟 objectId 被拒且不告知正确前缀 |
| `bbc3afcbc` | 源发现探针四缺陷修复 | 接客户真库前的结构探测工具 |

待合入(合入后再打包):

- 自举脚本(一条命令从零到绿,真机验证过两条路径)
- 「BOM备料」定名 + 客户可改什么(交付说明)
- 权限拆分 `multitable:manage-schema`(**能填值 ≠ 能改结构**;开发中)

## 二、升级步骤(与 r6 的差别)

r6 是清库重建;**r7 是原地升级,不动数据**。

1. 打包 r7(基线 SHA 记入部署评论,ZIP/TGZ SHA-256 同记);
2. 停服 → 替换制品 → **跑迁移**(r6 之后若有新编号迁移则含之;无则空跑)→ 启动;
3. **立即跑预检**:`GET /api/integration/stock-preparation/preflight`,按 `blockers[].fix.run` 逐条修到 `ready: true`;
4. **跑自举脚本**验收:`node scripts/ops/stock-prep-acceptance-bootstrap.mjs`(env 见脚本头)。
   预期:干净项目 6 OK / 2 SKIP / 0 FAIL 且两条判据 PASS;带历史 hold 的项目会 SKIP 验收并说明原因——**那是待办不是故障**;
5. 推 tag `deploy-r7-YYYYMMDD`(公约规则 5)。

## 三、升级后必须人工确认的三件

1. **确认队列页面可见**:`/stock-prep` 应出现确认队列(r6 上是七个旧 MVP 页签);
2. **备料表仍在「备料」base 下**,四张表显示名与 66 处中文表头仍在(升级不动数据库,应无恙,验一眼是纪律);
3. **围栏姿态未变**:production Apply 关闭、K3 永久禁写、`INTEGRATION_CORE_B2A_REGISTRY_PATH` 与
   `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` 仍不设。预检的 posture 段会一并报出。

## 四、r7 不做的事

- 不接客户真实 PLM(仍待 T-1 授权与 O3 登记);
- 不开 production Apply;
- 不做 `/apps` 安装页(接管完成后的产品化候选,清单见 `platform-overall-design/multitable-application-model-20260830.md`)。

## 五、遗留清理项(可随 r7 一并做,非阻塞)

- 试用实例 `public` schema 下的 `dn_pdm_*` 七张合成表——接真实源前删除;
- 多余的沙箱表「备料表(废弃-待删)」(空表);
- ext 映射当前仅声明 2 列(排练用),接真实客户前须按 PLM 字典重写。
