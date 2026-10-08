# 多维表 on-prem 预检脚本补加密材料 fail-early 验证（2026-09-16）

对应设计文档：
`docs/development/multitable-preflight-encryption-material-design-20260916.md`。

## 语法检查

```
$ bash -n scripts/ops/multitable-onprem-preflight.sh && echo "SYNTAX OK"
SYNTAX OK
```

## Pin 集 / gitattributes 核查（改动前）

```
$ grep -n "multitable-onprem-preflight" plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
（无匹配）
$ grep -n "multitable-onprem-package-build" plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
（无匹配）
$ grep -n "scripts/ops" plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
（无匹配）
$ grep -n "multitable-onprem" .gitattributes
80:scripts/ops/multitable-onprem-package-verify.sh text eol=lf
91:scripts/ops/multitable-onprem-package-build.sh text eol=lf
$ wc -l plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
92 plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
```

结论：`multitable-onprem-preflight.sh` 不在 pin 集、也没有 `eol=lf` 声明，
`plugins/plugin-integration-core/index.cjs`、`lib/http-routes.cjs`、
`lib/sealed-export/*`、`.github/workflows/plugin-tests.yml` 均未改动，
无需运行 `computePackageProvenancePinSet` 重算 pin。

## 洞的实读确认（改动前）

```
$ grep -c ENCRYPTION scripts/ops/multitable-onprem-preflight.sh
0
```

## 行尾处理

```
$ git config --get core.autocrlf
true
$ tr -cd '\r' < scripts/ops/multitable-onprem-preflight.sh | wc -c   # 编辑前，工作区视图
611
$ git show HEAD:scripts/ops/multitable-onprem-preflight.sh | tr -cd '\r' | wc -c   # 仓库内已存储的内容
0
$ sed -i 's/\r$//' scripts/ops/multitable-onprem-preflight.sh
$ tr -cd '\r' < scripts/ops/multitable-onprem-preflight.sh | wc -c   # 归一后
0
```

仓库里原本就是纯 LF 存储（`core.autocrlf=true` 只是让本地检出视图带 CRLF），
`sed` 归一化后再编辑，全程保持工作区为 LF。

## 改动后语法与行数

```
$ bash -n scripts/ops/multitable-onprem-preflight.sh && echo "SYNTAX OK"
SYNTAX OK
$ tr -cd '\r' < scripts/ops/multitable-onprem-preflight.sh | wc -c
0
$ git diff --stat -- scripts/ops/multitable-onprem-preflight.sh
 scripts/ops/multitable-onprem-preflight.sh | 55 ++++++++++++++++++++++++++++++
 1 file changed, 55 insertions(+)
```

纯新增 55 行，无删除、无改动既有行。

## 用例验证

用 `<scratchpad>/w5n/test-cases.sh` 构造 6 组临时 env 文件（其余字段全部给出
合法值，`REQUIRE_STORAGE_DIRS=0` 跳过磁盘目录检查以聚焦加密材料校验），逐组
用 `ENV_FILE=<临时文件> REQUIRE_STORAGE_DIRS=0 bash scripts/ops/multitable-onprem-preflight.sh`
跑一遍并比对期望的 die/pass：

