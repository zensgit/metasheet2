# ci-wiring 守卫：CRLF 归一解析 + Python 解释器 ENOENT 回退（设计）

- 日期：2026-09-20
- 分支：`fix/ci-wiring-crlf-and-python-fallback`
- 基线：`origin/main` = `1a6663a41`
- 目标：根治 `scripts/ops/*-ci-wiring.test.mjs` 在本机（Windows 检出）的假红；**CI（Linux/LF）行为逐字节不变**。

## 1. 问题：CI 绿、本机红，且红的原因与被测改动无关

`scripts/ops` 下 38 个 `*-ci-wiring.test.mjs` 是必过 no-DB `test` 泳道的结构性守卫。基线 `1a6663a41`
在本机（Windows 11、CJK locale、`core.autocrlf` 生效的检出）整批跑：**36/38 红**。

这不是守卫发现了问题，而是守卫自己跑不起来。逐条读代码后确认三个彼此独立、但会叠加的本机专有根因。
三者都只在"非 Linux / 非 LF / 非 UTF-8 locale"的环境里触发，所以 CI 从未暴露。

### 根因 ① CRLF 让 `//` 注释剥离整体失效，解析退化成垃圾

`scripts/ops/ci-realdb-step-contract.mjs:740`（基线行号）：

```js
const noLineComments = arrayBody
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')
```

`.split('\n')` 之后，CRLF 文本的每一"行"以 `\r` 收尾。而

- 正则 `.` 不匹配行终止符，`\r` 是行终止符之一；
- 没有 `m` 标志时 `$` 只锚定**整个串尾**。

于是 `//.*$` 在任何以 `\r` 结尾的行上**完全不匹配**，注释一条都没剥掉。`exclude` 数组体内第一条含
撇号的注释（例如 `workflow's`）一旦保留下来，它的 `'` 就参与了后续
`/'([^']+)'|"([^"]+)"/g` 的配对，把此后每一个条目的引号边界整体错位。

本机实测（`packages/core-backend/vitest.config.ts`，真实文件）：

| 输入 | 解析出的条目数 | 含 `\r\n` 的垃圾条目 |
| --- | --- | --- |
| CRLF | 462 | 201 |
| LF | 400 | 0 |

垃圾条目样例（值面无害，仅为结构示意）：`"s own header for the precedent/rationale).\r\n      "`。

因为真实条目被错位吃掉，`isQuotedInTestExclude(cfg, FILE)` 对真实存在的 exclude 条目返回 `false`，
守卫红。

同一 bug 形状在 `scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs` 里有一份**独立副本**
（该文件早于共享模块，自带 `testExcludeEntries`），并且它的 `namedStepBody` 还多踩一脚：

```js
const match = lines[i].match(/^(\s*)- name:\s*(.*)$/)
```

同样的 `.*$`，在 CRLF 行上**一条 `- name:` 都匹配不到**，所以该文件里所有按步骤名定位的断言全红。

此外，多个守卫的**变异夹具**本身是 LF 字面量，例如
`config.replace("      'tests/integration/x.test.ts',\n", '')`——对 CRLF 文件内容零匹配，于是
`assert.notEqual(dropped, config, '... mutation must apply')` 直接红。

### 根因 ② `python3` 在 Windows 上不存在 → 全员 fail-closed

`ci-realdb-step-contract.mjs:154`（基线行号）与 `attendance-w4c2-ci-wiring.test.mjs` 的三处
直接 `spawnSync('python3', …)`。YAML 走 PyYAML 桥而不是 `js-yaml`，是因为这些守卫**在 `pnpm install`
之前**执行（见 `plugin-tests.yml` 里 "fails the required `test` check fast, before the pnpm
install/build" 的注释），没有 npm 依赖可用。

CPython 的 Windows 安装不提供 `python3` 这个名字，只有 `python.exe` 和 `py` 启动器。于是
`res.error.code === 'ENOENT'`，桥 fail-closed 抛错——**这是正确行为**（守卫不能在无法解析工作流时静默变绿），
但结果是本机每一个用到桥的守卫都红。

①③ 是耦合的：只修 ① 本机仍然全红（桥先炸），只修 ③ 本机 exclude 类断言仍然红。

### 根因 ③ 桥的 stdin 走 locale 解码，中文 `name:` 变代理对

排掉 ENOENT 之后暴露出第三层：桥用 `sys.stdin.read()`，文本模式 stdin 使用解释器的 **locale 编码**。
`ubuntu-latest` 上那是 UTF-8（所以 CI 无感），本机中文 Windows 上是 cp936/GBK。工作流文件里有中文
`name:`，locale 解码产出孤立代理，PyYAML 抛
`ReaderError('<unicode string>', 2157, 56468, 'unicode', 'special characters are not allowed')`，
即 exit 4 —— 一个"YAML 解析失败"的假信号，而 YAML 本身完全合法。

