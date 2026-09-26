# R59 上机记录 + 双机协同交接（2026-09-24）

> values-free：本文不含主机地址、口令、令牌；只指位置。演示服务器下文统称「演示机」，其地址在运维机的 ssh 配置里。

## 1. 当前状态（2026-09-24 13:06 本地）

| 项 | 值 |
|---|---|
| 演示机运行版本 | **r59** = main `05461c7399d9fcc2f0e9c455c1148ac7a0e31ce5`（含 #6039） |
| 打包 | CI run `35956537159`，包 `metasheet-multitable-onprem-v2.5.0-r59.zip` |
| 迁移 | r58 之后新增 9 条全部执行（`kysely_migration` 计数 = 9） |
| 上机前备份 | `pre-r59-20260924-124617.dump`（演示机 `output\backups\`）+ 升级脚本自己的 `upgrade-backup-20260924-124620` |
| 验证 | 后端 health、经 nginx `/api/health` 200、前端 smoke PASS、#5953/#6039 标记 True、维护标志已撤、进程 online |
| 之后合入 main、**未上机**的 | 从 `b7e1cbbeb` 起（#6040/#6041 等）——下次 R60 一并上 |

已知且非本次引入：备料定时试拉报 `CONNECTION_CANONICAL_UNAVAILABLE`（r58 日志末尾已出现）；上机脚本里 6 条旧标记恒为 False（r58 同样，标记写法过时，不是回退）。

## 2. 本次上机事故与修正（下次必读）

**现象**：升级脚本停服、换代码、跑完迁移后，`pm2 restart metasheet-backend` 报 `Process or Namespace ... not found` → `RESTORE REQUIRED`，维护标志挂着（站点 503）约 18 分钟。

**根因**：演示机 2026-09-21 重启后，后端由计划任务 `MetaSheet-PM2` → `start-pm2-runtime-persistent.bat` → `pm2-runtime` 托管，**`PM2_HOME` 是 `C:\Users\Administrator\.pm2-runtime`**；ssh 会话里的 `pm2` 用默认 `~\.pm2`。升级脚本的 stop 让应用退出后，`pm2-runtime` 因无应用而自行退出；随后在默认 home 里 restart 自然找不到。

**向前修复**（代码与迁移都已是 r59，只差拉起进程）：
1. `Start-ScheduledTask -TaskName 'MetaSheet-PM2'`，27 秒 health 通过；
2. 删除 `output\maintenance.flag`；
3. 跑升级脚本的第 2–7 段验证（`verify-222-r59.ps1`）。

**补充根因（依据 pm2 master 分支源码，并在开发机上用 pm2 7.0.4 + Windows PowerShell 5.1 实测；演示机上的 pm2 版本未核对）**：单设 `PM2_HOME` 救不了 restart。pm2-runtime 默认开 auto-exit：在线应用数为 0 时，约 8–11 秒后连同自己的 daemon 一起退出（`lib/binaries/Runtime4Docker.js` 的 `autoExitWorker`；实测 7.9 秒和 10.6 秒）。实测里，就在 pm2-runtime 自己的 `.pm2-runtime` home 下 restart，照样 exit=1、not found；这时再起一个 pm2-runtime（也就是计划任务做的事），1.4 秒内应用 online。另外，Windows 上 pm2 CLI 走固定命名管道 `\\.\pipe\rpc.sock`，与 `PM2_HOME` 无关（`paths.js`），所以不管在哪个 home 里 stop，都会停掉 pm2-runtime 上的应用。备份、换代码加迁移远超 8 秒，到 restart 时 daemon 已不在；不管在哪个 home 里 restart，都只会拉起一个空 daemon，报 not found。托管场景下，拉起路径只能是计划任务。

**下次上机改法**（升级脚本已内置，见 `scripts/ops/multitable-onprem-package-upgrade-inplace.ps1` 的 `-Pm2Home` / `-Pm2ScheduledTaskName`）：
- **不再需要**在 wrapper 里预设 `$env:PM2_HOME`，照常调用即可。脚本启动时先解析出一个 pm2 home，本次运行的所有 pm2 调用（stop、restart、回退里的 kill、失败处理里的 stop）都用它。优先级：`-Pm2Home` 参数 > 进程里已有的环境变量 `PM2_HOME` > 自动探测（`<用户目录>\.pm2-runtime` 存在，**且**有名为 `-Pm2ScheduledTaskName`（默认 `MetaSheet-PM2`）的计划任务）> 不设。不是完整路径的值（相对路径、`\x` 这种从根开始但没写盘符的、`C:x` 这种带盘符的相对路径）在启动时按当前位置转成完整路径（第 6 步会切到 RootDir，pm2 按自己的 cwd 解析）；环境变量里的 `PM2_HOME` 如果根本不是文件系统路径（比如 `Env:\...`），启动时拒绝（`PM2_HOME_NOT_FOUND`）。三者都不适用时脚本不设 `PM2_HOME`：第 6 步导入 `docker\app.env` 后，如果该文件设了 `PM2_HOME`，第 7 步的 pm2 调用会用它（原有行为），最终报告的 `pm2 home:` 一行会写明。升级脚本输出的第一行 `pm2 home: ... (source: ...)` 会写明用的是哪个，最终报告里也有。
- restart 报 `not found`，且该计划任务存在时，脚本打印 `PM2_RESTART_NOT_FOUND_FALLBACK`，先 `pm2 kill`，等 pm2 的命名管道关闭，再 `Start-ScheduledTask`，然后走原来的 health 轮询（先直连后端，撤维护门，再经 nginx）。最终报告 `backend started:` 一行写的是 `pm2-restart` 或 `scheduled-task`。演示机上**预期看到的是 `scheduled-task`**。
- **为什么要先 kill**（开发机上 pm2 7.0.4 + PS 5.1 实测，用 kill-on-close 的 job object 模拟远程会话结束）：报 not found 的那次 restart 找不到 daemon，会在**升级会话里**拉起一个空 daemon。Windows 上所有 pm2 daemon 共用 `\\.\pipe\rpc.sock`，计划任务起的 pm2-runtime 发现管道上已有 daemon，就只作为客户端连上去，应用实际挂在这个空 daemon 下。health 当场能过，但会话的进程树一结束，后端就跟着没了，计划任务却仍显示 Running。先 kill 之后，pm2-runtime 日志是 `Launching in no daemon mode`，应用的父进程是 pm2-runtime 本身，会话结束后 health 仍 200。kill 后管道 15 秒内仍未关闭时，脚本报 `PM2_DAEMON_STILL_RUNNING`，**不**启动计划任务。管道命名空间列不出来时，只有 `pm2 kill` 退出码为 0 才启动任务（日志里标 `UNVERIFIED`）；kill 也失败就报 `PM2_DAEMON_STATE_UNKNOWN`，不启动。演示机的远程会话断开时是否真的连带结束进程树，没有在演示机上核对过。先 kill 之后，开发机实测后端挂在计划任务起的 pm2-runtime 下、不在升级会话的进程树里，所以这一点不影响后端是否存活；上机后按第 3 节第 5 步核对一次。
- 计划任务按**完整名字**在所有任务文件夹里找，必须恰好一个（同名任务出现在两个文件夹里时不认，也不回退）；启动时带上它所在的文件夹（`-TaskPath`）。只给名字的 `Start-ScheduledTask` 只在根文件夹 `\` 里找，任务放在子文件夹里就会起不来（开发机上用真实 cmdlet 只读核对过：按名字查子文件夹任务报 "The system cannot find the file specified"，带 `-TaskPath` 能找到）。
- 以下情况仍按原逻辑进 `RESTORE REQUIRED`：计划任务起不来（`PM2_SCHEDULED_TASK_START_FAILED`）、kill 后仍有 daemon（`PM2_DAEMON_STILL_RUNNING`）或无法判断（`PM2_DAEMON_STATE_UNKNOWN`）、起来了但 health 不通过（`BACKEND_HEALTHCHECK_FAILED`）、restart 失败但原因不是 not found、没有恰好一个该名字的计划任务。托管主机上，restore 块会多打三行，顺序是 `$env:PM2_HOME = '...'`、（原有的 `pm2 restart`）、`pm2 kill`、`Start-ScheduledTask -TaskName 'MetaSheet-PM2' -TaskPath '<任务所在文件夹>'`，手工执行时**先 `pm2 kill` 再启动任务**，理由同上。这时仍按上面三步向前修复，不要回滚（迁移只增不删；r58 代码也能跑在新表结构上，但没必要回滚）。
- 显式传的 `-Pm2Home` 如果不是已存在的文件系统目录（比如 `HKCU:\...`），脚本启动时直接拒绝（`PM2_HOME_NOT_FOUND`）：这时还没碰 pm2、没挂维护门、也没做备份。传 `-Pm2ScheduledTaskName ''` 会同时关掉自动探测和计划任务回退。

## 3. 上机手册（在能连演示机的运维机上执行）

脚本模板在运维机 `%LOCALAPPDATA%\Temp\claude-auto24\rNN\`（不入库：含主机地址）。以 r59 为模板复制成 `r60`：

1. **准备**：`sed 's/r59/r60/g'` 生成 `r60-build-and-ship.sh` 与 `upgrade-222-r60.ps1`；`multitable-onprem-package-upgrade-inplace.ps1` **从 `scripts/ops/` 重新复制并加 BOM**（PS 5.1 需要 BOM）。旧拷贝没有 pm2-runtime 探测，不能再用。wrapper 里**不要**再加 `PM2_HOME`（见第 2 节「下次上机改法」）。
2. **标记**：只加本批 diff 里真实存在的标识符或文件哈希；新迁移按名字数 `kysely_migration`。带反斜杠的内容用文件写、别用 heredoc（会折叠成控制字符），写完按字节扫控制字符。
3. **只读预检**：审计分区（当月+下月）、最近迁移、磁盘、`pm2 list`（手工执行时先设 `$env:PM2_HOME='<用户目录>\.pm2-runtime'`），另查一次 `Get-ScheduledTask -TaskName 'MetaSheet-PM2' | Select-Object TaskPath, TaskName, State`，确认计划任务恰好一个，并记下它的 `TaskPath`。升级脚本靠它探测托管方式、在 restart not found 后回退拉起。若 `pm2 list` 输出里出现 `Spawning PM2 daemon`，说明 pm2-runtime 此刻没在跑，这条命令刚在本会话里拉起了一个空 daemon：先停下来查后端为什么没在跑，别在这个状态下升级。
4. **打包上机**：`bash r60-build-and-ship.sh all`（CI 打包 → 校验 sha256 / gitSha / base path `/assets/` → scp → 远端 sha 复核 → wrapper：pg_dump 备份 → 就地升级含 migrate → health → 标记 → 前端 smoke → 定时试拉 → pm2）。
5. **判定**：日志 `FullyQualifiedErrorId` 计数必须 0；新标记全 True；web smoke PASS；维护标志不存在。`backend started: scheduled-task` 时，再只读核对一次后端挂在谁下面：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine`，后端进程的 `ParentProcessId` 应指向命令行含 `pm2-runtime` 的进程，而不是命令行含 `Daemon.js` 的 pm2 daemon。然后结束升级会话，重新连上再测一次 health。
6. **回滚**：升级脚本打印的 `RESTORE REQUIRED` 块给出备份路径；数据库用 `pre-rNN-*.dump` 恢复（仅在迁移本身出错时才需要）。

