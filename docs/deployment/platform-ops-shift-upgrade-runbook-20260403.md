# Metasheet 现场运维值班升级手册

Date: 2026-04-03  
Scope: 已切换到 `platform` 模式的客户现场，执行平台版本升级、验收、回滚的值班操作手册

## 1. 文档用途

本文档给现场实施、运维值班、交付同事直接使用。

目标只有三个：

1. 升级前不漏检查
2. 升级时按固定步骤执行
3. 出问题时快速回滚，不在线上临场猜

## 2. 适用前提

本手册只适用于以下环境：

1. 当前环境已经是 `PRODUCT_MODE=platform`
2. 当前环境已经是 `DEPLOYMENT_MODEL=onprem`
3. 同一套环境同时承载考勤和多维表
4. 升级统一走平台升级链，而不是 attendance-only 升级链

## 3. 固定脚本

升级只使用这三类脚本：

1. 预检：
   [multitable-onprem-preflight.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-preflight.sh)
2. 升级：
   [multitable-onprem-package-upgrade.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-package-upgrade.sh)
3. 健康检查：
   [multitable-onprem-healthcheck.sh](/Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-healthcheck.sh)

禁止现场自创临时命令替代正式升级链，除非研发负责人明确批准。

## 4. 升级前必须确认

### 4.1 环境变量

确认 `app.env` 中至少包含并正确设置：

```dotenv
PRODUCT_MODE=platform
DEPLOYMENT_MODEL=onprem
JWT_SECRET=...
DATABASE_URL=...
ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import
ATTACHMENT_PATH=/opt/metasheet/data/attachments
ATTACHMENT_STORAGE_BASE_URL=http://your-host-or-domain/files
```

参考模板：

- [app.env.multitable-onprem.template](/Users/huazhou/Downloads/Github/metasheet2/docker/app.env.multitable-onprem.template)

### 4.2 目录

确认以下目录存在且服务账号可写：

1. `/opt/metasheet/storage/attendance-import`
2. `/opt/metasheet/data/attachments`

### 4.3 备份

升级前必须完成：

1. `app.env` 备份
2. 数据库备份
3. 考勤导入目录备份
4. 附件目录备份

未完成备份，不执行升级。

## 5. 标准升级命令

以下命令中的地址请替换为现场真实域名或 IP。

### 5.1 预检

```bash
ENV_FILE=/opt/metasheet/docker/app.env \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-preflight.sh
```

### 5.2 升级

```bash
ENV_FILE=/opt/metasheet/docker/app.env \
BASE_URL=http://your-host-or-domain \
API_BASE=http://your-host-or-domain/api \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-package-upgrade.sh
```

### 5.3 健康检查

```bash
BASE_URL=http://your-host-or-domain \
API_BASE=http://your-host-or-domain/api \
bash /Users/huazhou/Downloads/Github/metasheet2/scripts/ops/multitable-onprem-healthcheck.sh
```

## 6. 升级时间窗口建议

建议始终在低峰期执行，目标是把中断压到最小。

推荐顺序：

1. 提前 1 天完成版本准备
2. 提前 1 小时完成预检
3. 维护窗口开始前完成备份
4. 维护窗口内只做升级、健康检查、smoke

不要在维护窗口里现场处理以下事情：

1. 补装依赖
2. 现场改大量配置
3. 重新设计 nginx
4. 临时 debug 无关问题

## 7. 值班执行步骤

### 第一步：进入维护窗口

通知业务方：

1. 进入短维护窗口
2. 暂停关键导入、编辑、批量操作
3. 等待升级完成确认

### 第二步：确认备份完成

值班人员必须口头或记录确认：

1. 配置已备份
2. 数据库已备份
3. 存储已备份

### 第三步：跑预检

执行预检脚本。

结果要求：

1. 必须通过
2. 如果失败，先修环境，不继续升级

### 第四步：执行升级

执行升级脚本。

关注点：

1. 服务是否正常重启
2. migration 是否成功
3. 升级脚本是否完整返回成功

### 第五步：跑健康检查

健康检查必须通过。

不通过时：

1. 不宣布升级完成
2. 立即进入异常处理

### 第六步：执行人工 smoke

至少检查以下项目。

平台级：

1. 根入口 `/`
2. 登录
3. API

考勤级：

1. 考勤首页
2. 导入入口
3. 列表或报表

多维表级：

1. `/multitable`
2. grid open
3. search
4. form 或 drawer
5. comments / unread
6. 附件上传

### 第七步：业务确认

由业务或实施人员确认：

1. 核心流程恢复
2. 可结束维护窗口

## 8. 现场值班判定标准

### 8.1 可以宣布升级成功

必须同时满足：

1. 预检通过
2. 升级脚本成功
3. 健康检查通过
4. 平台 smoke 通过
5. 考勤 smoke 通过
6. 多维表 smoke 通过
7. 业务确认无阻断

### 8.2 必须触发异常处理

满足任一条件即进入异常处理：

1. 升级脚本失败
2. migration 失败
3. 健康检查失败
4. 根入口无法访问
5. 登录失败
6. 考勤关键链路失败
7. 多维表关键链路失败

## 9. 异常处理顺序

异常处理时，值班同事不要边猜边改。固定顺序如下：

1. 记录失败时间和现象
2. 截图或保存终端输出
3. 判断是预检失败、升级失败还是健康检查失败
4. 如果无法在短时间内恢复，执行回滚
5. 事后补完整事件记录

## 10. 回滚动作

### 10.1 何时回滚

满足任一条件建议回滚：

1. 健康检查失败且无法快速恢复
2. 核心 smoke 失败
3. 业务已阻断
4. migration 引发兼容性问题

### 10.2 回滚原则

1. 优先恢复业务，不在现场长时间修问题
2. 代码回滚和数据库状态必须一起考虑
3. 如果 migration 已产生不兼容变化，必须恢复数据库备份

### 10.3 回滚步骤

1. 停止继续升级动作
2. 恢复上一稳定版本代码或包
3. 必要时恢复数据库备份
4. 恢复服务
5. 重新跑健康检查
6. 重新验证关键入口

## 11. 值班记录模板

建议每次升级都记录以下内容：

- 客户名称：
- 环境名称：
- 当前版本：
- 目标版本：
- 开始时间：
- 结束时间：
- 操作人：
- 预检结果：
- 升级结果：
- 健康检查结果：
- smoke 结果：
- 是否回滚：
- 备注：

## 12. 快速判断口诀

值班现场按下面的顺序判断：

1. 先看预检
2. 再看升级
3. 再看健康检查
4. 再看平台入口
5. 再看考勤
6. 再看多维表
7. 不稳就回滚

## 13. 不允许的现场行为

以下行为默认不允许：

1. 未备份直接升级
2. 预检失败仍继续升级
3. 只验证考勤、不验证多维表
4. 只验证多维表、不验证考勤
5. 出问题后在线上边改边试多个方向
6. 没有记录就宣布升级成功

## 14. 最终要求

现场值班的目标不是“把命令跑完”，而是：

1. 平台恢复可用
2. 考勤恢复可用
3. 多维表恢复可用
4. 有明确记录
5. 有明确结论

## 15. 一句话版

平台升级值班只做五件事：

1. 预检
2. 升级
3. 健康检查
4. 双侧 smoke
5. 不稳就回滚
