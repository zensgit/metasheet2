# On-prem/staging 运维预检:加密材料 fail-early (2026-09-14)

## 背景

PR #5711(生产环境默认 `ENCRYPTION_KEY`/`ENCRYPTION_SALT` fail-closed)只在后端首次
存密时才会抛错——这是「延迟爆炸」:如果装机现场没有在部署前就配好这两个变量,
问题要等到第一次真正加密写入才会被发现,而不是在预检阶段。

本任务给装机现场的三个运行时预检脚本,以及打包侧的一个静态断言脚本,补上对
`ENCRYPTION_KEY`/`ENCRYPTION_SALT` 的 fail-early 校验,让运维在 `docker compose up`
之前就能发现问题,而不是等首次写密时才炸。

内置的不安全默认哨兵值(`packages/core-backend/src/security/encrypted-secrets.ts`):

```ts
function getEncryptionSalt(): Buffer {
  return Buffer.from(process.env.ENCRYPTION_SALT || 'default-salt-change-in-production')
}
function getEncryptionKey(): Buffer {
  const masterKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production'
  ...
}
```

`packages/core-backend/src/services/ConfigService.ts:385-390` 有完全相同的两行哨兵
（当前是唯二引用处，经 grep 全仓确认）。

## 实读的真实路径(与任务描述中的占位路径对照)

任务描述里写的 `bootstrap-admin.sh` 和 `package-verify.sh` 是简写;实读
`git ls-files` 后确认的真实文件名和函数位置(均以本次改动前、origin/main
HEAD `acd24ca4c` 为基准):

| 任务描述里的名字 | 仓库里的真实路径 | 相关行号(改动前) |
| --- | --- | --- |
| `attendance-preflight.sh` | `scripts/ops/attendance-preflight.sh` | JWT 校验在 23-34、83-94 |
| `attendance-onprem-env-check.sh` | `scripts/ops/attendance-onprem-env-check.sh` | JWT 校验在 17-28、57-67 |
| `bootstrap-admin.sh` | `scripts/ops/attendance-onprem-bootstrap-admin.sh` | JWT 校验在 22-33、调用点在 81 |
| `package-verify.sh` 的 `verify_onprem_env_templates` | `scripts/ops/attendance-onprem-package-verify.sh` | 函数体在 77-88 |

（`multitable-onprem-package-verify.sh` 也有类似字样但**不在本任务范围**,见下方
pin 核查一节。）

## 两层断言设计

### 第一层:运行时预检脚本(三个)

在既有 `require_strong_jwt_secret` / `require_bcrypt_salt_rounds` 旁边,照抄相同
形状加一个 `require_encryption_material(var_name, value, default_sentinel)`:

```bash
function require_encryption_material() {
  local var_name="$1"
  local value="$2"
  local default_sentinel="$3"
  [[ -n "$value" ]] || die "${var_name} is missing (empty) in ${ENV_FILE}. Generate one with: openssl rand -hex 32"
  if [[ "$value" == "$default_sentinel" ]]; then
    die "${var_name} uses the insecure built-in default value in ${ENV_FILE}. Generate one with: openssl rand -hex 32"
  fi
}
```

分别用 `ENCRYPTION_KEY` / `default-key-change-in-production` 和
`ENCRYPTION_SALT` / `default-salt-change-in-production` 调两次。三个脚本的取值
方式不同,照抄各脚本原有风格:

- `attendance-preflight.sh` / `attendance-onprem-env-check.sh`:走脚本自带的
  `get_env_value KEY`(逐行 grep `ENV_FILE`,不 `source`,避免值里带 `#` 等字符
  出问题),和 `JWT_SECRET`/`BCRYPT_SALT_ROUNDS` 完全同一取值路径。
- `attendance-onprem-bootstrap-admin.sh`:这个脚本本来就用 `load_env_file`
  (`set -a; source "$ENV_FILE"; set +a`)把整份 env 文件灌进真实环境变量,所以
  直接用 `${ENCRYPTION_KEY:-}` / `${ENCRYPTION_SALT:-}`,和已有的
  `${JWT_SECRET:-}` 用法一致。

