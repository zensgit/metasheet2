# Attendance 上线当天执行清单（可打勾）

适用场景：Windows Server + Ubuntu VM，本地化安装包部署（不使用 git 拉取）。

环境：

- 客户名称：`________________`
- 服务器地址：`________________`
- 执行日期：`________________`
- 执行人：`________________`

---

## A. 交付包确认（开始前）

- [ ] 交付包文件已就位：`metasheet-attendance-onprem-v2.5.0-20260306-r2-gh.tgz`
- [ ] 校验文件已就位：`SHA256SUMS`
- [ ] 执行校验：

```bash
cd /opt/metasheet
scripts/ops/attendance-onprem-package-verify.sh /path/to/metasheet-attendance-onprem-v2.5.0-20260306-r2-gh.tgz
```

- [ ] 校验输出包含：`Package verify OK`

## B. 基础环境确认（Ubuntu VM）

- [ ] Node.js 20 可用：`node -v`
- [ ] pnpm 可用：`pnpm -v`
- [ ] PostgreSQL 可用：`systemctl status postgresql --no-pager`
- [ ] Redis 可用：`systemctl status redis-server --no-pager`
- [ ] Nginx 可用：`systemctl status nginx --no-pager`

## C. 数据库初始化

- [ ] 已执行数据库实例创建（若已存在则跳过）：

```sql
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
```

- [ ] `docker/app.env` 中 `DATABASE_URL` 与数据库密码一致

## D. 环境文件配置

- [ ] `docker/app.env` 已配置并复核：
  - [ ] `PRODUCT_MODE=attendance`
  - [ ] `DEPLOYMENT_MODEL=onprem`
  - [ ] `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`
  - [ ] `ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import`
  - [ ] `ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000`
  - [ ] `JWT_SECRET` 非默认值
  - [ ] `POSTGRES_PASSWORD` 非默认值
  - [ ] `DATABASE_URL` 非 `change-me`

- [ ] 上传目录已创建：

```bash
mkdir -p /opt/metasheet/storage/attendance-import
```

## E. 安装执行

- [ ] 执行安装：

```bash
cd /opt/metasheet
chmod +x scripts/ops/attendance-onprem-package-install.sh
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
ADMIN_NAME="Administrator" \
scripts/ops/attendance-onprem-package-install.sh
```

- [ ] 安装输出无 ERROR
- [ ] 输出包含：`Deployment finished.`

## F. 健康检查

- [ ] 执行健康检查：

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/attendance-onprem-healthcheck.sh
```

- [ ] 健康检查输出包含：`Healthcheck OK`
- [ ] 访问页面成功：`http://<server-ip>/attendance`

## G. 功能快验（上线最小闭环）

- [ ] 管理员可登录
- [ ] 员工可 `Check In / Check Out`
- [ ] 可提交补卡申请
- [ ] 审批人可通过/拒绝申请
- [ ] 管理后台保存设置成功（无卡死）
- [ ] 导入 preview/commit 可完成（至少 1 条样例）

## H. 上线完成记录

- [ ] 客户确认可用
- [ ] 记录上线版本：`v2.5.0-20260306-r2-gh`
- [ ] 记录管理员账号：`________________`
- [ ] 记录异常与处理：`________________`

## I. 故障回滚预案（仅应急）

- [ ] 上一个可用包已备份
- [ ] `docker/app.env` 已备份
- [ ] 回滚命令已演练：

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
BASE_URL="http://127.0.0.1" \
scripts/ops/attendance-onprem-package-upgrade.sh
```
