# On-prem/staging 运维预检:加密材料 fail-early — 验证记录 (2026-09-14)

工作目录:`C:/Users/zhou/Downloads/dev/metasheet-wt-w5g`(独立 worktree,分支
`ops/encryption-material-preflight`,基于 `origin/main` HEAD `acd24ca4c`)。

## 方法说明

四个脚本里,`attendance-preflight.sh`(依赖真实 `docker-compose.app.yml` /
`docker/nginx.conf`)和 `attendance-onprem-env-check.sh`(只依赖 env 文件)可以
端到端整体跑通,用 `ENV_FILE=<临时 env 文件>` 覆盖默认路径即可,不需要抽取。

`attendance-onprem-bootstrap-admin.sh` 在 `require_encryption_material` 之前会
先 `require_cmd psql`,本机没装 `psql`;为了端到端复现"先于 DB 操作 die"这个
真实调用顺序,给 `psql` 做了一个只打印一行、`exit 0`(用不到)的桩程序放到
`PATH` 最前面,而不是抽函数——这样能验证到"函数调用点的变量名是否接对"这一层,
是比纯函数级单测更强的证据。对于"valid"(全部合法值)case,验证到脚本真正跑过
了 `require_encryption_material` 两次调用(没有 die 在这里),并往后推进到
`bcryptjs` 缺失这个与本次改动无关的既有环境依赖问题为止——这证明加密材料检查
本身没有挡住合法路径。

`attendance-onprem-package-verify.sh` 的 `verify_onprem_env_templates` 需要一个
完整的解包后的发货目录结构外加一个真实 tgz/zip 包才能端到端触发,成本过高;
按任务允许的方式,用 `sed -n '<行段>p'` 把 `die()` 和
`verify_onprem_env_templates()` 两个函数原样抽出来 `source`,直接用构造的
`docker/app.env.attendance-onprem.template` / `.ready.env` 调用该函数——这是纯
函数级测试,但因为是原样抽取(不重写逻辑),等价于跑真实函数体。

所有测试用的临时文件都在
`C:/Users/zhou/AppData/Local/Temp/claude/C--Users-zhou-Downloads-dev-metasheet/5691483c-86cd-455b-a556-03918552e220/scratchpad/w5g/`
下,不在仓库或 worktree 内。

## 1. `bash -n` 语法检查(四个脚本,改动后)

```
$ bash -n scripts/ops/attendance-preflight.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-env-check.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-bootstrap-admin.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-package-verify.sh && echo OK
OK
```

## 2. `attendance-preflight.sh` 端到端

固定用真实 `docker-compose.app.yml`(未暴露 5432/6379)和 `docker/nginx.conf`
(已有 `location /api/attendance/import/upload { client_max_body_size 120m; }`),
只换 `ENV_FILE`。合法 fixture 里其余字段(`JWT_SECRET`、`BCRYPT_SALT_ROUNDS=12`、
`POSTGRES_PASSWORD`、`DATABASE_URL`、`ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`、
`ATTENDANCE_IMPORT_UPLOAD_DIR=/app/uploads/attendance-import`、
`ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000`)全部合法,只让
`ENCRYPTION_KEY`/`ENCRYPTION_SALT` 在四个 case 间变化。

- **valid**(64 位十六进制 key + salt):
  ```
  [attendance-preflight] Preflight OK
  exit=0
  ```
- **empty key**(整行删掉):
  ```
  [attendance-preflight] ERROR: ENCRYPTION_KEY is missing (empty) in <path>. Generate one with: openssl rand -hex 32
  exit=1
  ```
- **empty salt**:
  ```
  [attendance-preflight] ERROR: ENCRYPTION_SALT is missing (empty) in <path>. Generate one with: openssl rand -hex 32
  exit=1
  ```
- **default key**(`ENCRYPTION_KEY=default-key-change-in-production`):
  ```
  [attendance-preflight] ERROR: ENCRYPTION_KEY uses the insecure built-in default value in <path>. Generate one with: openssl rand -hex 32
  exit=1
  ```
