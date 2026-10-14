# 运行手册：演示机后端日志定期归档（R66 维护窗口，owner 2026-10-12）

> 依据：owner 2026-10-12 在 #6079（评论 6118907463 第 1 项）裁定：后端日志轮转用 **Windows 计划任务定期归档**，不用 pm2 日志轮转模块；开发机出 runbook，在 R66 维护窗口执行。问题来源：`r65-deploy-record-20261012.md` §5 第 1 项（`metasheet-backend.out-0.log` 已 1.42 GB，从未轮转）。
> 脚本：`scripts/ops/multitable-onprem-backend-log-rotate.ps1`（Windows PowerShell 5.1 可用）。测试：`scripts/ops/__tests__/multitable-onprem-backend-log-rotate.tests.ps1`。
> 本手册不含主机、地址、账号名、口令；文中 `<安装根目录>`、`<服务账号用户目录>`、`<脚本目录>`、`<日志路径>` 由现场替换，只记在私有记录里。

## 0. 前提

### 0.1 托管方式（已在仓库文档里，见 `handoff-r59-two-machine-20260924.md` 第 2 节）

- 后端由计划任务 `MetaSheet-PM2` → `pm2-runtime` 托管，pm2-runtime 以 no-daemon 模式运行（日志里是 `Launching in no daemon mode`）。
- 后端日志是 `<安装根目录>\output\logs\metasheet-backend.out-<pm_id>.log` 和 `.err-<pm_id>.log`（`ecosystem.config.cjs` 里写的是 `metasheet-backend.out.log`，pm2 在扩展名前插入 pm_id，现网是 `-0`）。
- **日志文件句柄在 pm2-runtime 进程里，不在后端子进程里**：后端的 stdout/stderr 是接到 pm2 的管道，由 pm2 写文件（§5 实测与源码）。所以「让 pm2 重新打开日志」就是对 pm2-runtime 发 `pm2 reloadLogs`。

### 0.2 PM2_HOME 必须指 pm2-runtime 的目录

- 每次都传 `-Pm2Home <服务账号用户目录>\.pm2-runtime`（或在同一会话里事先设好 `PM2_HOME`）。两者都没有时脚本**停下**（退出码 2），不猜路径；目录不存在也停下。
- 注意：Windows 上 pm2 的 RPC 管道是全机唯一的 `\\.\pipe\rpc.sock`，**与 PM2_HOME 无关**（§5 (b) 第 [4] 步：传一个错的目录，`reloadLogs` 照样到达 pm2-runtime，还在那个目录里新建了一个空的 pm2 home）。所以 PM2_HOME 不决定连到谁，传对它是为了不在别处生出多余的 pm2 home、和升级脚本用同一个 home。

### 0.3 同一个账号、同一提权级别

- 手工执行用**与 `MetaSheet-PM2` 相同的账号**，在同样提权的会话里执行（与升级脚本同一个会话即可）。
- 计划任务由脚本的 `-Register` 自动读取 `MetaSheet-PM2` 的账号与运行级别，照抄（见 §2）。
- 为什么：脚本要对 pm2-runtime 的管道发 `reloadLogs`。账号或提权级别不同，可能连不上管道；pm2 CLI 连不上时会**自己拉起一个新 daemon** 并照样打印 `All logs reloaded`、退出码 0（§5 (b) 第 [6] 步）。脚本对此有两道防线：管道不存在时根本不调用 pm2；调用后看到 `Spawning PM2 daemon`、pm2 退出码非 0、或活动日志文件没有按时重新出现，就退出码 4，并对每个改了名的文件二选一：原名仍不存在 → 移回原名（`ROLLED BACK`）；原名已由 pm2 晚到地重建 → 保留归档（`LATE REOPEN`，这个文件其实已轮转成功）。**出现 `Spawning PM2 daemon` 时不要执行 `pm2 kill`**：管道全机唯一，kill 可能打到 pm2-runtime 本身，后端随之退出；那个多余的 daemon 要按 §3 第 8 项手工去掉。

### 0.4 取得脚本（安装包里没有它）

