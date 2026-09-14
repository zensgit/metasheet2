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
