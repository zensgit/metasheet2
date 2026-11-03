# 多维表 on-prem 预检脚本补加密材料 fail-early 设计（2026-09-16）

任务：W5-N（缺口审计矩阵 CRED-13）。核查 `scripts/ops/multitable-onprem-preflight.sh`
是否与 PR #5718（`ops/encryption-material-preflight` 分支）修过的 attendance 预检
脚本同款洞——对 `ENCRYPTION_KEY`/`ENCRYPTION_SALT` 空值或内置默认哨兵不 fail-early。

## 背景：与 #5718 的关系

#5718（分支 `ops/encryption-material-preflight`，两个提交
`ced5a84fa9`「运维预检脚本对加密材料 ENCRYPTION_KEY/SALT fail-early」+
`0f7771ffb9`「F1/F2 返修：规范化 + 模板断言防重复声明绕过」）给三个 attendance
运维脚本（`attendance-preflight.sh`、`attendance-onprem-env-check.sh`、
`attendance-onprem-bootstrap-admin.sh`）加上了对 `ENCRYPTION_KEY`/`ENCRYPTION_SALT`
的 fail-early 校验，并在取值规范化上做了一轮返修（F1）：比对前先去 `\r`、trim
首尾空白、脱一层成对引号，否则 `ENCRYPTION_KEY="default-key-change-in-production"`
这类写法会在字节级 `==` 比较下被误判成"不是默认值"而放行。

该 PR 的设计文档
`docs/development/ops-encryption-material-preflight-design-20260914.md` 里的
F3 小节明确**登记但不改** `scripts/ops/multitable-onprem-preflight.sh`：实读确认
该脚本同样有 `get_env_value`/`strip_quotes` 取值路径（且 `strip_quotes` 已经处理了
引号和 `\r`，比 F1 返修前的两个 attendance 脚本更完善，但缺 trim 纯空白值这一步），
且**完全没有** `ENCRYPTION_KEY`/`ENCRYPTION_SALT` 检查——这正是本任务（W5-N）
要处理的洞。#5718 的设计文档同时记录了一个与派工指示不一致之处：派工指示称该
脚本"在 pin 集"，但 #5718 实读 `s6a-package-provenance-pins.json` 与
`.gitattributes` 均无 `multitable-onprem-preflight` 匹配，判定"目前不在 pin 集"，
仍按"登记不改"处理，留给后续 PR。本任务（W5-N）就是这个"后续 PR"，按同样的方法
重新核查一遍 pin 集（见下），结论一致，因此可以直接动手，不需要重算 pin。

## Pin 集核查结果

```
$ grep -n "multitable-onprem-preflight" plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
（无匹配）
$ grep -n "multitable-onprem" .gitattributes
80:scripts/ops/multitable-onprem-package-verify.sh text eol=lf
91:scripts/ops/multitable-onprem-package-build.sh text eol=lf
$ grep -n "scripts/ops" plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
（无匹配——pin 集里根本没有 scripts/ops/* 路径）
```