```
=== CASE: empty -> exit=1 outcome=die expect=die OK ===
[multitable-onprem-preflight] ERROR: ENCRYPTION_KEY is missing (empty) in .../case-empty.env. Generate one with: openssl rand -hex 32

=== CASE: default-unquoted -> exit=1 outcome=die expect=die OK ===
[multitable-onprem-preflight] ERROR: ENCRYPTION_KEY uses the insecure built-in default value in .../case-default-unquoted.env. Generate one with: openssl rand -hex 32

=== CASE: default-dquoted -> exit=1 outcome=die expect=die OK ===
[multitable-onprem-preflight] ERROR: ENCRYPTION_KEY uses the insecure built-in default value in .../case-default-dquoted.env. Generate one with: openssl rand -hex 32

=== CASE: empty-dquotes -> exit=1 outcome=die expect=die OK ===
[multitable-onprem-preflight] ERROR: ENCRYPTION_KEY is missing (empty) in .../case-empty-dquotes.env. Generate one with: openssl rand -hex 32

=== CASE: normal -> exit=0 outcome=pass expect=pass OK ===
[multitable-onprem-preflight] Env file: .../case-normal.env
[multitable-onprem-preflight] ENABLE_PLM: 1
[multitable-onprem-preflight] Import upload dir: /opt/metasheet/storage/attendance-import
[multitable-onprem-preflight] Attachment path: /opt/metasheet/storage/attachments
[multitable-onprem-preflight] Attachment base URL: https://files.example.com/uploads

=== CASE: salt-default-squoted -> exit=1 outcome=die expect=die OK ===
[multitable-onprem-preflight] ERROR: ENCRYPTION_SALT uses the insecure built-in default value in .../case-salt-default-squoted.env. Generate one with: openssl rand -hex 32
```

6/6 用例符合预期：空值、双引号包裹的空值、内置默认哨兵（裸写/双引号/单引号）
都 fail-early 且不回显值；两个字段都给合法随机值时通过整个预检并进入
`Preflight OK`。

## 变异测试

删除 `require_encryption_material` 内脱引号那一段（`if (( ${#value} >= 2 ))`
到对应 `fi` 共 5 行，用 `sed -i '587,591d'` 精确删除），保留去 `\r`/trim 两步，
`bash -n` 仍通过语法检查，重跑双引号/单引号哨兵两个用例：

```
=== CASE: default-dquoted -> exit=0 outcome=pass expect=die MISMATCH(expected=die got=pass) ===
[multitable-onprem-preflight] Env file: .../case-default-dquoted.env
=== CASE: salt-default-squoted -> exit=0 outcome=pass expect=die MISMATCH(expected=die got=pass) ===
[multitable-onprem-preflight] Env file: .../case-salt-default-squoted.env
```

两个用例从 die 变成假绿（exit=0，一路跑到 `Preflight OK`），证明脱引号这一步
是这条校验链上真正生效、不可省略的一环，不是摆设。随后用
`<scratchpad>/w5n/preflight-backup.sh`（变异前的完整备份）覆盖还原：

```
$ cp <scratchpad>/w5n/preflight-backup.sh scripts/ops/multitable-onprem-preflight.sh
$ bash -n scripts/ops/multitable-onprem-preflight.sh && echo "SYNTAX OK"
SYNTAX OK
$ tr -cd '\r' < scripts/ops/multitable-onprem-preflight.sh | wc -c
0
$ git diff --stat -- scripts/ops/multitable-onprem-preflight.sh
 scripts/ops/multitable-onprem-preflight.sh | 55 ++++++++++++++++++++++++++++++
 1 file changed, 55 insertions(+)
```

还原后重跑全部 6 组用例，结果与"改动后"一节一致（全部 OK，无 MISMATCH）：

```
=== CASE: empty -> exit=1 outcome=die expect=die OK ===
=== CASE: default-unquoted -> exit=1 outcome=die expect=die OK ===
=== CASE: default-dquoted -> exit=1 outcome=die expect=die OK ===
=== CASE: empty-dquotes -> exit=1 outcome=die expect=die OK ===
=== CASE: normal -> exit=0 outcome=pass expect=pass OK ===
=== CASE: salt-default-squoted -> exit=1 outcome=die expect=die OK ===
```

## 范围外确认

```
$ git status --porcelain
```
（仅列出本任务改动的 3 个文件：预检脚本 + 本设计文档 + 本验证文档；未触碰
`packages/`、`plugins/`、`.github/`、任何 `.ps1` 文件、
`scripts/ops/multitable-onprem-package-build.sh`。）
