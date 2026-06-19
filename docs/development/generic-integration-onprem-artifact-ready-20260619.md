# 通用对接 on-prem 包 — artifact ready, **entity-machine smoke PENDING**(2026-06-19)

> 状态:**artifact ready(可复现构建 + 本地/CI smoke 通过)**;**实体机 smoke 未做(PENDING)**。
> 本文**不**声称已实体机验证。本地 smoke 只证明"代码与包结构未坏",**不**替代实体机真实部署验证。
> 首笔真实外部写 = 始终独立 owner gate(与本包无关)。

## 0. 一句话

可发包,但标"待实体机验证":on-prem 包记录包含**通用对接收敛(S1a/S1b/S4/S3 全弧)**;release/issue 明确 **artifact ready,entity-machine smoke pending**。不阻塞交付物准备,也不冒充已验证。

## 1. Candidate

- 源:`origin/main`(merge-fact basis;tip 随并行窗口滚动,以下列合并 SHA 为准,不以"当前 tip"为准)。
- 包含的通用对接收口(均已合并并各自 adversarial-reviewed + 经验非空洞):
  - S1a values-free 加固 #2882 + S1a-retire #2894(C6 安全写泛化为 target write profile + raw write-source)
  - S1b-1/2/3 #2887/#2892/#2898(multitable 骑 C6,sandbox 零外部写)
  - S4 #2903(adapter 自描述元数据)
  - S3 全弧 #2919/#2926/#2937/#2944(模板对象:合同/存储 + 版本语义 + 单事务 bind 实例化 + 参考模板目录)
- 包标签:`s1-s3-s4-artifact-ready-<commit-short>`(`PACKAGE_TAG`);包指纹见 `BUILD_PROVENANCE.json`(`gitCommit`)。

## 2. 复现构建(本地,无 infra/签名)

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
PACKAGE_TAG="s1-s3-s4-artifact-ready-$(git rev-parse --short HEAD)" \
  scripts/ops/multitable-onprem-package-build.sh
# 产物:output/releases/multitable-onprem/<name>.tgz/.zip/.sha256 + SHA256SUMS + <name>.json + BUILD_PROVENANCE.json
scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/<name>.tgz
```

或经 CI:`.github/workflows/multitable-onprem-package-build.yml`(`workflow_dispatch`;inputs `package_tag` / `publish_release` / `release_tag`)。包含 plugin-integration-core + plugin-attendance。

## 3. 验证状态

| 维度 | 状态 | 证据 |
|---|---|---|
| **本地/CI smoke**(代码+结构未坏) | ✅ PASS | plugin-integration-core 全链 45 文件 `pnpm test` EXIT=0(见 §4) |
| 包构建(本地) | ✅ PASS | `metasheet-multitable-onprem-v2.5.0-s1-s3-s4-artifact-ready-e88899394`;`BUILD_PROVENANCE.gitCommit=e8889939459a…`,`sourceIsOnOriginMain=true`;tgz sha256 `a0bfa5b4…`、zip sha256 `368d58a7…`(SHA256SUMS 全档)。产物 gitignored(`output/releases/`),本文只留记录 |
| 包结构 verify(静态 smoke) | ✅ PASS | `multitable-onprem-package-verify.sh`:Checksum PASS / Required content PASS(121 paths)/ Deployability contract PASS(deployable-onprem-app-package, nodeModulesBundled=false)/ No-GitHub-links PASS |
| **实体机 smoke** | 🔒 **PENDING(blocked — 实体机不可用)** | operator 执行;**本轮未做** |

## 4. 本地/CI smoke 覆盖(证明什么)

`pnpm test`(plugin-integration-core,EXIT=0)覆盖你列的每一项:
- **S3 reference templates route 可返回** — `reference-integration-templates` + http-routes `GET /templates/references`(read-gated、values-free、multitable-first)。
- **template CRUD 正常** — `integration-templates`(normalizer + upsert/get/list/delete + 版本语义 auto-bump/optimistic-409)。
- **instantiate 创建 pipeline + mappings** — `integration-templates` S3-2(单事务 bind→pipeline+mappings)。
- **provenance snapshot 正确** — snapshot 测试读真实存储行,改模板→live pipeline 物化 mappings + `provenance.templateVersion` 不回溯(经验非空洞)。
- **no external write / no K3 route opened** — `external-write-dry-run` OK;K3 Submit/Audit/BOM 路由未开(http-routes);instantiate 不触发 run/外部写。
- **SQL/data-source 既有测试不回归** — `data-source-sql-readonly-source-adapter` / `data-source-sql-write-gated-target-adapter` / `pipelines` / `pipeline-runner` 全绿。

**本地 smoke 的边界(诚实)**:它证明代码与包结构未坏(单测 + in-memory fake-db + 包 verify 的结构检查);**不**证明真实部署(真实 PG migration 061 应用、健康检查、真实 dry-run→apply→re-pull 幂等、人工字段保留)。后者 = 实体机 smoke,**仍 PENDING**。

## 5. Blockers / 红线(继承)

- **实体机 smoke = PENDING**(实体机不可用)→ 本包**不可标"已验证"**;只标 artifact ready。
- **K3 Submit/Audit/BOM 红线不开**;K3 runtime 写 = S2(opt-in + 实体机),本包不含其 runtime 开通。
- **首笔真实生产外部写 = 独立 owner 授权**,与本包无关。

## 6. Issue / release 回复(建议措辞)

> 通用对接收敛(S1a/S1b/S4/S3 全弧)on-prem **artifact ready**:包可复现构建、本地/CI smoke 全绿(代码+结构未坏)。**实体机 smoke 仍 blocked(实体机本轮不可用)**——未做真实部署验证,故**不标"已验证"**。实体机就绪后跑 §4 的部署 smoke(fresh migration 061 / health / sandbox dry-run→apply / re-pull 幂等)再签收。