`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
全文 92 行，未出现任何 `scripts/ops/*` 路径。`.gitattributes` 里以
`multitable-onprem-` 开头的两条 `eol=lf` 声明分别是 `multitable-onprem-package-verify.sh`
（不是这次改的文件）和已知"别碰"的 `multitable-onprem-package-build.sh`（本次
同样未改动）。`scripts/ops/multitable-onprem-preflight.sh` 既不在 pin 集也没有
`eol=lf` 声明——**不需要**用 `computePackageProvenancePinSet` 重算 66 项 pin。

## 洞的实读确认

```
$ grep -c ENCRYPTION scripts/ops/multitable-onprem-preflight.sh
0
```

改动前该脚本对 `JWT_SECRET`/`POSTGRES_PASSWORD`/`DATABASE_URL` 等敏感字段都有
`require_nonempty_env`/`require_absolute_path_env` 一类的 fail-early 校验，唯独
`ENCRYPTION_KEY`/`ENCRYPTION_SALT` 完全没有出现在脚本里——洞成立，和派工描述
一致。

## 移植内容

参照 `origin/ops/encryption-material-preflight` 分支上
`scripts/ops/attendance-preflight.sh` 的 `require_encryption_material` 函数
（含 F1 返修后的规范化顺序：去 `\r` → trim 首尾空白 → 脱一层成对引号），同形状
移植进 `scripts/ops/multitable-onprem-preflight.sh`：

1. 变量声明区新增 `ENCRYPTION_KEY=""` / `ENCRYPTION_SALT=""`（对齐既有的
   `JWT_SECRET=""` 等声明风格）。
2. 新增 `require_encryption_material()` 函数，逐字对齐参照分支的规范化逻辑，
   只把 `die` 换成本脚本已有的 `die()`（会先 `write_report "FAIL" "$*"` 再退出，
   逻辑不变，走本脚本既有的 JSON/Markdown 报告管线）。
3. 执行区新增两行取值：`ENCRYPTION_KEY="$(get_env_value ENCRYPTION_KEY)"` /
   `ENCRYPTION_SALT="$(get_env_value ENCRYPTION_SALT)"`——**故意不**先套本脚本
   已有的 `strip_quotes`，因为 `require_encryption_material` 内部自带同等（且顺序
   更完整，多了 trim 一步）的规范化，避免对同一个值做两遍不同顺序的规范化。
   `JWT_SECRET`/`POSTGRES_PASSWORD` 等既有字段继续走 `strip_quotes`，未改动。
4. 执行区新增两行调用：
   `require_encryption_material "ENCRYPTION_KEY" "$ENCRYPTION_KEY" "default-key-change-in-production"`
   `require_encryption_material "ENCRYPTION_SALT" "$ENCRYPTION_SALT" "default-salt-change-in-production"`
   紧跟在 `JWT_SECRET`/`POSTGRES_PASSWORD`/`DATABASE_URL` 的既有校验之后，早于
   `PRODUCT_MODE`/`ENABLE_PLM`/`DEPLOYMENT_MODEL` 等后续检查。
5. 本脚本特有的 `build_suggested_actions` / `build_suggested_command_snippets` /
   `build_suggested_quick_fix_commands` 三个"按 die 消息文本生成运维建议"的
   case 分支（attendance-preflight.sh 没有这一层，是 multitable 脚本自己的既有
   架构），照抄 `JWT_SECRET` 那一档的既有写法（`build_generated_secret_snippet`
   / `build_generate_secret_quick_command`，都是生成新的 `openssl rand -hex 32`
   值并写回 env 文件，不回显旧值）各加一对 `ENCRYPTION_KEY`/`ENCRYPTION_SALT`
   分支，让 FAIL 报告里这两个新增错误和其余字段一样有"Suggested Actions"/
   "One-Line Quick Fix Commands"/"Copyable Command Snippets" 三段，不留成孤儿
   分支（fallthrough 到只有通用的"Rerun preflight"提示）。

## Values-free 约束

`die()` 消息（继承自参照分支原文）只报告变量名与状态："is missing (empty)"
或"uses the insecure built-in default value"，从不回显实际取值；建议动作里统一
建议 `openssl rand -hex 32`。新增的三段 case 分支里 `build_generated_secret_snippet`
生成的是全新随机值并写回 env 文件后 `grep` 校验（这是本脚本对 `JWT_SECRET` 的
既有行为，本次只是复用同一模式，不是新引入回显旧值的风险）。

## 不碰的文件

- `scripts/ops/multitable-onprem-package-build.sh`——按派工指示明确"别碰"，且
  与本次改动的预检脚本是不同文件，未读写。
- `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
  与 `.gitattributes`——pin 核查确认预检脚本不在两者任何一个列表里，未改动，
  未重算 pin。

## 行尾处理

改动前 `scripts/ops/multitable-onprem-preflight.sh` 在 `git show HEAD:<path>`
下是纯 LF（0 个 `\r`），但本地工作区因 `core.autocrlf=true` 而显示为 CRLF（611
行、611 个 `\r`，逐行皆有）。编辑前先 `sed -i 's/\r$//'` 把工作区文件归一成 LF
再做编辑，提交前用 `git show :<path> | tr -cd '\r' | wc -c` 确认暂存内容的 `\r`
计数为 0。