- **default salt**(`ENCRYPTION_SALT=default-salt-change-in-production`):
  ```
  [attendance-preflight] ERROR: ENCRYPTION_SALT uses the insecure built-in default value in <path>. Generate one with: openssl rand -hex 32
  exit=1
  ```

四条错误信息都只提变量名和"为空/为默认值",没有回显被检查的值本身。

## 3. `attendance-onprem-env-check.sh` 端到端

同一批 fixture,直接 `ENV_FILE=<fixture> bash scripts/ops/attendance-onprem-env-check.sh`
(此脚本不依赖 compose/nginx)。

```
valid  -> [attendance-onprem-env-check] Env check OK (REQUIRE_ATTENDANCE_ONLY=1)   exit=0
empty key   -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...   exit=1
empty salt  -> ERROR: ENCRYPTION_SALT is missing (empty) in <path>. ...  exit=1
default key -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value ...  exit=1
default salt-> ERROR: ENCRYPTION_SALT uses the insecure built-in default value ... exit=1
```

## 4. `attendance-onprem-bootstrap-admin.sh` 端到端(桩 `psql`)

```
$ ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SuperSecretPW123 VERIFY_LOGIN=0 \
  ENV_FILE=<empty-key fixture> \
  PATH=<桩bin>:$PATH bash scripts/ops/attendance-onprem-bootstrap-admin.sh
[attendance-onprem-bootstrap-admin] ERROR: ENCRYPTION_KEY is missing (empty) in <path>. Generate one with: openssl rand -hex 32
exit=1
```

四个 die case(empty key / empty salt / default key / default salt)全部在
`require_cmd psql`(用桩程序通过)之后、任何真实 SQL 语句执行之前就 die,错误
信息与另外两个脚本同形状。

**valid** case:
```
$ ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=SuperSecretPW123 VERIFY_LOGIN=0 \
  ENV_FILE=<valid fixture> \
  PATH=<桩bin>:$PATH bash scripts/ops/attendance-onprem-bootstrap-admin.sh
...
Error: Cannot find module 'bcryptjs'
    at ... [eval]:2:20
exit=1
```
`require_encryption_material` 两次调用都没有 die(否则不会跑到 `node -e` 那一
步),脚本推进到了生成 admin 用户 UUID、再尝试用 `bcryptjs` 做密码哈希这一步才
失败——这是因为本 worktree 按任务要求没有跑 `pnpm install`,`node_modules` 里没
有 `bcryptjs`,与本次改动无关,证明加密材料检查本身放行了合法输入。

补充:实测中先用 Windows 风格路径(`C:/...`)放桩 `psql`,`command -v psql`
在 MSYS bash 下找不到;换成 MSYS 风格路径(`/c/...`)后 `command -v` 立即命中。
这是 Git Bash 的已知怪癖,和脚本改动本身无关,记在这里避免下次重复踩坑。

## 5. `attendance-onprem-package-verify.sh` 的 `verify_onprem_env_templates`(抽函数)

抽取 `die()` + `verify_onprem_env_templates()` 到
`scratchpad/w5g/pkgverify-segment.sh`,`bash -n` 通过后 `source` 并对四个构造的
包根目录调用:

```
pkgroot-noenc    (模板里完全没有 ENCRYPTION_KEY/SALT 行,即当前真实仓库状态)
  -> PASSED (no die)   exit=0

pkgroot-emptyenc (ENCRYPTION_KEY= / ENCRYPTION_SALT= 空值占位)
  -> PASSED (no die)   exit=0

pkgroot-realkey  (ENCRYPTION_KEY=abcdef0123456789abcdef0123456789)
  -> ERROR: docker/app.env.attendance-onprem.template must keep ENCRYPTION_KEY empty (no real value committed to template)
  exit=1

pkgroot-realsalt (ENCRYPTION_SALT=0123456789abcdef0123456789abcdef)
  -> ERROR: docker/app.env.attendance-onprem.template must keep ENCRYPTION_SALT empty (no real value committed to template)
  exit=1
```