三处校验都不回显被检查的值本身——错误信息只说变量名 + "为空/为默认值",并给出
生成建议 `openssl rand -hex 32`(生成 64 个十六进制字符,对应 32 字节,可直接
喂给 `ENCRYPTION_KEY`;`ENCRYPTION_SALT` 同一命令即可,业务上无需是不同长度)。

### 第二层:打包侧静态断言(`verify_onprem_env_templates`)

`scripts/ops/attendance-onprem-package-verify.sh` 里的
`verify_onprem_env_templates` 校验出厂随包模板
(`docker/app.env.attendance-onprem.template`、
`docker/app.env.attendance-onprem.ready.env`),原本只断言
`JWT_SECRET=change-me` 和 `BCRYPT_SALT_ROUNDS=12` 两行必须原样存在。

**关键约束:本任务基于 origin/main,PR #5711 给五个模板加 `ENCRYPTION_KEY=`
/ `ENCRYPTION_SALT=` 空值占位的那次改动还没合并进来。** 实读确认(见下方
"当前仓库状态" 一节),当前两份模板文件里完全没有 `ENCRYPTION_KEY`/
`ENCRYPTION_SALT` 这两行。如果断言写成"模板必须含有这两行",在 #5711 合并之前
这条断言在当前分支上就是恒假(每次跑 `package-verify` 都会失败),不满足
"两种状态下都说得通"的要求。

所以采用任务描述里给出的优先方案——两层断言里的第二层写成条件式:

```bash
if grep -q '^ENCRYPTION_KEY=' "$abs"; then
  grep -q '^ENCRYPTION_KEY=$' "$abs" || die "${rel} must keep ENCRYPTION_KEY empty (no real value committed to template)"
fi
if grep -q '^ENCRYPTION_SALT=' "$abs"; then
  grep -q '^ENCRYPTION_SALT=$' "$abs" || die "${rel} must keep ENCRYPTION_SALT empty (no real value committed to template)"
fi
```