R66 安装包**不含**本脚本：打包脚本只复制 `scripts/ops/multitable-onprem-package-build.sh` 的 `REQUIRED_PATHS` 里逐条列出的文件。R66 打包点 `5acc139a44e6e4eb0e8e23a9b0f4e6b2f16d0ed6` 早于本手册所在 PR，**那个提交里也没有这个脚本**；从**本 PR 合入 main 之后的任一提交**取（`<提交>` 用合并提交）。做法与 `runbook-operator-merge-20261012.md` §0.5 相同：

1. 在开发机上用 **Git Bash 或 PowerShell 7.4+** 在仓库根目录执行，用 `git archive` 取，**不要**用 `git show … > 文件`（Windows PowerShell 5.1 的 `>` 写出 UTF-16LE），也不要用 `git show --output`（对文件内容不生效）：
   ```
   git -c core.autocrlf=false archive --format=tar <提交> scripts/ops/multitable-onprem-backend-log-rotate.ps1 | tar -x -C <空目录>
   ```
2. 核对拷贝等于提交里的文件，两条输出必须完全相同：
   ```
   git hash-object --no-filters <空目录>/scripts/ops/multitable-onprem-backend-log-rotate.ps1
   git rev-parse <提交>:scripts/ops/multitable-onprem-backend-log-rotate.ps1
   ```
   再算 SHA-256（`sha256sum` 或 `Get-FileHash -Algorithm SHA256`），**记入台账**。
3. 拷到服务器上一个**不含空格、不会被清理**的目录 `<脚本目录>`（**不要**放进升级用的 staging 目录：计划任务按注册时的脚本路径执行，脚本被删了任务就每天失败）。在服务器上 `Get-FileHash -Algorithm SHA256 <脚本目录>\multitable-onprem-backend-log-rotate.ps1`，与台账逐字比对，不同就不要用。
4. 脚本是纯 ASCII，PowerShell 5.1 下不需要 BOM。

### 0.5 在服务器（Windows PowerShell 5.1）上怎么执行、怎么看结果