远端 shell 约定：PowerShell 5.1，不认 `&&`；脚本一律 scp 后 `-File` 运行；wrapper 保持纯 ASCII。

## 4. 双机协同约定

| | 开发机（新） | 运维机（能连演示机） |
|---|---|---|
| 职责 | 写代码、PR、反驳、终审、合并 | 上机、上机验证、演示机日志 |
| 同步 | 推 PR → main | 上机前 `git pull` 到 main |

1. 一支 PR 只在一台机器上改；换机先推、再拉。
2. 在 issue/PR 上注明归属（「开发机进行中」「待上机 R60」）。
3. 会话不跨机 resume；每次在哪台开工就在哪台开新会话，从 GitHub + 本文接上。
4. 本机记忆（`~\.claude\projects\<项目>\memory\`）不自动同步，定期单向拷贝。
5. 待上机清单写在本文第 5 节（或新开一份 rNN 记录），运维机照第 3 节执行。

## 5. 接下来（开发机）

- **#5954**：跨库镜像记录操作多表 `FOR UPDATE` 后不复读存活，软删竞争窗仍可写已删表。
- **#5955**：elearning-stats 投影表行锁不读 `deleted_at`——先证实影响再修。
- **form-share 三处手写同形拒绝**：结构守卫从「按名字」改为「按形状」。
- 升级脚本 PM2_HOME 探测 + 计划任务回退：已开 PR（分支 `fix/onprem-upgrade-pm2-runtime-home`），合入后随 R60 首次上机验证。
- 待 owner：#5864 字段类型转换五项；PR #5609 考勤守卫选路；#5933 授权。

**待上机（R60）**：main `b7e1cbbeb` 及之后合入的全部。
