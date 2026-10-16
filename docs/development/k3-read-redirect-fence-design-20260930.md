# SA-03 前置：K3 读取链禁止自动重定向

状态：本地决策候选，与实现分支分离；未发布、未部署。日期：2026-09-30。

## 1. 保持既有边界，不增加操作

上位目标是 `integration-self-service-adaptation-goals-20260930.md` 的 SA-03。K3 外部写永久禁止已经是既有裁决；本片只堵住读取 transport 绕过该约束的路径，不增加 POST 读操作、不改变批准角色、不放宽来源访问。

事实基线：`b35d4cd1fbaa50d0cf15e1a75745f77624a9468a`。以下路径相对 `plugins/plugin-integration-core/`，该 adapter 本轮探查时无既有未提交改动。

- `index.cjs:364` 使用默认 factory，没有外层 fetch redirect 包装。
- `lib/adapters/k3-wise-webapi-adapter.cjs:1781` 默认使用 `globalThis.fetch`。
- `:1822–1825` 对初始 URL 的实际 pathname 检查 intent；`:1844–1849` 发起 fetch 时没有约束 redirect。
- `:2445` 的永久禁写在 upsert 入口；读取或认证链的 transport 自动跳转不会调用 upsert，也不会重新通过初始目标的 intent 检查。

因此初始路径通过不等于后续 wire 目标仍是受审读取目标。尤其 307/308 的保留方法跳转可能把读 POST 送到写路径。需要用原生 fetch 和全本机合成服务验证，不能仅断言 mock 收到某个 options 字段。

## 2. 推荐技术决策

1. 所有共用 `requestJson` 调用显式使用 `redirect: 'error'`。包含 token、login、health 和已有只读操作；不为认证或“同 host”留绕过。平台不主动跟随任何跳转。
2. 对注入 transport 返回的 3xx/已重定向响应作显式拒绝，不把响应 JSON 中的业务成功标识当成成功读取。自定义 transport 必须遵守该选项；对同进程恶意/不合规 transport 不承诺“零后续请求”，事后拒绝响应不能撤销其已经发生的请求。
3. 不新增 `allowRedirect` flag，不加手动 Location 追踪，不建立第二套 fetch 实现。
4. 不改变 base URL 的 HTTP/HTTPS、内网准入或 DNS 策略，不将本修复冒称完整 SSRF 修复。存量 HTTP/HTTPS-only 的部署决策仍另行处理。
5. 不变更 K3 Save/Submit/Audit 的永久拒绝，不打开任何 C6 外部写例外。

分类：落实现有永久禁写边界的技术修复，不是增加授权。GOV-08 的设计与代码分支继续分离；将来发布仍须 owner 授权。

## 3. 兼容影响与部署说明

此前依赖反向代理、登录路径或业务端点 3xx 自动跳转的配置将失败；应由获准运维核对并配置最终受审端点，不能提示用户打开跟随跳转开关。代码通过合成测试不能证明现网无此配置，也不授权现网盘点、读取或部署。

回滚本修复会重新暴露目标检查与最终请求不一致，不能把“恢复自动跳转”当作安全回退方案。原始配置与凭据不需要迁移或重写。

## 4. 验证门

- 基线正向复现：原生 fetch、进程内合成 HTTP 服务，初始读端点返回 307/308，确认未修实现能访问合成禁止路径。所有端点/凭据/业务值仅合成，不访问客户系统。
- 修后矩阵：301/302/303/307/308 的同 origin 写路径、跨 origin 目标、认证与 health/读操作均不能到达第二跳；实际合法 POST 查询仍成功。
- 注入 transport 合同：options 必须包含 `redirect: 'error'`；返回 3xx 或 `redirected: true` 时拒绝，即便响应体自称成功。
- 独立去 redirect 选项变异必须被原生 fetch 的第二跳计数抓住；只让 mock 回拒绝不算证明。
- 跑既有 K3 adapter、永久写围栏、scope/只读 RSC、结构守卫、完整 provenance 和测试清单；逐项记录实际结果，不写“应该绿”。

实现/验证证据单独写入代码分支，本文不是功能已上线证明。

## 5. 本地实现核验（非部署批准）

代码分支已实现上述固定选项和响应拒绝；真实 loopback + 原生 fetch/注入 transport 共 10 项通过，主审三项内存变异有定向红例。移除固定选项后，五种状态实际第二跳均由 0 变为 1，合法 POST 正控制仍绿；不是仅用 options mock 自证。独立只读复核没有发现该修复的剩余阻断，永久 upsert 围栏未动。

准确错误语义：原生 fetch 以通用传输错误拒绝跳转，沿用已有读错误包装，不能可靠从所有传输失败中区分 redirect。`K3_WISE_REDIRECT_REFUSED` 仅用于 transport 返回 3xx/已跳转 Response 后的防御性拒绝；没有为了可识别错误码改成手动跟随或开放重定向。完整证据在代码分支 `integration-self-service-read-config-safety-verification-20260930.md`，本设计仍为本地候选，现网兼容盘点、发布和部署均未进行。