- **用 cmd 落日志**（PowerShell 5.1 的 `>` 和 `Tee-Object` 写 UTF-16）：
  ```
  cmd /d /c "powershell -NoProfile -ExecutionPolicy Bypass -File <脚本目录>\multitable-onprem-backend-log-rotate.ps1 -InstallRoot <安装根目录> -Pm2Home <服务账号用户目录>\.pm2-runtime <其它参数> > <日志路径> 2>&1"
  $LASTEXITCODE
  Get-Content -Encoding UTF8 <日志路径>
  ```
  安装根目录含空格时，在 `cmd /d /c "…"` 里用成对双引号括起：`-InstallRoot ""<根目录>""`；路径不要以 `\` 结尾。经 ssh 单行执行时整行末尾加 `; exit $LASTEXITCODE`。
- 屏幕输出全是 ASCII。`-Apply` 时脚本另把同样的行**追加**到 `<归档目录>\rotate-<yyyyMMdd>.log`（UTF-8，无 BOM），计划任务每天的结果就在这里看。
- **不要把输出接到 `Select-Object -First`**（会提前结束运行、丢掉退出码）。
- 默认是 **dry-run**：只打印计划，什么都不改（不建归档目录、不写日志文件、不调用 pm2）。加 `-Apply` 才执行。

### 0.6 参数与退出码

| 参数 | 默认 | 说明 |
|---|---|---|
| `-InstallRoot` | 必填 | 安装根目录；日志目录 = `<安装根目录>\output\logs` |
| `-Pm2Home` | 环境变量 `PM2_HOME`，都没有就停 | 见 0.2 |
| `-ArchiveDir` | `<安装根目录>\output\logs\archive` | `Rename` 模式要求与日志目录同一个卷，否则退出码 2 |
| `-Keep` | 14 | 每个日志流保留的归档个数，必须 ≥ 1（`0` 退出码 2）；`rotate-*.log` 也保留同样个数 |
| `-MinSizeMB` | 64 | 活动日志小于这个大小就跳过（不轮转）；必须 ≥ 0 |
| `-Mode` | `Rename` | 或 `CopyTruncate`，见 §5 (c) |
| `-Pm2Command` | `<安装根目录>\node_modules\.bin\pm2.cmd`，没有就用 PATH 上的 `pm2` | 与升级脚本相同的查找顺序 |
| `-ReopenTimeoutSec` | 10 | `reloadLogs` 之后等活动日志重新出现的秒数 |
| `-Pm2TimeoutSec` | 60 | `pm2 reloadLogs` 调用本身最多等的秒数；超时按 `reloadLogs` 失败处理（回滚、退出码 4），见 §2.4 |
| `-DryRun` / `-Apply` | 都不给 = dry-run | 两个同时给是用法错误（退出码 2） |
| `-Register` / `-At` | 不注册 / `03:30` | 见 §2；`-At` 必须是 `HH:mm` |
| `-HostTaskName` | `MetaSheet-PM2` | 托管 pm2-runtime 的计划任务；`-Register` 从它读账号与运行级别 |
| `-TaskName` | `MetaSheet-LogRotate` | 要注册的任务名；**不得为空、不得等于 `-HostTaskName`**（忽略大小写和首尾空格，否则退出码 3，否则 `-Force` 会把宿主任务覆盖掉） |

| 退出码 | 含义 |
|---|---|
| 0 | 成功；或 dry-run；或没有需要轮转的文件 |
| 1 | 未预料的 PowerShell 错误（例如在**未提权**的会话里 `-Register -Apply`，`Register-ScheduledTask` 报拒绝访问）。看屏幕上的错误；已做到哪一步看 `rotate-<日期>.log` |
| 2 | 用法或配置错误（缺 `-InstallRoot` / `-Pm2Home`、目录不存在、`-DryRun` 与 `-Apply` 同时给、`-Keep` < 1、`-MinSizeMB` < 0、跨卷的 `Rename`）。**什么都没改** |
| 3 | `-Register` 被拒绝（`-TaskName` 为空或等于宿主任务名、找不到 `MetaSheet-PM2`、`-At` 不是 `HH:mm`、没有 ScheduledTasks 模块）。**什么都没注册** |
| 4 | `reloadLogs` 失败（退出码非 0 或输出含 `Spawning PM2 daemon`）或活动日志没在 `-ReopenTimeoutSec` 内重新出现。逐个文件看日志：`ROLLED BACK` = 已移回原名，后端继续写原文件，什么都没丢；`LATE REOPEN` = pm2 在等待结束后才重建了活动日志，归档保留，这个文件实际已轮转 |
| 5 | 某个文件操作失败（看 `rotate-<日期>.log` 里的 `FAILED:` 行；例如同名归档已存在） |

**pm2 调用有时限：`-Pm2TimeoutSec`（默认 60 秒）。** 脚本把 pm2 作为独立进程启动，标准输出/错误重定向到临时文件（不用管道，所以 pm2 拉起的 daemon 不会让读输出的一方永远挂住），`.cmd` 垫片（`pm2.cmd`）经 `cmd.exe /d /c` 启动，用有时限的等待。超时：只结束脚本自己启动的那个 pm2 CLI 进程（及其非 daemon 子进程；`pm2\lib\Daemon.js` 进程绝不碰），按 `reloadLogs` 失败处理——已改名的文件原名仍不存在就移回原名（`ROLLED BACK`），日志里打印 `pm2 call timed out after N s`，退出码 4。因此活动日志不会再停在改名后的归档名下。若 pm2 在超时前已经拉起 daemon，处理见 §3 第 8 项。

## 1. 首次手工归档（活动日志约 1.4 GB）

**用 `Rename`（默认），不要用 `CopyTruncate`。** 改名只改目录项，与文件大小无关（开发机上 1.42 GB 改名 1 ms），不占额外磁盘；复制要多占一份 1.4 GB，耗时取决于磁盘（开发机 NVMe 且文件在缓存里 0.36 s，演示机冷读会慢得多，没有在演示机上量过），而且复制开始到截断之间写的行会丢。改名失败（共享冲突）时脚本自动对该文件改用 `CopyTruncate`，此时需要日志卷上有 1.4 GB 以上空闲。

1. **dry-run**（按 0.5 的写法，不带 `-Apply`）。逐行核对：
   - `[dry-run] rotate: logs=… archive=… mode=Rename keep=14 minSizeMB=64 pm2Home=… pm2=…`：`mode` 必须是 `Rename`；`pm2=` 后面应是一个完整路径（通常是 `<安装根目录>\node_modules\.bin\pm2.cmd`）；只显示 `pm2` 表示没找到 pm2，停下；
   - 如果先出现 `FALLBACK: no pm2 RPC endpoint …`：本机此刻没有任何 pm2 在监听管道，也就是 pm2-runtime 没在跑——**停下**，先查后端为什么没在跑（`Get-ScheduledTask -TaskName 'MetaSheet-PM2'` 的状态、health），不要继续；
   - `[dry-run] would Rename metasheet-backend.out-0.log (… MB) -> <归档目录>\metasheet-backend.out-0.<时间>.log`；`err` 小于 64 MB 时是 `[dry-run] skip metasheet-backend.err-0.log (…)`；
   - 末行 `[dry-run] done, exit 0`，`$LASTEXITCODE` 为 0。
2. **执行**：同一条命令加 `-Apply`。期望（几秒内结束）：
   - `renamed metasheet-backend.out-0.log (… MB) -> …`；
   - `pm2 reloadLogs exit=0: Reloading all logs... | All logs reloaded`；
   - `live log(s) reopened by pm2`；
   - `done, exit 0`。
3. 退出码 4：逐个文件看日志。`ROLLED BACK: … moved back to …` = 已移回原名，后端照常写原文件，什么都没丢；`LATE REOPEN: … came back after the wait; archive … kept` = pm2 晚到地重建了活动日志，这个文件已轮转，不用处理。按 0.3 核对账号与提权、`MetaSheet-PM2` 是否在运行。有 `WARNING: pm2 could not reach pm2-runtime and spawned a stray pm2 daemon; …` 时**不要 `pm2 kill`**，按 §3 第 8 项去掉那个 daemon（必须在下一次 `MetaSheet-PM2` 启动之前），再把这一段日志报给开发机。退出码 4 但**没有**任何 `WARNING: … stray daemon` 行时，脚本在**任何**退出码 4 时都会扫描全部命令行以 `pm2\lib\Daemon.js` 结尾的 node 进程（不按启动时间过滤，调用之前就在的也算），并打印 `pm2 daemon process(es) (node ...pm2\lib\Daemon.js) present now: pid <pid…>` 或 `… present now: none`；脚本从不停止它们，有 pid 时按 §3 第 8 项处理。
4. 退出码 5：把 `FAILED:` 那几行报给开发机；活动日志不会被删除（脚本从不删活动日志）。
5. 不停服务、不挂维护标志、不碰数据库。pm2 换文件的那一瞬间（毫秒级）到达的输出会被丢弃（§5 源码第 4 条），其余不丢。

## 2. 注册计划任务

1. **先看要注册什么**（不带 `-Apply`）：参数加 `-Register`。输出两行：
   - `task 'MetaSheet-LogRotate': daily 03:30, user <账号> (host LogonType '…' -> …, RunLevel …)`：`<账号>` 必须与 `MetaSheet-PM2` 的运行账号相同（脚本就是从 `schtasks /query /tn MetaSheet-PM2 /xml` 的 `Principal` 读的）；
   - `task action: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<脚本目录>\…" -InstallRoot "…" -ArchiveDir "…" -Pm2Home "…" -Pm2Command "…" -Keep 14 -MinSizeMB 64 -Mode Rename -Apply`；
   - `[dry-run] nothing registered; add -Apply to register`。
   找不到 `MetaSheet-PM2`（或同名任务读不出账号）时是 `REFUSED: scheduled task 'MetaSheet-PM2' not found …`，退出码 3，什么都不注册。