注意 stdout 不需要对称处理：`json.dump` 默认 `ensure_ascii=True`，回传给 Node 的永远是纯 ASCII。

## 2. 设计

三条修法都遵守同一条边界：**只改"在哪里找 / 怎么读"，不改"什么情况下允许变绿"。**

### ① 在解析入口归一到 LF

`extractTestExcludeArrayBody` 首行 `const text = src.replace(/\r\n?/g, '\n')`；mask 与最终 `slice`
都取 `text`（两者等长，切片下标才对得上）。返回的数组体因此对 CRLF / LF 两种检出**逐字节相同**。

`quotedExcludeEntries` 的注释剥离改为 `/\/\/[^\r\n]*/`（纵深防御：调用方若直接递进一段原始 CRLF 体，
仍然正确）。对 LF 输入两种写法行为相同——每个 split 出来的行里没有终止符，两者都跑到行尾。

`multitable-exact-anchor` / `multitable-d2-archive` 两个自带解析器/自带夹具的守卫，改在**读取边界**
归一：`import { readFileSync as readFileSyncRaw } from 'node:fs'` + 一个同名 LF 归一包装函数。
一处改动覆盖该文件全部 21 / 12 个读取点，且把"夹具是 LF 字面量"这件事一次性坐实。
`multitable-exact-anchor` 另加 `normalizeEol()` 用在 `testExcludeEntries` / `namedStepBody` 入口，
因为这两个函数也会被喂**调用方变异过的文本**，不只是磁盘读入的文本。

> 为什么归一是安全的：LF 输入上 `String#replace` 返回同一个字符串。CI 的检出就是 LF，所以这条路径在
> CI 上是恒等变换。见验证文档 §3 的逐字节对照。

### ② 新增 `scripts/ops/python-interpreter.mjs`

```js
export const PYTHON_CANDIDATES = [
  { command: 'python3', prefixArgs: [] },
  { command: 'py',      prefixArgs: ['-3'] },
  { command: 'python',  prefixArgs: [] },
]

export function spawnPythonSync(args, options = {}, spawn = nodeSpawnSync) { … }
```

规则，逐条都是有意的：

1. **`python3` 排第一**，所以 CI 拿到的永远是第一个候选，与改动前的裸 `spawnSync('python3', …)` 等价。
2. **只有 `res.error?.code === 'ENOENT'` 才继续下一个候选**。其余一律原样返回，不重试：
   - 非零退出码（桥的 3 = PyYAML 缺失、4 = YAML 解析错）；
   - 非 ENOENT 的 spawn 错误（EACCES / EPERM / ETIMEDOUT…）。

   这条是这个设计里唯一会被误写成绿色旁路的地方：如果"任何失败都换个解释器再试"，那么一个真实的
   YAML 解析失败会被一路重试到某个解释器碰巧接受为止。所以判据必须是"这个解释器不存在"，
   而不是"这次没成功"。
3. **全部 ENOENT 时返回最后一个结果**，它仍然带着 `.error`，调用方既有的
   `if (res.error) throw` 分支照旧触发 —— **fail-closed 语义一个字没动**。
4. 模块自身**从不抛错、从不吞错**，只拓宽"在哪里找"。
5. `spawn` 作为第三个参数注入，测试用 stub 驱动，不落盘、不起真进程。

接入点：`ci-realdb-step-contract.mjs`、`attendance-w4c2-ci-wiring.test.mjs`（3 处）、
`integration-guard-required-wiring-contract.test.mjs`（该文件自带一份重复的桥，同病同治）。

### ③ 桥的 stdin 显式 UTF-8

`yaml.safe_load(sys.stdin.read())` → `yaml.safe_load(sys.stdin.buffer.read().decode("utf-8"))`
（`attendance-w4c2` 的 JSON 入口同理）。UTF-8 locale 下两者等价，见验证文档 §4 的 136 个工作流逐文件对照。

## 3. 明确不做的事

- **不碰 `.github/`**。新增的 `python-interpreter.test.mjs` 因此由已接线的
  `t2gate-collision-mechanism-ci-wiring.test.mjs` `import` 进来（node:test 在 import 期注册用例），
  沿用该文件"托管共享 helper 变异覆盖"的既有先例，没有新增或修改任何 workflow step。
- **不放宽任何守卫判据**。本 PR 不新增/不删除/不弱化任何一条 exclude、step、pin 断言。
- **不修需要 `pnpm install` 才能跑的守卫**（`approval-browser` / `stock-prep-browser` 依赖 `js-yaml`）。
- **不改 `dingtalk-*` 等其它直接 spawn `python3` 的脚本**（见验证文档"残余"）。
