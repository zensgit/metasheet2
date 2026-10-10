# 多维表范围填充：镜像构建与 staging 验收准备

日期：2026-10-09（Asia/Taipei）。关联 PR #6271，分支 `codex/multitable-range-fill-20261008`。本轮补齐[扩展设计锁](multitable-range-fill-editable-fields-design-lock-20261009.md)的 E7 构建交付门，不改变 21 种字段的复制规则。

## 修复内容

此前 `Dockerfile.frontend` 没有声明范围填充的构建参数，`build-dingtalk-staging-images.sh` 也不转发该开关。仅在宿主机或运行中的容器设置环境变量不能开启已经编译的 Vite 页面。

- 前端 builder 阶段声明 `VITE_MULTITABLE_RANGE_FILL_ENABLED=false` 并传入构建环境；运行阶段不新增开关。
- staging 镜像构建器只接受字面值 `true` / `false`；未设置默认关闭，显式空串、空白、大小写变体和 `1` 均拒绝。
- `true` 要求 `STAGING_DEPLOY_SCOPE=full`，只传给前端镜像；默认后端范围不能静默忽略该请求。
- 默认及 `false` 保留原构建参数和 provenance 结构。所有拒绝发生在 Docker 命令之前，错误不回显输入值。
- 沿用已登记的开关，不新增开关、不修改共享 runner 配置、不发布镜像或部署。

本轮把 main `52aae89fc77707f5c1fb4718c87b82868af5d5bc` 合入功能分支，合并提交 `5bbe9c939b99400f3e8fc471d470ee1ae4e60cd1`。required-web 脚本及 token 清单保留双方所有规格引用。这是同步功能分支，不是把 PR 合入 main。

## 验证

| 门 | 证据 | 结论 |
| --- | --- | --- |
| E7 构建开关 | 两个完整 ops 文件 60 项，含 10 项新增；默认/false 的两种范围精确参数与 provenance，true 前端单次传递，非法值及错误范围拒绝 | 通过，无跳过 |
| 邻接守卫 | worker-drain CI 接线 2 项、开关登记 40 项 | 通过，无跳过 |
| 功能回归 | planner 153、writer 109、interaction 54、flag 9 | 325/325 通过 |
| 实际 Vite 编译 | 编译真实开关模块后执行导出函数；unset/false/true/TRUE 分别得到 false/false/true/false | 4 组观察通过 |
| 变异负例 | 副本中去掉前端参数传递、把显式空串当作默认值，各自令匹配测试失败；恢复原脚本后通过 | 通过，交付源码未被变异 |
| 独立审阅 | Luna 6 补规格；主任务强化双范围默认关闭断言、执行全部验证；Sol 6.1 独立复核并运行 60 项 | 无剩余可执行问题 |

本轮本地 **427 项唯一测试通过**，另有 4 组实际编译观察；不把重复审阅、变异复跑或上一轮 737 项累加。脚本语法与 `git diff --check` 通过。前一提交 `e5bb8d949a` 的 55 成功 / 1 条件跳过仅属历史证据，本轮新 head 的 CI 以 PR 最新记录和最终回执为准。

本机 Docker daemon 不可用，未执行真实容器镜像构建。ops 测试使用 Docker/Git/HTTP 桩；Vite 观察使用真实构建器及真实开关模块，但不是完整镜像或部署环境浏览器验收。既有 staging 域名本轮无法解析，同轮 GitHub DNS 正向对照成功；未据此声称远端服务停机，未绕过 DNS 使用猜测的地址。

日志及结构化观察保存在忽略目录 `artifacts/range-fill-editable/`：`build-followup-ops.log`、`build-followup-feature.log`、`build-flag-vite-probe.json`、`build-mutations.json`、`build-followup-test-union.json`。

```sh
node --test scripts/ops/dingtalk-staging-deploy-identity.test.mjs scripts/ops/deploy-immutable-traceability-contract.test.mjs scripts/ops/dingtalk-worker-drain-ci-wiring.test.mjs scripts/ops/global-history-flag-manifest.test.mjs
cd apps/web
node node_modules/vitest/vitest.mjs run tests/multitable-range-fill-planner.spec.ts tests/multitable-range-fill-flag.spec.ts tests/multitable-range-fill-writer.spec.ts tests/multitable-range-fill-interaction.spec.ts --maxWorkers=1 --minWorkers=1 --reporter=dot
```

## 待授权的目标验收步骤

以下是准备好的执行步骤，本轮未执行部署。先恢复或确认 staging 入口，核对目标是否为现有托管 Compose 栈；不匹配时不能直接套用部署脚本。记录当前 backend/web 的精确 commit、image ID、前端开关状态、托管 env 与 provenance 的备份位置，并确认其回滚镜像仍在。备份和证据不公开环境文件、凭据或真实业务数据。

在有 Docker 和充足空间的构建机上，从干净的、已核验 CI 的候选提交构建，不使用其他窗口的 checkout：

```sh
RANGE_FILL_CANDIDATE="$(git rev-parse HEAD)"
mkdir -p artifacts/range-fill-release
SOURCE_DIR="$PWD" IMAGE_TAG="$RANGE_FILL_CANDIDATE" \
  IMAGE_PROVENANCE_FILE="$PWD/artifacts/range-fill-release/image-provenance.json" \
  STAGING_DEPLOY_SCOPE=full VITE_MULTITABLE_RANGE_FILL_ENABLED=true \
  bash scripts/ops/build-dingtalk-staging-images.sh
```

此构建器不推送镜像。若在目标机使用本地镜像，部署必须使用 `SKIP_PULL=1`，避免拉取同 SHA 但构建开关不同的镜像。若跨机传输，先核对两端 image ID；镜像发布仍需单独授权。托管 full 范围会更新 backend 和 web，必须协调现有 staging 窗口。

获得明确部署及仅 staging 启用授权、目标/备份/镜像核验完成后，才在托管目标运行：

```sh
DEPLOY_IMAGE_TAG="$RANGE_FILL_CANDIDATE" DEPLOY_EXPECTED_COMMIT="$RANGE_FILL_CANDIDATE" \
  DEPLOY_IMAGE_PROVENANCE_FILE="$PWD/artifacts/range-fill-release/image-provenance.json" \
  STAGING_DEPLOY_SCOPE=full SKIP_PULL=1 \
  bash scripts/ops/deploy-dingtalk-staging.sh
```

该脚本既有 provenance/健康核验主要针对 backend；本次验收还必须独立核对 web 容器 image ID 与 provenance 的 `webImageId`，并核对实际页面 `build-info.json` 的 commit。相同 SHA 不能替代前端构建开关与 image ID 核对。

使用一次性合成表与已授权测试账户，完成多选、单/多人员、结构化字段的拖动和剪贴板复制，刷新后复核持久化；验证数字序列、输入变化后的公式重算及关联变化后的汇总重算。检查只读目标不可覆盖、过期版本拒绝及无部分写入。页面显示成功不能替代刷新读回和服务端状态核对。

验收失败时按已记录的旧 commit/provenance/image ID 恢复 backend/web，保留原数据卷，不执行 `down -v`；重新核对健康、页面 commit 与此前开关状态。关闭运行时环境变量不能回滚编译期开关，必须恢复旧前端镜像。最终回执分别记录部署成功与业务验收结果。