2. **注册**：`-Register -Apply`，末行 `registered 'MetaSheet-LogRotate'`。重复执行会覆盖同名任务（用来改时间或参数）。必须在**提权**的会话里执行（否则 `Register-ScheduledTask` 拒绝访问，退出码 1）。不要传 `-TaskName MetaSheet-PM2`：脚本会拒绝（退出码 3），因为覆盖注册会把宿主任务换成本任务。注册后按 §3 第 4 项实跑一次；日志里出现 stray daemon 警告时按 §3 第 8 项处理。
3. 任务属性：
   - 每天 `-At`（默认 03:30）；错过（关机）后开机补跑；同一时间只跑一个实例；2 小时超时。
   - 账号与 `MetaSheet-PM2` 相同；运行级别照抄（`HighestAvailable` → 最高权限）。登录方式：宿主任务是「不管用户是否登录都运行」（存了口令）时，本任务用 **S4U**（同样不管是否登录都运行，但**不保存口令**，只能访问本机资源——本任务只碰本机文件和本机管道）；宿主是 SYSTEM 等服务账号时用服务账号；宿主是「只在用户登录时运行」时照抄。
   - 计划任务按**注册时脚本所在路径**执行：注册后不要移动或删除 `<脚本目录>` 里的脚本；换脚本版本就覆盖同一路径后重新 `-Register -Apply`。
