# 既有 #6337 收口验证

## 2026-10-14 新 CI 失败与最小本地修复

run `38422348395` 绑定 head `f77208bfcfa42cca86d1fde3606229aecd1985ba`，终态 failure。core 测试 1 文件失败 / 1183 文件通过 / 172 文件 skipped；3 测试失败 / 22940 通过 / 1752 skipped。失败均来自 `attendance-w6-group-effective-policy-authorization.test.ts` 对构造器 SAFE 清单的登记断言。后续 PLM 完整应用、外部系统真实库和宜搭 owner/browser 均 skipped，不得回填为成功，也不是这轮已重现 Chromium 故障。

最小修复仅该测试文件：新增三条精确 occurrence key、count=68、固定 hash `d4f6c884e8417a75c8ce7ed410c5a9ba5ca308d0b3717e181f94dba92cec04cc`，并新增三个负例。分类器、生产代码、权限与验收判定不变。修后测试文件 LF SHA-256：`d28af00e471c4191026704f374deff20b63dd3a775264ed0750f4f5327ea0202`。

在准确已发布 index（SHA-256 `51195cab0d27b5fb4a6352428f0945d1d5bd85f838be7c043b4871b8a9362fa2`）及既有隔离 Linux 副本上，使用真实 Vitest 运行 attendance 装配、approval shutdown、recovery wiring 三整文件，单 worker、无过滤、无 skip/todo：

| 运行 | 结果 | stdout SHA-256 |
| --- | --- | --- |
| 修前 | 133/136，三失败与 CI 一致，exit1 | `a83dc6889be8a7330e865e80c7cc1967cc6e150b83b3a25206aba3ac799fa4a9` |
| 修后 | 139/139，exit0 | `44edb596154a8fce59377bae1114aa523fce73d533fbc8b744d269e7e219d78c` |
| 删除一条 socket 登记的变异体 | 135/139，四失败且 UNKNOWN-empty 直接失败，exit1 | `2db8ed235616bd9a9cedcb4a78b60602d338d3be42a40685dbfeffb3f49d1bd5` |

三次执行均无 signal，原 Linux 测试文件已按原字节恢复。新增访问/重复访问变异负例均随整文件通过。此结果只关闭本地登记缺口，不证明全部 core suite 或完整后台/浏览器已通过；此前后台启动失败、超时与 Chromium 阻断继续保留。owner 随后明确授权本次修复及 MD 更新推入原草稿并运行既有合成 CI；提交前再次核对测试文件实际 LF 字节与上述哈希一致，CI 结果以新 head 对应的 GitHub run 为准，不预记全绿。

更新：2026-10-13。父提交：`8b75e155a41e4f8ea4e892e4c87d7f9572b8a5b8`。

## 准确候选

| 文件 | SHA-256（实际 LF bytes） |
| --- | --- |
| `packages/core-backend/scripts/run-stock-preparation-yida-synthetic-trial.mts` | `14fa8e64a4ddac1257d20745158e3210984ee0927e63f445c5ee674fccc7061a` |
| `scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs` | `537729b1cfd5b78f84000876153b3085e2c722d7178733d5fefb62949176754e` |
| `packages/core-backend/src/index.ts` | `51195cab0d27b5fb4a6352428f0945d1d5bd85f838be7c043b4871b8a9362fa2` |
| `packages/core-backend/tests/unit/approval-completion-shutdown-lifecycle.test.ts` | `e328cbc6a70687b028df198c07297eeadef4a16288b26f1bc0e9ddd7a0c44341` |

之前准入的 13,758 个源码项已逐项与远端 Git blob 比对；原清单与远端差异恰好为已发布的两份诊断文件。新 Linux 副本基于该清单、两份已发布文件和上表四份补丁构建，不读取或复制 .env，不复用旧诊断目录。没有改动四文件以外的运行时代码。原 Windows 工作区和历史 Linux 证据保留。

## 准确发布候选重验

