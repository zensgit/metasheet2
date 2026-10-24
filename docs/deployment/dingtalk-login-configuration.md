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
目录配置区的「检测钉钉登录状态」按钮调用与登录页相同的探测接口，显示当前登录是否可用及缺少哪些变量名；
打开页面时不会自动探测。

## 登录必需项与提示

| 登录页原因 | 应配置的变量 | 说明 |
| --- | --- | --- |
| `missing_client_id` | `DINGTALK_CLIENT_ID`，别名 `DINGTALK_APP_KEY` | 登录应用的 App Key |
| `missing_client_secret` | `DINGTALK_CLIENT_SECRET`，别名 `DINGTALK_APP_SECRET` | 登录应用的 App Secret，仅在服务端保存 |
| `missing_redirect_uri` | `DINGTALK_REDIRECT_URI` | 完整 HTTPS 回调地址，路径 `/login/dingtalk/callback`，与开放平台配置一致 |
| `corp_not_allowed` | 检查 `DINGTALK_CORP_ID` 和 `DINGTALK_ALLOWED_CORP_IDS` | 配置的企业未被允许；修正企业配置或按企业策略维护白名单，不要清空白名单绕过限制 |

每组别名配置一种即可。若同时配置，非空的 `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET`
优先于对应别名。不要把实际凭据填入仓库示例文件、截图、问题单或日志。

`unavailableReason` 按 ID → Secret → 回调地址 → 企业白名单的顺序只给出**首个阻断原因**；
同一探测响应中的 `missingEnv` 给出**全部**缺失项（#6467 补充），因此可以一次补齐后只重建一次后端：

| 当前环境 | `unavailableReason` | `missingEnv` |
| --- | --- | --- |
| 三项都没配 | `missing_client_id` | `DINGTALK_CLIENT_ID\|DINGTALK_APP_KEY`、`DINGTALK_CLIENT_SECRET\|DINGTALK_APP_SECRET`、`DINGTALK_REDIRECT_URI` |
| 只缺 Secret 与回调地址 | `missing_client_secret` | `DINGTALK_CLIENT_SECRET\|DINGTALK_APP_SECRET`、`DINGTALK_REDIRECT_URI` |
| 只缺回调地址 | `missing_redirect_uri` | `DINGTALK_REDIRECT_URI` |
| 三项齐全但企业未放行 | `corp_not_allowed` | 空 |
| 全部可用 | `null` | 空 |

`missingEnv` 中带 `|` 的条目表示「任一名称配置即可」（主名在前、别名在后）。登录页缺两项及以上时列出全部变量名，
只缺一项时沿用该项的专门提示。`missingEnv` 只含上述固定变量名，从不包含配置值或值的片段；
探测接口本身无需登录（登录页要用），而它此前已对匿名调用方返回 `unavailableReason`、`corpId`、`allowedCorpIds`，
变量名是公开文档中的固定名称，不构成新的敏感信息。

## 部署与验证

1. 在后端实际加载的环境文件中填写上述配置。标准 Docker 部署使用 `docker/app.env`；
   使用考勤成品模板时也需要补充这些登录项。`docker/app.env.example` 提供了注释形式的入口。
2. 沿用当前部署的 Compose 文件、覆盖参数和镜像版本，仅重新创建后端容器，使 `env_file`
   被重新注入。单独执行 `docker compose restart` 不会更新容器环境变量。
   非容器部署应按其进程管理方式重新加载环境并重启后端。
3. 在普通浏览器中刷新登录页，检查提示是否消失。只读
   `GET /api/auth/dingtalk/launch?probe=1` 返回的 `configured`、`available`、
   `unavailableReason`、`missingEnv` 可用于排查；记录这四个字段即可，不要复制整个响应中的企业信息。
4. `available=true` 仅说明服务端配置和当前静态白名单检查通过，不能替代真实 OAuth
   登录、用户授权或回调验收。真实 UAT 仍需另行安排。

## 已有部署：升级前未设 `DINGTALK_CORP_ID` 时登录过的成员（现场第 3 项）

R66–R70 期间如果没有设置 `DINGTALK_CORP_ID`，当时用钉钉网页扫码登录成功的成员，其钉钉身份没有记录企业。
升级前这些成员无论再扫码多少次，目录同步页都一直显示「缺 openId」，在目录页开通钉钉登录返回 400，
而用户管理不显示「缺 OpenID」。

升级到包含此修复的版本（R73）后：

1. 让这些成员再用钉钉扫码登录一次。只有当该成员**恰好链接了一个**钉钉目录成员、且该目录成员有效、unionId
   与本次扫码一致时，登录才会按该目录成员的企业把 openId 补到目录成员上；没有链接、链接了多个、unionId
   不一致或目录成员已停用时不补，登录本身照常。
2. 在目录同步页对该成员点「刷新当前成员」，「缺 openId」消失后即可在目录页开通钉钉登录。
   用户管理的「缺 OpenID」筛选会列出仍需重新扫码的这类成员；扫码后不再列出，但身份仍未补记企业（见第 3 点）。
3. 重新扫码只补目录成员的 openId，**不会**给钉钉身份补记企业。在目录同步页对该成员开通钉钉登录
   （绑定时同时开通）时，身份才会按目录成员改写到企业下；在用户管理开通不会改写。

**不要在现有部署上补设 `DINGTALK_CORP_ID`，直到每一位这类成员都已重新扫码、并已在目录同步页开通钉钉登录。**
提前补设会把这些成员挡在门外：扫码登录被拒，返回 403（未关联本地用户），开启邮箱自动关联时返回 409
（本地用户已绑定其他钉钉身份）。只重新扫码、尚未在目录页开通的成员，补设后同样返回 403。
以上结果均用合成数据在 R72 及本修复上执行验证过，未读取客户数据。给身份补记企业的数据修复不在本版范围内。

本次配置指引不调整自动建号、账号授权或通知策略。Stream/lifecycle 保持 OFF。