4. **归档落在哪、占多少盘**：`<安装根目录>\output\logs\archive\metasheet-backend.{out,err}-0.<yyyyMMdd-HHmmss>.log`，外加每天一个 `rotate-<yyyyMMdd>.log`。只有活动日志 ≥ 64 MB 的那天才轮转，所以每个归档至少 64 MB、至多是两次轮转之间写的量；每个日志流最多留 14 个。首次手工归档的那一个约 1.4 GB，要等该流再轮转 14 次才被删掉（可以随时手工删）。上限约为「1.4 GB + 每个流 14 × 两次轮转之间的日志量」；增速以现网为准，开发机不估具体数。

## 3. 核对

1. **新的活动日志在被写**（隔 10 秒看两次，第二次更大）：
   ```
   (Get-Item <安装根目录>\output\logs\metasheet-backend.out-0.log).Length
   ```
2. **归档不再增长**（同样隔 10 秒看两次，两次相同）：
   ```
   Get-ChildItem <安装根目录>\output\logs\archive -Filter 'metasheet-backend.out-0.*.log' | Select-Object Name, Length
   ```
3. **任务账号与宿主一致**：
   ```
   Get-ScheduledTask -TaskName 'MetaSheet-PM2','MetaSheet-LogRotate' | ForEach-Object { $_.TaskName + ' ' + $_.Principal.UserId + ' ' + $_.Principal.LogonType + ' ' + $_.Principal.RunLevel }
   ```
   只看两行的账号与运行级别是否一致，不抄进 issue。
4. **建议：在维护窗口里把计划任务的整条路径实跑一次**（证明计划任务的登录方式能连上 pm2-runtime 的管道——这一点开发机没法验证）：用 `-Register -Apply -MinSizeMB 0` 注册一次，`Start-ScheduledTask -TaskName 'MetaSheet-LogRotate'`，等 `(Get-ScheduledTaskInfo -TaskName 'MetaSheet-LogRotate').LastTaskResult` 变为 0，读 `rotate-<今天>.log` 的最后一段：应有 `mode=Rename`、`renamed …`、`live log(s) reopened by pm2`、`done, exit 0`。然后**用默认参数重新 `-Register -Apply`**（恢复 `-MinSizeMB 64`）。
   - 是 `FALLBACK: no pm2 RPC endpoint` 而后端明明在跑：任务看不到管道，停下报开发机；
   - 是 `ROLLED BACK` 或 `WARNING: pm2 could not reach pm2-runtime and spawned a stray pm2 daemon`（`LastTaskResult` 为 4）：任务的账号或提权与 pm2-runtime 不一致，**不要 `pm2 kill`**；有 stray 警告时先按第 8 项去掉那个 daemon，再删掉任务（§4），报开发机。
5. **第二天**：`(Get-ScheduledTaskInfo -TaskName 'MetaSheet-LogRotate').LastTaskResult` 为 0；有 `rotate-<当天>.log`；不到 64 MB 的那天日志里是 `skip …`。
6. **清理生效**：每个流的归档个数不超过 14：
   ```
   (Get-ChildItem <安装根目录>\output\logs\archive -Filter 'metasheet-backend.out-0.*.log').Count
   ```
