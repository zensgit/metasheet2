# On-Prem Docker GC Verification

日期：2026-04-03

## 范围

验证 `142.171.239.56` 的 Docker 垃圾回收脚本、cron 安装状态，以及根分区利用率门禁。

## 事故前置事实

执行：

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 \
  "df -h / /tmp"
```

实际结果：

- `/dev/vda2 77G 74G 0 100% /`
- 说明 `No space left on device` 是整盘写满，不是本机磁盘问题

## 实际执行

### 1. Shell / Python 语法

执行：

```bash
bash -n scripts/ops/dingtalk-onprem-docker-gc.sh
bash -n scripts/ops/install-dingtalk-onprem-docker-gc.sh
bash -n scripts/ops/verify-dingtalk-onprem-docker-gc.sh
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
```

结果：

- 通过

### 2. 远端安装前状态

执行：

```bash
bash scripts/ops/install-dingtalk-onprem-docker-gc.sh --print-status
```

结果：

- `script_exists=false`
- `log_dir_exists=false`
- `cron_present=false`
- `schedule=17 4 * * *`

### 3. 远端安装

执行：

```bash
bash scripts/ops/install-dingtalk-onprem-docker-gc.sh
```

结果：

- 通过
- 已安装：
  - `/home/mainuser/bin/dingtalk-onprem-docker-gc.sh`
- 已安装 cron：
  - `17 4 * * * REMOTE_SELF=true /home/mainuser/bin/dingtalk-onprem-docker-gc.sh >> /home/mainuser/docker-gc-runs/cron.log 2>&1`

### 4. 实际 GC 验证

执行：

```bash
bash scripts/ops/verify-dingtalk-onprem-docker-gc.sh
```

实际结果：

- `script_exists=true`
- `cron_present=true`
- `root.use.after=27%`
- `availKBlocks=56695156`
- `ok=true`

### 5. 稳定性门禁补强验证

执行：

```bash
bash scripts/ops/dingtalk-oauth-stability-check.sh
```

实际结果：

- `health.status=ok`
- `storage.rootUse=46% availKBlocks=41847364 maxUse=95%`
- `healthy=true`

说明：

- 现在稳定性检查会显式输出根分区使用率
- 后续若根分区再次接近写满，会直接把日检 / GitHub lite recording 打成 `healthy=false`

### 6. 手工补跑 drill

执行：

```bash
bash ~/.codex/memories/metasheet2-onprem-schedule/scripts/ops/dingtalk-onprem-alert-drill.sh
```

实际结果：

- `PASS`
- `drillId=drill-1775228580`
- `firingObserved=true`
- `resolvedObserved=true`

## 验证结论

这条修复已闭环：

- 根分区 `100%` 的直接根因已定位为 Docker 历史镜像 / build cache 堆积
- 远端已具备定期 GC 能力
- 稳定性检查已补上存储门禁
- 手工补跑 drill 已恢复成功
