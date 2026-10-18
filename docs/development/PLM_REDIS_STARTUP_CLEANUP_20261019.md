# Redis 首次连接失败的进程清理

本片源码 `8d9a71ed164a5d17ae0b7595ef3cae4c436eb7d3`，基线 `519184d6414c0eededb9fde1b55fe211d7ce8e54`。状态：真实进程反例、29 项必要控制和后端类型检查通过；Draft 文档 head CI 待核对，完整服务包及 Discussion 写通道尚未验收。

## 问题与修复

`getRedisClient` 在首次连接失败后返回 null，并按既有策略记住失败；但局部 ioredis 实例没有 disconnect，也没有赋给全局 client。随后 `closeRedisClient` 无法关闭它，后台重连句柄使短进程无法退出。

独立 Node 子进程将 REDIS_URL 指向新建自有临时目录中不存在的 Unix socket。原代码实际打印“closed-without-fallback”，仍持续重连，3 秒后被测试期限终止；这是真实 ioredis 连接反例，不是 mock 或代码字符串断言。原始日志 `/tmp/plm-redis-startup-original-red.log`。

最小修复保留失败尝试的局部引用，并在 catch 中 disconnect。当前进程的失败记忆、null 返回、已有错误处理及禁止内存 fallback 均不改变；成功连接的共享客户端和正常 close 流程不改变。

## 验证

Node 20.20.2，现有锁定依赖，无系统 Redis 安装。

```sh
# packages/core-backend
node node_modules/vitest/vitest.mjs run tests/unit/plm-managed-companion-refute.test.ts tests/unit/plm-managed-adapter-refute.test.ts tests/unit/plm-managed-companion.test.ts tests/unit/redis-startup-cleanup.test.ts tests/unit/embed-jti-store.test.ts --reporter=json --outputFile=PRIVATE_REPORT
node node_modules/typescript/bin/tsc --noEmit
```

实际 29 passed，0 failed、0 pending；既有 assert-report 对精确 29 项通过。新增子进程反例验证连续两次获取均为 null、close 后自然退出。类型检查退出 0，actionlint、git diff --check 通过。managed-companion CI 增加此反例及原有六项 JTI 引擎控制，精确数量从 22 增至 29；零失败、错误和跳过门槛保持。

## 真实 Redis 恢复交叉验证

Yuantus 配套验证器源码 `821d170d18bf42969951a3754611c4eff34ef670` 使用本片实际客户端文件及未改动的生产 consumeEmbedJti/embedJtiKey，启动自有 Unix-socket Redis 7.4.10，无 TCP、Docker、系统服务或客户数据。

五个独立 Node 进程实测：首次 JTI 可用、另一进程重放拒绝、Redis 停机时拒绝、AOF 备份恢复到新目录后原 JTI 仍拒绝、恢复后新 JTI 可用。原目录改名不可用且文件摘要不变，测试服务停止及自有目录清理均通过。原客户端在停机拒绝后还持续占用进程，修复后完整恢复验证 passed=true、cleanup=true；私有结果 `/tmp/plm-redis-recovery-fourth.json`。

测试驱动最初使用 ESM/CJS 混合加载，造成两份客户端实例，前两次首个正例因句柄未关闭而超时；改为一致的 require 加载后才复现上述独立的产品故障（第三次）。这些驱动失败和原始日志保留，不能与产品漏洞混淆。

此证据不等于完整 Discussion 写入、所有应用任务恢复、整包安装、Linux 容器镜像或原生/Meta 数据库耦合恢复完成。不改历史 HOLD、开关或生产状态。源提交与本次一次收尾文档提交分开；保持 Draft、不合并。