7. 后端仍挂在 pm2-runtime 下：做法见 `handoff-r59-two-machine-20260924.md` 第 3 节第 5 步（`Win32_Process` 的 `ParentProcessId`）。这一项也是第 8 项的**探测手段**：后端 node 进程的父进程应是命令行含 `pm2-runtime` 的进程；若是命令行以 `pm2\lib\Daemon.js` 结尾的进程，说明后端已经跑在多余的 daemon 里。
8. **多余的 pm2 daemon（stray）：识别与去除。** 何时要做：脚本日志里出现 `WARNING: pm2 could not reach pm2-runtime and spawned a stray pm2 daemon; stray daemon pid <pid>`（或 `its pid was not found`），或退出码 4 的日志里有 `pm2 daemon process(es) … present now: pid <pid>`（含调用之前就已存在的），或第 7 项看到 `Daemon.js` 进程。pm2-runtime 自己从不运行 `pm2\lib\Daemon.js`，所以**命令行以 `pm2\lib\Daemon.js` 结尾的 node 进程，按定义就是某次 pm2 命令（本脚本的 `reloadLogs`、手工 `pm2 list` 等）连不上 pm2-runtime 时拉起的多余 daemon**。它不会自己退出，并占着全机唯一的管道 `\\.\pipe\rpc.sock`。之后 `MetaSheet-PM2` 再启动 pm2-runtime 时（升级后的重启）**不会报错**：pm2-runtime 作为客户端连上它，后端就跑在这个 daemon 里；`pm2 list` / `restart` / `reloadLogs` 也都对它成功，一直悄无声息，直到有人把它去掉。所以必须在**下一次 `MetaSheet-PM2` 启动之前**处理：
   1. 找到它：
      ```
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '[\\/]pm2[\\/]lib[\\/]Daemon\.js"?\s*$' } | Select-Object ProcessId, ParentProcessId, CreationDate
      ```
      脚本 WARNING 行给出的 pid 应在其中。
   2. 确认 `Get-ScheduledTask -TaskName 'MetaSheet-PM2'` 的 `State` 是 `Running`，后端 health 正常，并按第 7 项确认后端的父进程是 pm2-runtime、**不是**这个 daemon。
   3. `Stop-Process -Id <pid>`：只停这一个 pid，**不要 `pm2 kill`**（kill 走全机唯一的管道，停到谁说不准，可能把 pm2-runtime 和后端一起停掉）。
   4. 重跑第 1 步，应为空；再看一次 health。
   若第 2 步发现后端已经跑在这个 daemon 下（父进程是 `Daemon.js` 进程），**不要 Stop-Process**（会把后端一起停掉），停下报开发机。开发机实测：停掉 stray daemon 后管道随即关闭（§5 (d)）。

## 4. 回退

- 停止定期归档：`Unregister-ScheduledTask -TaskName 'MetaSheet-LogRotate' -Confirm:$false`。
- 归档都是普通文件，留着或删除都不影响后端；不需要合并回去。
- 脚本不改 pm2 配置、不改 `ecosystem.config.cjs`、不停服务；回退不需要重启任何东西。

## 5. 实测记录（开发机，2026-10-12）

环境：Windows 11，Windows PowerShell 5.1.28000，node v20.20.2，pm2 **7.0.4**（与升级脚本实测用的同一版本；**演示机上的 pm2 版本仍未核对**）。下文路径以 `<lab>` 代替。另核对了 pm2 5.4.3 的源码，下面引用的几处逻辑完全相同（行号见末尾）。

### (a) Node 以 `'a'` 打开的文件（pm2 用的就是这种打开方式）

一个 node 进程用 `fs.createWriteStream(file, {flags: 'a'})` 每 200 ms 写一行，在 PowerShell 5.1 里：

```
(i) Move-Item while open: OK
(i) renamed file length before=288 at-rename=288 +2s=618 ; live name exists after rename: False
(ii) copy length=288 ; live length right after Clear-Content=0 ; +1s=165
(ii) NUL bytes in live file after truncate: 0
00000000   6C 69 6E 65 20 31 30 20 32 30 32 36 2D 31 30 2D  line 10 2026-10-
```

- 打开着的文件可以改名（libuv 打开文件时带 `FILE_SHARE_DELETE`）；改名后写入**跟着句柄进了改名后的文件**，原名不会自己出现——所以单改名不够，必须让写的进程重新打开。
- 复制后截断：截断后的写入从偏移 0 开始，**没有 NUL 填充**（追加模式每次写都定位到文件末尾）。

### (b) pm2-runtime 7.0.4（fork 模式，`out_file`/`error_file` 与仓库 `ecosystem.config.cjs` 同形）

