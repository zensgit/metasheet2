# 目录身份面板：必需前端 CI 登记修复

## 问题与改动

基线 main `214c83806f35ab9969bdf4631ede97877fa6a468` 的目录页面 95 项测试已在 CI 通过，
但独立的 `DirectoryIntegrationIdentityPanel.spec.ts` 未被前端清单选中。
其 4 项测试只有本地证据，不能用页面测试或旧 head 的 CI 绿灯代替。

在 `apps/web/scripts/run-required-web-tests.sh` 的唯一最终 exec 块，按现有排序加入完整文件名过滤器，
并用 `node scripts/ops/required-web-lane-token-manifest.mjs --write` 同步生成 `.tokens` 登记。
过滤器只匹配该面板文件。原有 626 个 token 全部保留，变为 627 个；20 个测试调用保持原样。
沿用现有结构及登记守卫，无需新增测试框架、修改工作流、并行拓扑或 13 项必需检查。

## 本地验证

Node 20.20.2，隔离工作树，合成数据；没有启动 Mac mini 任务。

| 验证 | 结果 |
| --- | --- |
| 面板、目录页面、前端清单结构守卫 | 3 文件 / 104 项通过，0 失败、0 跳过 |
| 后端登记结构及 token 清单守卫 | 2 文件 / 63 项通过，0 失败、0 跳过 |
| token 差异及匹配范围 | 只新增面板文件过滤器；删除 0；只匹配目标文件 |
| 移除登记的反向验证 | 保留 manifest、临时移除新增执行条目；现有守卫按预期失败 1 项，错误明确指出面板文件 |
| 反向验证后恢复 | 脚本逐字节恢复，manifest 检查通过 |
| Shell 语法及补丁格式 | `bash -n`、`git diff --check` 通过 |

面板 4 项覆盖：挂载不写入及仅保存名称、独立归属信息和显式确认、凭据未保存时阻止确认、409 冲突不自动重试。

可复现命令（从对应 workspace 运行，Node 20）：

```sh
# apps/web
node node_modules/vitest/vitest.mjs run tests/DirectoryIntegrationIdentityPanel.spec.ts tests/directoryManagementView.spec.ts tests/run-required-web-tests-shape.spec.ts
# packages/core-backend
node node_modules/vitest/vitest.mjs run tests/unit/required-web-lane-registration-shape.test.ts tests/unit/required-web-lane-token-manifest-guard.test.ts
# 仓库根目录
node scripts/ops/required-web-lane-token-manifest.mjs
bash -n apps/web/scripts/run-required-web-tests.sh
git diff --check
```

## CI 验收与交付边界

以新 Draft PR 的固定 head 结果为准：13 项必需检查全部成功，并在实际 `web-tests` 日志确认面板 4 项被执行且成功。
不以本地通过冒充 CI 通过，不取消或重跑此前 main 的运行。
本地详细回执位于 `artifacts/directory-identity-required-ci/`；最终 CI 证据追加到 PR 描述和本地验证 MD，
不为记录 CI 结果反复推送新提交。

本补丁只补齐持续回归覆盖，不改变产品行为、账号关联或同步状态。回退只需撤销这两条清单登记，
但会重新造成覆盖缺口。合并、部署、线上配置修改、停用和启用同步仍需另行批准。