含义:**不要求**模板必须声明 `ENCRYPTION_KEY`/`ENCRYPTION_SALT`(兼容 #5711 未
合并的当前状态,以及 #5711 合并后的将来状态);但**如果**模板声明了,值必须
恰好为空(`KEY=`,不能是 `KEY=` 后面跟着别的字符),防止有人手滑把一个真实密钥
提交进随包出厂的模板文件——模板文件会被打进发货包,分发给客户现场,任何真实
值提交进去都是密钥泄漏。

这条断言在 #5711 合并前后都成立,不依赖合并顺序,叠加关系是纯增量的:
#5711 给模板加空值占位行之后,这条新断言会开始真正发挥作用(拦截"占位行被改
成了真实值"这种回归);#5711 合并之前,断言退化成"没有这两行就不检查",不会
误伤当前状态。

### 当前仓库状态(实读确认,供将来对照)

```
$ grep -n "^ENCRYPTION_" docker/app.env.attendance-onprem.template docker/app.env.attendance-onprem.ready.env docker/app.env.example docker/app.env.multitable-onprem.template docker/app.staging.env.example
(无匹配 — 五个模板文件目前都不含 ENCRYPTION_KEY/ENCRYPTION_SALT 行)
```

## 为什么不改 `validate-windows-runtime.ps1`

`validate-windows-runtime.ps1:145-164` 对同样两个默认哨兵只 WARN,不 die。这是
另一支 PR 的范围(任务描述明确排除),本任务未触碰该文件。原因除了任务边界之外,
也因为 ps1 走的是 Windows 直接部署路径,和本任务覆盖的 Linux/Docker on-prem
预检脚本(bash)属于两条不同的装机路径,改动应该分开评审、分开验证。

## Pin 核查结果

`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
和 `.gitattributes` 中搜索本任务涉及的四个脚本名(`attendance-preflight`、
`attendance-onprem-env-check`、`attendance-onprem-bootstrap-admin`、
`attendance-onprem-package-verify`):

```
$ grep -n -E 'attendance-preflight|attendance-onprem-env-check|attendance-onprem-bootstrap-admin|attendance-onprem-package-verify' \
    plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
(无匹配)

$ grep -n -i 'attendance' plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
(无匹配)

$ grep -n -E 'attendance-preflight|attendance-onprem-env-check|attendance-onprem-bootstrap-admin|attendance-onprem-package-verify|scripts/ops' .gitattributes
1:scripts/ops/stock-preparation-prep-line-extended-smoke.mjs text eol=lf
2:scripts/ops/stock-preparation-mvp-postdeploy-smoke.mjs text eol=lf
3:scripts/ops/stock-preparation-rca-window-pm2-sample.mjs text eol=lf
78:scripts/ops/stock-preparation-s6a-onprem-acceptance.ps1 text eol=lf
80:scripts/ops/multitable-onprem-package-verify.sh text eol=lf
84:scripts/ops/run-sealed-export-s5-sqlserver-evidence.cjs text eol=lf
85:scripts/ops/verify-sealed-export-s5-sqlserver-evidence.cjs text eol=lf
89:scripts/ops/__tests__/stock-preparation-s6a-onprem-acceptance.ps51.tests.ps1 text eol=lf
91:scripts/ops/multitable-onprem-package-build.sh text eol=lf
```

结论:本次改动的四个脚本都**不在** pin 集,也不在 `.gitattributes` 的 `eol=lf`
清单里。`.gitattributes` 里唯一命中"onprem-package-verify"字样的是
`scripts/ops/multitable-onprem-package-verify.sh`(multitable 侧,和本任务的
`attendance-onprem-package-verify.sh` 是两个不同文件),以及被任务明确点名
"别碰"的 `multitable-onprem-package-build.sh`——两者均未改动。因此本次改动无需
重算 `computePackageProvenancePinSet`。

## 行级改动汇总

四个脚本均为纯增量(diff 无删除行),改动前后都通过 `bash -n` 语法检查:

- `scripts/ops/attendance-preflight.sh`:+18 行(新增 `require_encryption_material`
  函数 + 取值 + 两次调用)。
- `scripts/ops/attendance-onprem-env-check.sh`:+18 行(同上)。
- `scripts/ops/attendance-onprem-bootstrap-admin.sh`:+16 行(函数定义比另外两个
  脚本短两行,因为不需要额外的 `get_env_value` 调用——直接用 `load_env_file`
  灌进来的环境变量)。
- `scripts/ops/attendance-onprem-package-verify.sh`:+11 行(`verify_onprem_env_templates`
  函数体内加两个条件式 `if` 块)。

## 行尾处理

四个脚本在 git 对象库里存的是 LF(`git show HEAD:<path> | grep -c $'\r'` = 0),
仓库里没有针对这四个文件的 `.gitattributes` 覆写,working tree 里能看到 CRLF
纯粹是本机 `core.autocrlf=true` 在 checkout 时做的转换。编辑前用
`sed -i 's/\r$//'` 把 working tree 恢复成单一 LF 再编辑,保证新增行和原有行的
换行风格一致;提交时 `core.autocrlf=true` 会继续按 LF 存入对象库,不引入混合
换行。

## 轻核返修(PR #5718,HEAD `ced5a84fa` 已推送后)

### F1(高,必修):`require_encryption_material` 的 `==` 比对没有规范化取值

`attendance-preflight.sh`/`attendance-onprem-env-check.sh` 里的 `get_env_value`
只做 `${line#KEY=}` 这种纯字符串前缀裁剪——不脱引号、不 trim 空白、不去
`\r`。而 `require_encryption_material` 拿到这个原始值后直接 `==` 字符串比对。
这意味着以下写法在这两个脚本里都会被**误放行**(实测确认,见验证文档):

- `ENCRYPTION_KEY="default-key-change-in-production"`(双引号包住哨兵)
- `ENCRYPTION_KEY='default-key-change-in-production'`(单引号包住哨兵)
- `ENCRYPTION_KEY=""`(引号包住的空值——两个引号字符本身让字符串非空)
- `ENCRYPTION_KEY=   `(只有空白,没有值)
- 哨兵字面量后面拖着一个 `\r`(CRLF 保存的 env 文件里,行内容本身含 `\r`;
  在 Linux 上标准 GNU grep 不会自动剥掉这个 `\r`,会原样传下来)

而这份 env 文件真正的运行时语义是 `docker compose --env-file` 或
`attendance-onprem-bootstrap-admin.sh` 的 `source` ——两者都会按 shell/dotenv
解析规则脱引号、忽略首尾空白;上述五种写法在**真实运行时**其实就是「哨兵值」
或「空值」,只是我们自己写的这个简化版 `get_env_value` 没有做同样的规范化,
导致预检脚本对同一份 env 文件的判断和运行时实际吃到的值不一致——预检说
"OK",运行时其实在用不安全的默认哨兵。`attendance-onprem-bootstrap-admin.sh`
因为本来就走 `source`,这五种写法在它那里从建立时起就已经正确 die,不受此
问题影响。

修法:在 `require_encryption_material` 比对前,对拿到的 `value` 做三步规范化
(顺序:先去 `\r`,再 trim 首尾空白,再脱一层成对引号),之后才做空值/哨兵
判断:

```bash
value="${value%$'\r'}"
value="${value#"${value%%[![:space:]]*}"}"
value="${value%"${value##*[![:space:]]}"}"
if (( ${#value} >= 2 )); then
  if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
    value="${value:1:-1}"
  fi
fi
```

只改了 `attendance-preflight.sh` 和 `attendance-onprem-env-check.sh` 里的
`require_encryption_material` 函数体;`attendance-onprem-bootstrap-admin.sh`
的同名函数不用动(它接收到的 `${ENCRYPTION_KEY:-}` 已经是 `source` 解析后的
干净值)。

**JWT 同形状洞(记录,不动)**:`require_strong_jwt_secret` 在这两个脚本里
拿到的 `secret` 同样是 `get_env_value` 的原始输出,同样没有脱引号/trim/去
`\r`,存在与 `ENCRYPTION_KEY`/`SALT` 完全相同的漏判形状(比如
`JWT_SECRET="change-me"` 大概率也会被误放行)。这次任务范围只是给
`JWT_SECRET` 校验"照抄形状"加 `ENCRYPTION_*` 校验,不包含修 `JWT_SECRET`
自己这个既有洞——按返修指示不动它,留给后续 PR。

### F2(中):`verify_onprem_env_templates` 的空值断言可被重复声明绕过

原断言 `grep -q '^ENCRYPTION_KEY=$'` 只要求"至少一行匹配空占位",不要求
"每一行都是空占位"。如果模板文件里同时出现:

```
ENCRYPTION_KEY=
ENCRYPTION_KEY=abcdef0123456789abcdef0123456789
```

`grep -q '^ENCRYPTION_KEY='` 命中(存在声明)→ 进入 if 体;
`grep -q '^ENCRYPTION_KEY=$'` 命中第一行(空占位)就返回真 → 断言通过 → 第
二行的真实值被放过。

修法:改成"取出所有 `^ENCRYPTION_KEY=` 开头的行,再用 `-v` 排除掉恰好是空
占位(允许尾随空白/`\r`)的行,如果还剩下任何一行,就说明存在非空声明,
die":

```bash
if grep -qE '^ENCRYPTION_KEY=' "$abs"; then
  if grep -E '^ENCRYPTION_KEY=' "$abs" | grep -vqE '^ENCRYPTION_KEY=[[:space:]]*$'; then
    die "${rel} must keep every ENCRYPTION_KEY= line empty (no real value committed to template)"
  fi
fi
```

`[[:space:]]*$`(而不是裸 `$`)顺带把「尾随空白」和「CRLF 保存留下的
`\r`」也一起容忍掉,不需要单独处理。`ENCRYPTION_SALT` 同形状处理。

**当前覆盖率为零,如实记录**:改动前后,`docker/app.env.attendance-onprem.template`
和 `docker/app.env.attendance-onprem.ready.env` 两个真实模板文件里都**没有**
`ENCRYPTION_KEY=`/`ENCRYPTION_SALT=` 这两行(#5711 的模板占位改动还没合并
进来,见前一节"当前仓库状态")。也就是说这条修复后的断言,在当前分支上,
`if grep -qE '^ENCRYPTION_KEY='` 这个门槛条件本身就是假,断言函数体在这个
PR 范围内实际执行次数是零——只有在 #5711 合并、模板真的声明了这两个变量之后,
这条断言才会被真实数据触发。本机验证是在临时构造的模板副本上做的(加占位行 /
加真值行 / 双声明同时存在),不是对真实模板文件的正向覆盖测试,见验证文档。

**新增 `docker/app.env.example` 覆盖(判断记录)**:检查
`attendance-onprem-package-verify.sh` 的 `required=()` 数组,确认
`docker/app.env.example` 确实是随 attendance on-prem 包一起分发的必需文件
(和另外两个已检查的模板一样会打进发货包)。把它加进了 `ENCRYPTION_KEY`/
`ENCRYPTION_SALT` 的检查清单——**但没有**把它加进 `JWT_SECRET=change-me`/
`BCRYPT_SALT_ROUNDS=12` 的检查清单,因为 `docker/app.env.example` 目前只有
`JWT_SECRET=change-me` 一行,没有 `BCRYPT_SALT_ROUNDS` 行,如果原样并入那个
循环会立刻因为一个和本次任务无关的既有原因(`BCRYPT_SALT_ROUNDS` 缺失)而
die,把范围外的失败引入这个 PR。这是我做的一个判断:把函数拆成两个独立的
`for` 循环,JWT/BCRYPT 循环维持原来两个文件不变,ENCRYPTION 循环扩到三个
文件。如果协调方希望 `docker/app.env.example` 也补上 `BCRYPT_SALT_ROUNDS`
占位行本身,那是另一个独立的改动,这次没有做。

### F3(登记,不改):`scripts/ops/multitable-onprem-preflight.sh`

实读确认该脚本同样用 `get_env_value`(其实现比本次改的两个脚本更完善——
它本来就有一个 `strip_quotes()` 辅助函数,在赋值时统一包一层
`strip_quotes "$(get_env_value KEY)"`,已经处理了引号和 `\r`,但**没有**
trim 纯空白值这一步),且完全没有 `ENCRYPTION_KEY`/`ENCRYPTION_SALT` 检查。

关于返修指示里说它"在 pin 集"——本次实读核对
`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
和 `.gitattributes`,搜索 `multitable-onprem-preflight` 均无匹配;pin
集/`.gitattributes` 里出现的 `multitable-onprem-*` 只有
`multitable-onprem-package-verify.sh` 和 `multitable-onprem-package-build.sh`
两个(都是不同的文件)。如实记录这个差异:按我自己核对到的证据,这个文件
**目前不在** pin 集里,不需要重算 pin 就能改。但按返修指示"登记不改",本次
仍然不碰它,只登记进这份文档,留给后续 PR 处理(处理前建议再核一次 pin
集,因为这份记录本身可能随时间变化)。

### F4(注记,不改):`attendance-onprem-bootstrap-admin.sh` 的 `source "$ENV_FILE"`

`load_env_file()` 用 `set -a; source "$ENV_FILE"; set +a` 把整份 env 文件当
shell 脚本执行。如果 env 文件里某一行写成 `SOME_VAR=$(curl ...)` 这种命令
替换形式,`source` 会真的执行这条命令。这是该脚本既有的行为,不是本次
W5-G/返修引入的,超出本次任务范围,不改;记录在此供后续单独评估(风险取决于
env 文件的写入/审核权限模型,不属于本 PR 判断范围)。