另外直接对**真实仓库**的两个模板文件跑了一次同一函数(把 repo 根目录整个当
`root` 传进去),确认当前(#5711 未合并)状态下不会被误伤:

```
$ bash -c "source pkgverify-segment.sh; verify_onprem_env_templates '<repo root>'; echo PASSED"
PASSED against real repo templates (no die)
exit=0
```

## 6. 变异测试(mutation)

对 `scripts/ops/attendance-preflight.sh` 里 `default-key-change-in-production`
字面量故意改错一个字符(末尾加 `X`),预期:default-key 这个 die case 应该
"假绿"(不再 die),证明这条断言真的在对比这个字面量,而不是碰巧因为别的原因
die。

```
# 改动前(baseline,见上面第 2 节):default key -> die, exit=1

# 变异后:
$ ENV_FILE=<default-key fixture> bash scripts/ops/attendance-preflight.sh
...
[attendance-preflight] Preflight OK
exit=0          # 红:本该 die 却放行了,证明变异有效、测试有意义
```

变异后立即用备份文件还原(`cp <备份> scripts/ops/attendance-preflight.sh`),
`grep` 确认字面量恢复为 `default-key-change-in-production`,重新 `bash -n`
通过,再跑一次 default-key fixture 确认恢复到 `die, exit=1`(见上面第 2 节
最后一次运行的实际输出,是变异-还原之后重新跑出来的,不是缓存结果)。

## 结论

- 四个脚本改动均通过 `bash -n`。
- 三个运行时预检脚本对空值/默认哨兵都正确 die,错误信息 values-free,正常值
  放行。
- 打包侧 `verify_onprem_env_templates` 对"没有该行"和"空值占位"两种状态都放行
  (兼容 #5711 未合并/已合并两种状态),对"真实值被提交进模板"正确拦截。
- 变异测试证明 die 分支是真的在比对哨兵字面量,不是巧合触发。

## 轻核返修验证(PR #5718,HEAD `ced5a84fa` 之后的追加提交)

### `bash -n`(四脚本,F1/F2 改动后)

```
$ bash -n scripts/ops/attendance-preflight.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-env-check.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-bootstrap-admin.sh && echo OK
OK
$ bash -n scripts/ops/attendance-onprem-package-verify.sh && echo OK
OK
```

### F1:五种形状,端到端(`attendance-preflight.sh`)

固定用 `env-valid.env` 为底板,只替换 `ENCRYPTION_KEY=` 那一行:

```
f1-dquote-sentinel (ENCRYPTION_KEY="default-key-change-in-production")
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in <path>. ...
  exit=1

f1-squote-sentinel (ENCRYPTION_KEY='default-key-change-in-production')
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in <path>. ...
  exit=1

f1-quoted-empty (ENCRYPTION_KEY="")
  -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...
  exit=1

f1-whitespace-only (ENCRYPTION_KEY=   )
  -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...
  exit=1

f1-sentinel-cr (ENCRYPTION_KEY=default-key-change-in-production\r, 该行单独 CRLF)
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in <path>. ...
  exit=1
```

`attendance-onprem-env-check.sh` 对前四种形状重跑一遍,结果同形状(die
消息里的脚本前缀不同,判断逻辑相同):

```
f1-dquote-sentinel -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value ...  exit=1
f1-squote-sentinel -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value ...  exit=1
f1-quoted-empty    -> ERROR: ENCRYPTION_KEY is missing (empty) ...                        exit=1
f1-whitespace-only -> ERROR: ENCRYPTION_KEY is missing (empty) ...                        exit=1
env-valid(control) -> Env check OK (REQUIRE_ATTENDANCE_ONLY=1)                            exit=0
```

**关于 `f1-sentinel-cr` 的一个平台说明**:直接实测发现,本机(Windows Git
Bash,GNU grep 3.0)的 `grep -E "^ENCRYPTION_KEY=" file` 在文件该行是 CRLF
而文件其余部分是 LF 的混合场景下,会**自己先把尾随 `\r` 吞掉**才输出匹配
行——用 `od -c`/`cat -A` 直接看原始文件字节,确认 `\r` 真的写进了文件
(`ENCRYPTION_KEY=default-key-change-in-production^M$`),但同一份文件经过
`grep -E ... | tail -n 1 | od -c` 之后 `\r` 就没了。这是本机这个 grep 构建
的一个平台特性,不是我们代码的行为;返修需求里点名的"Linux grep 保留
CR"场景,在标准 Linux/GNU grep 环境下 `\r` 不会被自动吞掉,`require_encryption_material`
拿到的 `value` 就会真的带着尾随 `\r`。因为本机没法用真实 grep 调用复现这
条路径,改用**函数级直测**绕过 grep,直接把带 `\r` 的字符串喂给
`require_encryption_material`(见下一节),这是对 `value="${value%$'\r'}"`
这一行代码本身的直接验证,不依赖某个平台的 grep 是否已经替我们把 `\r` 处理掉。

### F1:函数级直测(绕开本机 grep 的 CRLF 特性,直接调用规范化后的函数)

抽取 `die()` + `require_encryption_material()`(改动后的版本)到
`scratchpad/w5g/preflight-require-encryption-segment.sh`,`bash -n` 通过后
`source` 并直接传入带 `\r`/引号/空白的字符串:

```
sentinel + 字面 \r (bash $'...\r' 直接构造,不经过 grep)
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in fixture.env. ...
  exit=1

"default-key-change-in-production" (双引号)
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in fixture.env. ...
  exit=1

'default-key-change-in-production' (单引号)
  -> ERROR: ENCRYPTION_KEY uses the insecure built-in default value in fixture.env. ...
  exit=1

"" (引号包住的空值)
  -> ERROR: ENCRYPTION_KEY is missing (empty) in fixture.env. ...
  exit=1

"   " (三个空格,无引号)
  -> ERROR: ENCRYPTION_KEY is missing (empty) in fixture.env. ...
  exit=1

"abcdef0123456789abcdef0123456789" (双引号包住一个合法的非哨兵值,正控制组)
  -> reached-past-check (未 die)
  exit=0
```

### F1:控制组(既有行为不应改变)

```
abc=def 追加到合法 env 文件末尾(与 ENCRYPTION_KEY 无关的行)
  -> [attendance-preflight] Preflight OK      exit=0   (未被无关行干扰)

  ENCRYPTION_KEY=default-key-change-in-production (行首带前导空白)
  -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...   exit=1
  (get_env_value 的 ^KEY= 锚点本来就不匹配带前导空白的行,判定回落到"缺失"，
   既有行为不变——不是命中了哨兵判断,而是命中了空值判断)

export ENCRYPTION_KEY=default-key-change-in-production (export 前缀)
  -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...   exit=1
  (同上,^KEY= 锚点不匹配,既有行为不变)
```

### F1 回归:原 W5-G 基线用例(HEAD `ced5a84fa` 已验证过的四个 die + 一个
valid case)重新跑一遍,确认本次改动没有破坏原有行为

```
env-valid      -> [attendance-preflight] Preflight OK                          exit=0
env-empty-key  -> ERROR: ENCRYPTION_KEY is missing (empty) in <path>. ...      exit=1
env-empty-salt -> ERROR: ENCRYPTION_SALT is missing (empty) in <path>. ...     exit=1
env-default-key-> ERROR: ENCRYPTION_KEY uses the insecure built-in default ... exit=1
env-default-salt-> ERROR: ENCRYPTION_SALT uses the insecure built-in default . exit=1
```

### F2:三个副本用例(抽 `die()` + `verify_onprem_env_templates()`,改动后版本)

```
pkgroot-dupline (同一模板里 ENCRYPTION_KEY= 空占位 + ENCRYPTION_KEY=真实值 两行同时存在)
  -> ERROR: docker/app.env.attendance-onprem.template must keep every ENCRYPTION_KEY= line empty (no real value committed to template)
  exit=1   (旧断言会因为命中第一行空占位而误放行;新断言正确拦截)

pkgroot-trailingws (ENCRYPTION_KEY=   三个尾随空格；ENCRYPTION_SALT=\r 尾随 CRLF)
  -> PASSED (no die)
  exit=0   ([[:space:]]*$ 容忍尾随空白和 \r，仍判定为空占位)

pkgroot-example-realvalue (docker/app.env.example 里 ENCRYPTION_KEY=真实值)
  -> ERROR: docker/app.env.example must keep every ENCRYPTION_KEY= line empty (no real value committed to template)
  exit=1   (新增覆盖：docker/app.env.example 现在也会被检查)
```

### F2 回归:原 W5-G 基线四个包根目录(补了一个不含 ENCRYPTION_* 的
`docker/app.env.example` 之后)重新跑一遍