发布前已把 index 的 CRLF 工作副本规范为 LF，随后在新副本重验实际发布字节，不采用“哈希前归一化”方式放行。独立只读复核确认相对父提交仅 12 行 socket 逻辑，`release(error)` 保持远端版本；其他三文件仍为预期变更，无新增权限扩大。

- shutdown/recovery 两个整文件：23/23，failed/pending/todo 均 0，exit0。原测试 stdout SHA-256：`54f929a2c9427f1406cedcad3b79ea84cc60ff20944846bb551943611fabc1d3`。
- 后台验证首次在启动自有 PG 时返回固定 `PLM_FULL_APP_PG_START_FAILED`，尚未执行测试（result=null），不能记成 58 个测试失败或成功。失败日志仅核对固定标签和 SHA-256 `5af7679f3bbbef6f0d4609954a380cf6caa51ad75871ebc31a5596540540ed91`；随后只读确认该候选没有残留 pg-* 目录。不修改代码、配置或超时，单独重跑结果见下。

- 后台单独重跑：外层 240 秒超时，code=null / signal=SIGTERM，没有完整测试报告，不能宣称 58/58。stdout SHA-256 `624cb028d4bc128f007f53852a8a0e2a31c9d71fac1b144732d25796b8798b64`。该失败保留；网络/PID 命名空间退出，未手工删除保留的诊断/数据库目录，清理未证为成功。不把没有报告理解为产品断言通过或已定位根因。
- 试用契约：`node --test scripts/ops/run-stock-preparation-yida-synthetic-trial.test.mjs`，11/11，exit0；stdout SHA-256 `89962f3f60cd910cc06e2c971376069196407658e68502f4390e099a61bd103b`。
- 完整 provenance：`node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`，exit0；stdout SHA-256 `f100c276587a34f70f4ea13506812da8b9ad5788bdb3ca0c655dc4f92f088a04`。未重打 pin、未改被 pin 的文件。

当前判断：可按 owner 明确授权推入原草稿并运行既有 CI，用于进一步验证；不是全绿、可合并或可发布裁决。新候选后台完整结果与清理证据仍阻断；不能用只差换行的前一轮成功代替本次失败。

## 历史本地证据（不等同于本次提交验收）

此前本地 index SHA 为 `601da1634a84eee10a1177772827ca5c24cf92fd47dde321d54a3e5d1c5336ab`，含本次已排除的连接释放差异。该旧候选记录：shutdown/recovery 23/23、后台三整文件 58/58、试用契约 11/11；原 CLI 完整后台链路及带预连接链路都 READY→STOPPED→exit0，清理自有 PG 和私有交接文件，源码后验通过。这些结果不冒充新候选的完整 CLI 结果。

真实 socket 测试在原未修实现为 9/10，修复为 10/10；去掉预连接清理的变异体为 9/10，错误清理活动请求的变异体为 9/10，各命中对应测试。测试没有依赖新增字段来制造基线失败。此前独立只读复核无 blocker，但旧候选完整预连接运行未记录关闭时点与最终 bytesRead，因此不能单凭该回执归因历史 Windows 超时；部分请求头专用用例也不是已完成证据。

## CI 与仍保留的阻断

旧 head 的正式 run `38349690929` 失败于 Chromium 完整应用 Automation 请求 ABORTED，后续 owner-browser 步骤 skipped。此前独立 owner 原步骤本地 61 契约/70 测试通过及 Firefox manual/interval 各九阶段通过，均不回填远端 skipped，也不解除 Chromium 发布阻断。

owner 已授权本次推送与既有合成 CI；结果须绑定新 head，并在 GitHub 上核实，不能预记成功。未新增 workflow、没有跳过失败、没有调整浏览器验收阈值。

## 权限与证据边界

仅合成数据、临时自有数据库、独立网络命名空间；无客户读取、真实宜搭发送、合并或部署。Chrome/Firefox 桌面自动操作曾因工具无法执行 URL 策略校验而停止，未通过其他渠道绕过；后台证明不是页面验收。公开材料只保留代码路径、固定状态和哈希，不上传私有日志、账号交接材料或凭据。
