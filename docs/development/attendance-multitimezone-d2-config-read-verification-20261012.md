# 考勤多时区 D2 配置读取验证（阶段证据）

日期：2026-10-12
状态：已接入两个管理员配置 GET 接口；完整多时区目标仍未完成。本报告不是 FINAL，不构成合并、部署或启用授权。

基线 HEAD：3ee7e25cdce9c354bf9969ca12752e4836d42bf3。本次功能源码未提交，测试以凭据中的源码 SHA 识别；该 HEAD 不是功能提交。主开发与实际验证在 Mac mini 专属隔离工作区完成。

## 已完成与证据

| 验证范围 | 相对专属工作区证据位置 | SHA-256 |
|---|---|---|
| 真实 HTTP/JWT/PG：16项接口＋20项时钟邻近测试，36/36，零跳过 | reports/d2-policy-routes-http-v3/verification-receipt.json | fc1ccc9cf6aa88e39888489ee5f23b24c6285d735e40e0dfd9c5f09c155e1abc |
| 两份完整本地 CI 接线 guard：282/282，零跳过 | reports/d2-root-ci-wiring/receipt.json | dd4749cdf14d9528d0855b3b9901f3077b9ad65dae481d8dc014faa406a55a12 |
| pnpm openapi:guard：构建、SDK生成及契约guard通过 | reports/openapi-policy-read/source-repaired-receipt.json | 4ca6be06d860d833dcb9c1952f08121c6fb20398990b9886a2048d0a57b63dd6 |
| pnpm validate:all：插件清单、现有lint命令、后端及前端类型检查通过 | reports/root-workspace-validation/runtime-fixed-receipt.json | 510300f5d61795fd89cb1262132dda622a705a3286257022d94b9ebbf97a3a4c |

配置读取使用实际 authenticated actor、attendance:admin 权限和组织成员检查。真实 HTTP/JWT/PG 负例包括匿名、伪造角色声明、跨组织、停用用户、停用组织成员；正例包括非平台管理员实际授权。失活成员拒绝由真实认证 tenant/member 与 actor org 门槛触发，不是事务内并发撤权证明。数据仅隔离合成场景，数据库独立克隆并已精确停止，旧数据库控制状态与旧证据保持。

OpenAPI schema 位于实际构建入口 src/base.yml；错误入口的修改已恢复。原 schema 放置错误、缺 SDK 工具和缺 npx 的失败日志保留。隔离 runtime 补齐 npm/npx 后重跑质量检查通过。依赖采用同锁文件的独立 APFS 克隆，不能称为成功全新联网安装。插件清单存在9项既有warning，命令退出0；lint只证明仓库该命令实际覆盖的文件，不代表全部新增CJS有专门lint规则。

Astra 独立审阅范围：PASS_READ_ROUTES_HTTP_PG_ONLY；确认源码、回执、日志、结果哈希一致及 OpenAPI/CI 接线契合。Root另行核对v3全部11源码哈希及实际JSON计数，零不一致。

## 尚未证明的完整目标

- 有效时区贯穿外部 prepare 与事务内权威解析、prefetch、published candidates、rehydrate 和 W4/W7，下层不能恢复旧班次时区。
- 原冻结班跨日期变更线 checkout、独立版本化 provenance companion、同日多上下文零DML拒绝、原精确回执在策略故障时重放。
- canonical 锁顺序及真实PG并发负例；已开始但无打卡班次与反向配置变更边界守护。
- 管理员配置写接口与UI、真正最终批准出差目的地安排及取消链。
- 上下班及请假等关联单据的目标班次时区输入/计算、严格DST转换、跨上下文拒绝。
- 完整20项多时区验收、Draft PR、精确功能head的13项必需GitHub CI与终审。

多时区保持默认关闭；管理员新增单据输入/显示关联模式仍待明确确认，通用任务独立。未经另行批准不转Ready、不合并、不部署、不启用。

实现与审阅分开：Sol6.1/high推进D2运行时；Astra/high独立审阅。未实际调用的模型不计入开发验证证据。