```
pkgroot-noenc    -> PASSED (no die)   exit=0
pkgroot-emptyenc -> PASSED (no die)   exit=0
pkgroot-realkey  -> ERROR: ... must keep every ENCRYPTION_KEY= line empty ...   exit=1
pkgroot-realsalt -> ERROR: ... must keep every ENCRYPTION_SALT= line empty ...  exit=1
```

对真实仓库(`git worktree` 根目录本身当 `root` 传入,含真实
`docker/app.env.example`)重新跑一次同一函数:

```
PASSED against real repo templates (no die)
exit=0
```

**如实记录零覆盖**:上面这几个"真实仓库"级别的验证,以及 F2 设计文档里
提到的"当前两个模板都没有 ENCRYPTION_KEY/SALT 行"这一事实,意味着 F2
修复的两个 `if` 分支体,在真实仓库当前状态下(#5711 模板改动未合并)**实际
执行次数为零**——`if grep -qE '^ENCRYPTION_KEY=' "$abs"` 这个门槛条件本身就
不成立。上面 `pkgroot-dupline`/`pkgroot-trailingws`/`pkgroot-example-realvalue`
三个用例全部是在临时构造的模板副本上跑的,不是对真实仓库文件的正向覆盖。

### 变异测试(mutation),F1

对 `scripts/ops/attendance-preflight.sh` 的 `require_encryption_material`
函数体里,删掉整段"脱一层成对引号"的 `if (( ${#value} >= 2 )); then ...
fi` 代码块(保留去 `\r` 和 trim 空白两步),预期:双引号包裹哨兵这个 die
case 应该"假绿"(不再 die)。

```
# 改动前(baseline,见上面 F1 端到端第一节):dquote-sentinel -> die, exit=1

# 变异后(去掉脱引号代码块):
$ ENV_FILE=<f1-dquote-sentinel.env> bash scripts/ops/attendance-preflight.sh
...
[attendance-preflight] Preflight OK
exit=0          # 红:本该 die 却放行了,证明脱引号这段代码确实是必需的
```

变异后立即用改动前的备份文件还原
(`cp scratchpad/w5g/attendance-preflight.sh.bak2 scripts/ops/attendance-preflight.sh`),
`bash -n` 重新通过,再跑一次 `f1-dquote-sentinel.env` 确认恢复到
`die, exit=1`(上面 F1 端到端第一节展示的输出,就是还原之后重新跑出来的
结果,不是变异前的缓存)。

## 轻核返修结论

- F1:五种形状(双引号哨兵、单引号哨兵、引号空值、纯空白值、哨兵+`\r`)加
  三个控制组(无关行、前导空白行、`export` 前缀行)加原有基线五个用例,全部
  按预期通过;变异测试证明脱引号步骤确实在起作用。
- F2:三个副本用例(重复声明绕过、尾随空白/CRLF 容忍、`docker/app.env.example`
  新增覆盖)加原有基线四个用例,全部按预期通过;如实记录当前仓库状态下
  真实模板文件对这条断言的覆盖率为零(#5711 未合并)。
- F3:确认 `scripts/ops/multitable-onprem-preflight.sh` 同形状漏洞 + 零
  ENCRYPTION 检查,按指示登记不改;同时记录了一处与返修指示不一致的实读结果
  (该文件实测**不在**当前 pin 集里)。
- F4:确认 `attendance-onprem-bootstrap-admin.sh` 的 `source` 会执行 env 里
  的命令替换,按指示登记不改。

## owner 审阅返修验证(F4/F5/F6,2026-09-16)

> 编号同设计文档:本节 F4/F5/F6 = 2026-09-16 owner 审阅报告的三条发现,与上一节
> 「轻核返修」的 F1–F4 不是同一套编号。

**方法。** 全部合成、values-free:env fixture 由测试现场生成,`node`/`psql` 用 PATH 桩
替换(打标记后退出,漏网守卫也到不了数据库),不联网、不起 Docker、不读任何真实 env、
不碰 222。变异探针跑在 scratchpad 的**镜像树**上(把被改文件复制出去再改),仓库工作树
全程未被变异污染。

### 0. `bash -n`(四脚本,改动后)

```
OK scripts/ops/attendance-onprem-env-check.sh
OK scripts/ops/attendance-preflight.sh
OK scripts/ops/attendance-onprem-bootstrap-admin.sh
OK scripts/ops/attendance-onprem-package-verify.sh
```

### 1. 先红:新契约测试在修复前的结果

`node --test scripts/ops/attendance-onprem-encryption-material-contracts.test.mjs`
(HEAD `0f7771ffb`,只有测试文件存在、四脚本与 workflow 未改):

```
ℹ tests 13
ℹ pass 5
ℹ fail 8
AssertionError: quoted-whitespace must be rejected, got: GUARD_ACCEPTED        (env-check)
AssertionError: quoted-whitespace must be rejected, got: GUARD_ACCEPTED        (preflight)
AssertionError: sourced-whitespace-only must be rejected, got: GUARD_ACCEPTED  (bootstrap-admin)
AssertionError: require_encryption_material has drifted between entry points
AssertionError: quoted-whitespace: env-check must fail, got:
  [attendance-onprem-env-check] Env check OK (REQUIRE_ATTENDANCE_ONLY=1)
AssertionError: composed env lacks usable material: MISSING:ENCRYPTION_KEY     (F4 调用链)
AssertionError: rehearsal material must be generated per run, not hardcoded
AssertionError: export-key in docker/app.env.attendance-onprem.template must be rejected:
  TEMPLATES_ACCEPTED                                                           (F6)
```

5 条通过的都是正控制(合法材料仍被放行、真实模板原样通过、空占位各写法通过),说明
harness 确实走到了每一道门,不是因为够不着才「全红」。

### 2. F4 先红:直接复现 rehearsal 调用链中断

按 workflow recipe step 3 的写法合成 env(真实 multitable 模板 + 同样的 override 行),
再跑真实的 bootstrap-admin(桩 node/psql):

```
composed lines: 44
[attendance-onprem-bootstrap-admin] ERROR: ENCRYPTION_KEY is missing (empty) in .../docker/app.env.
  Generate one with: openssl rand -hex 32
BOOTSTRAP_EXIT=1
```

与审阅报告 F4 的描述一致:exit 1,尚未执行任何 DB 操作。

### 3. 修后转绿

```
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

### 4. F5 四类负例:逐入口修前/修后(函数级,真实函数体)

base = 冻结的 `0f7771ffb`,head = 本次改动后。

```
A  "   "                  | env-check: ACCEPT(假绿) -> REJECT | preflight: ACCEPT(假绿) -> REJECT | bootstrap: ACCEPT(假绿) -> REJECT
B  " <哨兵> "(引号内空格) | env-check: ACCEPT(假绿) -> REJECT | preflight: ACCEPT(假绿) -> REJECT | bootstrap: ACCEPT(假绿) -> REJECT
C  <哨兵> # comment       | env-check: ACCEPT(假绿) -> REJECT | preflight: ACCEPT(假绿) -> REJECT | bootstrap: 见下
D  $SOME_VAR              | env-check: ACCEPT(假绿) -> REJECT | preflight: ACCEPT(假绿) -> REJECT | bootstrap: 见下
```

C/D 在 bootstrap 这一格必须用端到端路径判定,不能把原始行文本喂给 `sourced` 视图 ——
bootstrap 永远看不到原始文本,它 `source` 之后拿到的是解析结果。真实 env 文件 → 真实
脚本(桩 node/psql):

```
A  "   "                 base: ACCEPT(到 node 桩, exit 77)  head: REJECT exit 1  ENCRYPTION_KEY is missing (empty)
B  " <哨兵> " padded     base: ACCEPT(到 node 桩, exit 77)  head: REJECT exit 1  uses the insecure built-in default value
C  <哨兵> # comment      base: REJECT exit 1                head: REJECT exit 1  uses the insecure built-in default value
D  $SOME_UNSET_VAR       base: REJECT exit 1                head: REJECT exit 1  is missing (empty)
+  <合成 hex>(正控制)   base: ACCEPT(到 node 桩, exit 77)  head: ACCEPT(到 node 桩, exit 77)
```

即 C/D 在 bootstrap 侧**本来就**被 runtime 拦住 —— 这正是审阅所说「影响是 fail-early
假绿」:假绿发生在 env-check/preflight 这两道**早退**门上,操作员要到第一次真正使用加密
时才会撞墙。修后三个入口对同一份材料给出一致判定。正控制两侧都放行,证明没有过度收紧。

### 5. F6 负例:修前/修后

```
export ENCRYPTION_KEY=synthetic-value | ACCEPT(假绿) -> REJECT
  ENCRYPTION_SALT=synthetic-value(缩进) | ACCEPT(假绿) -> REJECT
export ENCRYPTION_KEY=(空占位,应放行) | ACCEPT -> ACCEPT(预期,正控制)
```

契约测试里 8 类拒绝负例 × 3 份模板、4 类空占位写法、以及三份真实模板原样的正控制全部
按预期。

### 6. 变异测试(去掉修复 → 假绿/中断复现)

镜像树上逐条去掉修复后重跑整套契约测试:

```
M0 控制:镜像未变异                                   -> exit=0 pass=13 fail=0
M1 F4:删掉 rehearsal compose 步骤里两行合成材料      -> exit=1 pass=12 fail=1
     红:F4 rehearsal caller(调用链再次断在材料门上)
M2 F5:删掉「脱引号之后的再 trim」                    -> exit=1 pass=9  fail=4
     红:env-check 负例 / preflight 负例 / bootstrap sourced 负例 / env-check 端到端
M3 F5:让 env-file 视图的表达式拒绝全部失效           -> exit=1 pass=10 fail=3
     红:env-check 负例 / preflight 负例 / env-check 端到端
M4 F6:声明正则退回行首精确形式                       -> exit=1 pass=12 fail=1
     红:F6 rejects every declaration syntax
```

### 7. 行尾与 pin

- 四个脚本 + 新测试文件 + 两份文档在 index 中的 CR 计数均为 0
  (`git show :<path> | tr -cd '\r' | wc -c`)。
- workflow:`stock-prep-staging-window-rehearsal.yml` 的 index blob 原本就是纯 LF
  (工作区因 `core.autocrlf=true` 呈 CRLF),改动后 index 仍为 0 CR。
- pin:`s6a-package-provenance-pins.json` 的名册里 workflow 只有
  `sealed-export-s5-sqlserver.yml` 与 `plugin-tests.yml`,脚本只有
  `multitable-onprem-package-{verify,build}.sh`。本轮改的文件**都不在 pin 集**,
  未重算 pin,也未改动任何 pin 集内文件。

### 8. 本轮没做的事

- 没有真跑 `stock-prep-staging-window-rehearsal.yml`(dispatch-only,需要完整打包 + PG 服务);
  F4 的证据是「解析真实 workflow 步骤 + 真实脚本 + 合成底座」的链路级验证,不等于一次真实预演。
- 没有跑 `attendance-preflight.sh` 的整脚本端到端(它还要求 compose/nginx/validator 等一整套
  文件);preflight 侧用的是真实函数体 + 与 env-check 逐字节一致性守卫双重覆盖。
- 没有碰 222、真实 env、pin 集内文件、`packages/`、`plugins/`、任何 `.ps1`。
- 设计文档上一节登记的「`source` 会执行 env 里的命令替换」仍按原结论不改。
