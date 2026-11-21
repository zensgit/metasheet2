# P3 离线包回退操作

适用于 P3 已退出、需要覆盖回 owner 批准的 R85 或 R84 的情况。协调者确认事故状态和回退目标，现场人员在同一安装根目录执行。回退会覆盖服务文件并启动旧版，期间保持定时拉取暂停。P3 处于状态 E 时等 owner 处置尚在运行的进程。

## 准备和止损

1. 先用切包生成的 `s06-new-migrations.sql`、`h01` 对照装机单第 20 步。状态 A、B、F 的账本应为 `total`，C、D 应为 `baseline`，两种都要有完成行。状态 C 先保留现场并上报。执行获批的覆盖以前保持进程状态，即使健康探针显示旧版也要核实磁盘和账本。
2. 确认当前批准窗口、数据库身份、schema、旧 ZIP 和同次发布的 `deploy-bootstrap.ps1`。两份文件按发布记录独立校验。确认备份可用、安装根目录已有 P3/旧版的安装树、回退依赖选择已批准。用与安装相同的数据库连接和有足够读权限的角色，按现场方式配置本次临时 PowerShell 的 libpq 连接。保持 `PGDATABASE` 或 `PGSERVICE` 显式设置，密码由既有凭据机制提供。脚本只输出状态和计数。
3. 即使切回 R85，已提交的 D21 仍在库里。旧版多用户角色写入的锁顺序叠上 D21 触发器，可能形成 ABBA 死锁（SQLSTATE `40P01`）。有已应用账本时，从 P4 开始到重跑健康探针以及 owner 批准恢复写入，持续按获批方式隔离角色写入。记录 `40P01` 计数和隔离状态，有死锁立即报告，保留任务暂停。迁移失败且账本仍是已批准的旧基线时，按 C 的证据处理。
4. 先关闭本轮新开的开关，尤其是 `DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED`。经获批的启动流程使 OFF 生效，再核 `03`。如果状态 C 禁止重启，或后端不健康而无法以 `03` 核进程，保留进程状态并由 owner 确认写入隔离。保持租户声明设置。需要转换 `include_children=false` 数据时先另行裁决。
5. **R84 路径额外核对 R85 装机单第十一节 (1)–(4)**。确认 Class B 外发关闭且旧版可读口径完整。已有沿用关系的 `q102_claim_active`、其余阻断性的 `STOP_SP` 计数、已应用的交接及登录修复须为零。R84 定时脚本的批准副本须在场，按旧单处理提示项。R85 路径记录平台提示项与 P5，阻断依据是 P4 和批次标识台账。若 owner 选择更老的回退目标，运行其专用手册和审批路径。

## 先检查，再覆盖

在受控窗口运行 `Invoke-P3Rollback.ps1`。示例变量从本次已批准的发布记录与核对结果取得。R84 路径在核实 Class B 关闭后加入 `-LegacyClassBOff`。使用切包后的 `sql` 目录，其中既有生成的 `s06`、P4、P5 和旧单的 `r2`、`r3`，也有各探针匹配的 `_preamble.sql`。

```powershell
$rollbackArgs = @{
  Target = $approvedRollbackTarget
  InstallState = $observedInstallState
  InstallRoot = $installRoot
  SqlDir = (Resolve-Path .\sql).Path
  Archive = $oldArchive
  ArchiveSha256 = $approvedZipDigest
  Bootstrap = $oldBootstrapPs1
  BootstrapSha256 = $approvedBootstrapDigest
  InstallDeps = $approvedInstallDeps
  Schema = $schema
}
# R84 路径经旧单核对后设置： $rollbackArgs.LegacyClassBOff = $true
.\ps\Invoke-P3Rollback.ps1 @rollbackArgs
```

预检成功应为 `P3_ROLLBACK_RESULT status=preflight_pass`，包含账本、`STOP_PULLBATCH` 和 P4。P4 要有 `blocking=pass`、`false_rows_total=0` 和最后的完成行。两个作用域表的列都没落库（状态 C）时可显示 `columns_present=0`。出现 `unknown`、非零、部分列或读不到结果就停。P5 只记录，非零时将可能留在库里的自动化规则、宜搭台账及 trace 等写入交接，重新开启相关开关前先处理残留规则。

确认本次授权和持续写入隔离后才执行，工具会重跑预检。

```powershell
.\ps\Invoke-P3Rollback.ps1 @rollbackArgs -OwnerApproved -WritesQuiesced -Execute
```

工具以 `-RunMigrations 0` 调用已核哈希的旧包独立启动器，覆盖同一根目录。现场保持原根目录和批准的参数，避开新目录、`upgrade-inplace` 和任何迁移命令。状态 C 下，P3 迁移文件可能仍在覆盖后的目录中，账本只用 `s06` 读取。

`status=STOP stage=overlay` 表示覆盖命令失败，`stage=ledger_after` 表示覆盖后未证实账本相同。两种都保持隔离并只读核 `s06` 和 `h01`，报 owner 后按他确认的恢复路径继续。启动器和数据库客户端原始输出留现场。

## 完成检查

- `P3_ROLLBACK_RESULT status=overlay_complete`、回退前后 `MIG_COUNT` 相同、`MIG_NAMESET` 相同，并且 `h01` 映射为批准的旧版、HTTP 200。对旧版健康、必要插件和权限入口复核后闭合回退证据。
- 关掉 P3 时打开的标签页，重开后 Ctrl+F5。R85 路径比较定时脚本哈希；R84 路径按 R85 装机单换回批准的 R84 副本，再用 `09` 核对命令行形态。
- 记录 P5、平台和残留规则、D21 写入隔离、须由 owner 批准的权限写入恢复、定时拉取恢复及后续 06:00 核验。回报仅含状态和计数。

## T-05 切包交接

在开发机上按每个获批基线生成相匹配的一对装机单和 s06，来源是两份真实解包目录。

```powershell
node scripts/ops/stock-preparation-p3/gen-counts.mjs --layout package --root $p3Extracted --label P3 `
  --baseline-root $baselineExtracted --baseline-label $approvedBaseline `
  --fill docs/operations/stock-preparation-p3-install-qa-sheet.md.tmpl --out $qaSheet `
  --fill scripts/ops/stock-preparation-p3/s06-new-migrations.sql.tmpl --out $s06Sql `
  --json $countEvidence
```

要求 `GENCOUNTS_RESULT status=complete`，两份模板均在计算模式 `hardcoded_lines=0`。从该提交取 `03-live-env-check.ps1` 与 `Invoke-P3Rollback.ps1` 放入 QA 附件 `ps`。离线包仍走既有 verify，审核附件单独核哈希。P1–P7 对最终基线重派生，补齐 T-01、T-02、T-03 和最新构建映射，填写新版窗口、批准记录及附件清单。独立复核应核对这对生成物与包内容、三处 P4/P5/s06 输出契约、R84 额外阻断、状态 C 及新窗口重签。通过目标 Windows 演练和强制状态 C 后记录结果。