```
[1] pm2-runtime pid=…; live out file=lablog.out-0.log len=341; pipe present=True
    proc pid=A ppid=… cmd=…pm2-runtime start …ecosystem.config.cjs
    proc pid=B ppid=A cmd=…\pm2\lib\ProcessContainerFork.js
    first line: 2026-10-12T18:51:40: child stdout type=pipe isTTY=undefined
[2] Move-Item OK; archive len 370 -> 515 after 1s (God keeps writing into the renamed file); live=absent
[3] pm2 reloadLogs (PM2_HOME=lab runtime): exit=0 :: Reloading all logs... | All logs reloaded
    archive len 544 -> 544 (frozen?) ; new live len 174 -> 319
[4] pm2 reloadLogs (PM2_HOME=wrong, nonexistent dir): exit=0 :: <pm2 首次使用该 home 的横幅> | Reloading all logs... | All logs reloaded
    new live len=145 ; wrong home created=True
[5] copy len=145; live after SetLength(0)=0 -> 116 after 1s; NUL bytes=0
[6] pm2 kill: exit=0 :: … [v] PM2 Daemon Stopped
    pipe present after kill=False
    pm2 reloadLogs with no runtime: exit=0 :: [PM2] Spawning PM2 daemon with pm2_home=<lab>\.pm2-runtime | [PM2] PM2 Successfully daemonized | Reloading all logs... | All logs reloaded
    pipe present after that reloadLogs=True  <- a fresh, empty daemon now owns the machine-wide pipe
```

- [1]：后端子进程的 stdout 是管道（`type=pipe`），父进程是 pm2-runtime；文件由 pm2-runtime（God）打开和写入。
- [2]+[3]：改名后 God 继续写改名后的文件；`pm2 reloadLogs` 之后，原路径出现新文件并持续增长，归档文件不再变化。
- [4]：PM2_HOME 指错，`reloadLogs` 仍然到达 pm2-runtime（管道全机唯一），只是多生出一个空 pm2 home。
- [6]：没有 pm2 在运行时，`pm2 reloadLogs` 自己拉起一个新 daemon，打印成功、退出码 0；这个 daemon 还继承了调用方的输出管道，让调用方一直挂着（与 r59 时 ssh 会话挂住同一机理）。这就是脚本「管道不存在就不调用 pm2」的原因。

### (c) 默认模式的选择与兜底

- 默认 **`Rename` + `pm2 reloadLogs`**：大文件瞬时完成、不占额外磁盘、归档内容完整；只丢 pm2 换文件那一瞬间的输出。
- 改名抛异常（写的进程打开时没带 `FILE_SHARE_DELETE`）→ 该文件改用 `CopyTruncate`（测试里用不带 Delete 共享的句柄复现）。
- 本机没有 pm2 管道 → 本次全部改用 `CopyTruncate`，**不调用 pm2**。
- 已改名但 `reloadLogs` 失败、输出含 `Spawning PM2 daemon`、或 `-ReopenTimeoutSec`（默认 10 秒）内活动日志没有重新出现 → 退出码 4；此时原名仍不存在的文件**移回原名**（God 的句柄跟着文件走，所以移回后后端仍在写同一个文件，`ROLLED BACK`），原名已被 pm2 晚到地重建的文件保留归档（`LATE REOPEN`）。活动日志因此不会「消失」。看到 `Spawning PM2 daemon` 时，脚本在 WARNING 行里给出那个多余 daemon 的 pid（按命令行以 `pm2\lib\Daemon.js` 结尾、且在本次调用之后启动来找；另外任何退出码 4 都会再不按时间过滤地列出全部这类进程的 pid），但不去停它们（见 §3 第 8 项）。

### (d) 多余 daemon 的识别与去除（开发机，pm2 7.0.4，PS 5.1）

没有任何 pm2 在运行时执行一次 `pm2 ping`（输出重定向到文件），再用脚本里的同一个查找函数找它，然后 `Stop-Process`：

```
pm2 ping output: [PM2] Spawning PM2 daemon with pm2_home=<lab>\.pm2-stray
pipe present after ping=True
  node pid=25324 cmd=...ab\pm2lab\node_modules\pm2\lib\Daemon.js
Find-StrayPm2Daemon (since before the call) -> 25324
Find-StrayPm2Daemon (since in the future) -> count 0
Stop-Process 25324
pipe present after Stop-Process=False
```

「pm2-runtime 再启动时作为客户端连上多余 daemon、后端跑在它里面」这一点，见 `handoff-r59-two-machine-20260924.md` 第 2 节的实测（pm2 7.0.4），这里没有重做。

