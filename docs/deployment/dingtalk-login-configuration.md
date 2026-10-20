# 钉钉目录集成与网页登录配置

适用范围：#6467 的配置提示、管理员配置指引和部署说明。目录连通性错误 `50004` 不在本次范围内。
本文不授权真实 UAT 或开通 Stream/lifecycle；这两个开关组继续保持 OFF。

## 两套配置分别在哪里

| 功能 | 配置位置 | 用途 |
| --- | --- | --- |
| 目录集成 | 「目录同步」管理页，保存到 `directory_integrations` | 使用 Corp ID、App Key、App Secret 及目录范围拉取通讯录 |
| 网页 OAuth 登录 | 后端进程环境变量；仓库 Docker Compose 的 `backend.env_file` 指向 `docker/app.env` | 登录授权、回调及身份映射 |

保存目录集成不会更新 OAuth 登录环境变量。管理员可从目录配置区的「查看钉钉登录配置」
进入帮助页的服务端配置说明。该入口提供说明，不保存或回显 OAuth 密钥。

## 登录必需项与提示

| 登录页原因 | 应配置的变量 | 说明 |
| --- | --- | --- |
| `missing_client_id` | `DINGTALK_CLIENT_ID`，别名 `DINGTALK_APP_KEY` | 登录应用的 App Key |
| `missing_client_secret` | `DINGTALK_CLIENT_SECRET`，别名 `DINGTALK_APP_SECRET` | 登录应用的 App Secret，仅在服务端保存 |
| `missing_redirect_uri` | `DINGTALK_REDIRECT_URI` | 完整 HTTPS 回调地址，路径 `/login/dingtalk/callback`，与开放平台配置一致 |
| `corp_not_allowed` | 检查 `DINGTALK_CORP_ID` 和 `DINGTALK_ALLOWED_CORP_IDS` | 配置的企业未被允许；修正企业配置或按企业策略维护白名单，不要清空白名单绕过限制 |

每组别名配置一种即可。若同时配置，非空的 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`
优先于对应别名。不要把实际凭据填入仓库示例文件、截图、问题单或日志。

后端按 ID → Secret → 回调地址 → 企业白名单的顺序返回**首个阻断原因**，并非完整缺项清单。
修复后刷新，可能显示下一项。提示只展示变量名和原因，不展示实际配置值。

## 部署与验证

1. 在后端实际加载的环境文件中填写上述配置。标准 Docker 部署使用 `docker/app.env`；
   使用考勤成品模板时也需要补充这些登录项。`docker/app.env.example` 提供了注释形式的入口。
2. 沿用当前部署的 Compose 文件、覆盖参数和镜像版本，仅重新创建后端容器，使 `env_file`
   被重新注入。单独执行 `docker compose restart` 不会更新容器环境变量。
   非容器部署应按其进程管理方式重新加载环境并重启后端。
3. 在普通浏览器中刷新登录页，检查提示是否消失。只读
   `GET /api/auth/dingtalk/launch?probe=1` 返回的 `configured`、`available`、
   `unavailableReason` 可用于排查；记录这三个字段即可，不要复制整个响应中的企业信息。
4. `available=true` 仅说明服务端配置和当前静态白名单检查通过，不能替代真实 OAuth
   登录、用户授权或回调验收。真实 UAT 仍需另行安排。

本次配置指引不调整自动建号、账号授权或通知策略。Stream/lifecycle 保持 OFF。