用真 pm2-runtime 7.0.4 跑脚本本身（PS 5.1，`-Apply -MinSizeMB 0`，pm2 从 `<安装根目录>\node_modules\.bin\pm2.cmd` 自动找到）：

```
rotate: logs=<lab>\install\output\logs archive=<lab>\install\output\logs\archive mode=Rename keep=14 minSizeMB=0 pm2Home=<lab>\.pm2-runtime pm2=<lab>\install\node_modules\.bin\pm2.cmd
renamed metasheet-backend.err-0.log (0 MB) -> <lab>\install\output\logs\archive\metasheet-backend.err-0.20261012-191020.log
renamed metasheet-backend.out-0.log (0 MB) -> <lab>\install\output\logs\archive\metasheet-backend.out-0.20261012-191020.log
pm2 reloadLogs exit=0: Reloading all logs... | All logs reloaded
live log(s) reopened by pm2
done, exit 0
    archive metasheet-backend.out-0.20261012-191020.log: 716 -> 716 after 2s (frozen) ; live: 29 -> 551 (growing)
（停掉 pm2-runtime 后再跑一次）
FALLBACK: no pm2 RPC endpoint (rpc.sock) on this host, so pm2 is not called (it would spawn a stray daemon); using CopyTruncate for this run
copied+truncated metasheet-backend.err-0.log (0 MB) -> …
copied+truncated metasheet-backend.out-0.log (0 MB) -> …
done, exit 0
    exit=0 ; pipe after=False ; live len=0
```

### 源码依据（pm2 7.0.4，`node_modules/pm2/`）

1. `lib/Utility.js:176`：`startLogging` 用 `fs.createWriteStream(file, {flags: 'a'})` 打开日志——在 God 进程里。
2. `lib/God/ForkMode.js:220`（stdout）/ `:188`（stderr）：子进程的输出由 God 写进这些流：`stds.out && stds.out.write && stds.out.write(log_data)`。
3. `lib/God/ActionMethods.js:613-642`：`God.reloadLogs` 对每个 fork 模式进程调用 `_reloadLogs`，然后在 `:642` **立即** `return cb(null, {})`——不等文件重新打开，所以 CLI 的 `All logs reloaded` 不能证明新文件已建好；脚本因此轮询活动日志是否重新出现。
4. `lib/God/ForkMode.js:283-294`：`_reloadLogs` 先 `destroy()` 旧流、把 `stds[k]` 换回路径字符串（`_file`），再 `Utility.startLogging(stds, cb)` 按**原路径**以追加模式重新打开（原路径不存在就新建）。换流期间 `stds.out` 是字符串，第 2 条的 `stds.out.write &&` 判断让这段时间的输出被丢弃。
5. `paths.js:79-81`：Windows 上 `DAEMON_RPC_PORT = '\\\\.\\pipe\\rpc.sock'`，不含 PM2_HOME。
6. `lib/Client.js:51`、`:104`、`:249`：CLI 先 `pingDaemon`，连不上就 `launchDaemon`，打印 `Spawning PM2 daemon with pm2_home=…`。
7. `lib/API/LogManagement.js:110-122`：`pm2 reloadLogs` 就是 `executeRemote('reloadLogs')`。

pm2 5.4.3 的对应位置：`lib/God/ForkMode.js:274`（`_reloadLogs`）、`lib/God/ActionMethods.js:613`、`lib/Utility.js:177`、`paths.js:85`。

## 6. 与 R66 维护窗口的关系

- 在 R66 升级**完成、health 通过之后**做（同一窗口里若还做一线角色合并，二者互不依赖，先后均可）。顺序：§1 首次手工归档 → §2 注册 → §3 核对（含第 4 项实跑）。
- 不停服务、不挂维护标志、不碰数据库、不需要重启：**没有停机**。
- 升级脚本的 stop / restart / 计划任务回退不读也不动归档目录；以后再升级时这个任务不用动。若某次轮转恰好遇上 pm2-runtime 不在（例如升级中途），脚本看不到管道，自动改用 `CopyTruncate`，不会拉起多余的 daemon。
- 演示机上尚未核对、需现场在 §1 / §3 确认的：pm2 版本（§5 只覆盖 7.0.4 与 5.4.3 的源码）；计划任务登录方式（S4U）下能否连上 pm2-runtime 的管道（§3 第 4 项）。
