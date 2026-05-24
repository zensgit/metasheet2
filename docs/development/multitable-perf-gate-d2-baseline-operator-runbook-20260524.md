# Multitable D2 Baseline — Operator Runbook

Date: 2026-05-24
Status: 可执行 runbook（operator-triggered post-merge follow-up to PR #1808）
Anchors:
- Design MD: `docs/development/multitable-perf-gate-d2-design-20260524.md` (v3)
- Impl verification MD: `docs/development/multitable-perf-gate-d2-impl-verification-20260524.md` (v1)
- Locked decisions memory: `project_multitable_d2_perf_gate_design_locked.md` next-link section

---

## 0. 角色与原则

- **operator role**: 你（zensgit / huazhou）— 仓库 admin、可配 GH secrets/vars、可触发 workflow_dispatch、对 staging server 有访问权
- **scope discipline**: 本 runbook **只**做"准备 + smoke + 12 baseline dispatches + 收集"。**不**做 threshold 锁定 / virtualization / 优化（留独立 review-and-lock PR + verdict-driven PR）
- **K3 PoC stage-1 lock**: 全程不触 K3 / integration-core / attendance / `apps/web/src/**` / `packages/core-backend/src/**` 任何文件

---

## 1. 配置 GH secrets / vars

### 1.1 必填 secret

```bash
# AUTH_TOKEN — 长期有效 staging admin JWT；NEVER 在 echo/log 中暴露
gh secret set MULTITABLE_PERF_AUTH_TOKEN --repo zensgit/metasheet2
# (粘贴 token 后回车；终端不回显)
```

验证 secret 已设：
```bash
gh secret list --repo zensgit/metasheet2 | grep MULTITABLE_PERF_AUTH_TOKEN
```

### 1.2 必填 vars

```bash
# API base — host root（with or without trailing /api；workflow 内 normalize）
gh variable set MULTITABLE_PERF_API_BASE --repo zensgit/metasheet2 \
  --body 'http://STAGING_HOST:8081'

# FE base — frontend host root（no trailing slash）
gh variable set MULTITABLE_PERF_FE_BASE --repo zensgit/metasheet2 \
  --body 'http://STAGING_HOST:8899'

# BASE_ID — 见 §2 创建后回填
```

替换 `STAGING_HOST` 为实际 staging 主机 / IP。

验证 vars：
```bash
gh variable list --repo zensgit/metasheet2 | grep MULTITABLE_PERF_
```

预期输出 3 行（API_BASE / FE_BASE / BASE_ID（待 §2））。

---

## 2. 预创建 reusable multitable base

无 `DELETE /api/multitable/bases/:id` endpoint — 必须 pre-create **1 个** base 复用所有 dispatch。

```bash
# 临时本地变量（仅 shell session）
export API_BASE="http://STAGING_HOST:8081"
export TOKEN="$(gh secret list --repo zensgit/metasheet2 >/dev/null && echo 'set-token-locally-for-this-curl-only')"
# 实际：用你手上的 admin JWT；NEVER 用 echo 暴露
# 推荐做法：把 token 写到一个本地非 git 跟踪的临时文件，curl 引用，然后 shred 删除

curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"d2-perf-baseline-shared","color":"#42b883"}' \
  "$API_BASE/api/multitable/bases"
```

预期响应：
```json
{
  "ok": true,
  "data": {
    "base": {
      "id": "base_xxxxxxxx",
      "name": "d2-perf-baseline-shared",
      ...
    }
  }
}
```

写入 GH var：
```bash
gh variable set MULTITABLE_PERF_BASE_ID --repo zensgit/metasheet2 \
  --body 'base_xxxxxxxx'    # ← 从上方 response.data.base.id 复制
```

验证：
```bash
gh variable list --repo zensgit/metasheet2 | grep MULTITABLE_PERF_BASE_ID
```

清理本地临时 token：
```bash
unset TOKEN
```

---

## 3. 验证 staging server `ENABLE_YJS_COLLAB!=true`

**为什么必查**：harness workflow `ENABLE_YJS_COLLAB=false` 只影响 GH runner 进程，**不**传播到远程 server。若远程 staging server 实际开了 Yjs，每条 record 触发 invalidation hook → backend insert p95 含 Yjs cost → verdict B/C/D 与 E 隔离失效（design v3 §13 verdict E deferred 失效）。

### 3.1 优先：ssh + 查 process env

```bash
ssh STAGING_HOST 'docker ps --filter "name=metasheet" --format "{{.Names}}"' \
  # 假设容器名包含 metasheet
ssh STAGING_HOST 'docker exec <container_name> env | grep ENABLE_YJS_COLLAB'
```

**期望输出之一**：
- 空（未设 → 默认 false ✓）
- `ENABLE_YJS_COLLAB=false` ✓
- `ENABLE_YJS_COLLAB=0` 或其它非 `true` 字符串 ✓

**异常输出**（必修）：
- `ENABLE_YJS_COLLAB=true` ❌ — 必须先关掉、重启服务后再继续

### 3.2 备选：发请求 inferred check

如果无 ssh 权限，可发一个简单 POST /records 然后 GET 该 record 的 history endpoint；若 Yjs 关，invalidation chain 是惰性的；但这不是确定性 check，强烈推荐 ssh 方式。

### 3.3 记录到 §6 收集 metadata

把 verify 结果（具体值 + 时间戳）写入本次 baseline run 笔记，作为 verification 证据：

```text
[precond] staging API @ http://STAGING_HOST:8081 verified ENABLE_YJS_COLLAB=<value> at <ISO-timestamp>
```

---

## 4. 1k smoke（mount/primary + scroll/primary）

跑前 sanity check — 触发**最小** dispatch（1k rows，最快 ~2 min）验证 harness end-to-end OK 后再进 12-run 完整 baseline。

### 4.1 触发 smoke dispatches（2 个）

```bash
gh workflow run multitable-perf-baseline.yml --repo zensgit/metasheet2 \
  -f rows=1000 -f metric_profile=mount -f scenario=primary

gh workflow run multitable-perf-baseline.yml --repo zensgit/metasheet2 \
  -f rows=1000 -f metric_profile=scroll -f scenario=primary
```

或 inline 一次：
```bash
for mp in mount scroll; do
  gh workflow run multitable-perf-baseline.yml --repo zensgit/metasheet2 \
    -f rows=1000 -f metric_profile="$mp" -f scenario=primary
done
```

### 4.2 等待完成 + 查 status

```bash
# 列出最近 5 个 run，过滤 baseline workflow
gh run list --repo zensgit/metasheet2 \
  --workflow multitable-perf-baseline.yml --limit 5

# 实时 watch（替换 RUN_ID 为上方输出第一列）
gh run watch RUN_ID --repo zensgit/metasheet2
```

预期单个 1k smoke 完成 ≤5 min。两个 smoke ≤10 min（并发执行）。

### 4.3 验证 smoke 成功标准

下载 artifact + 检查 JSON：

```bash
# 下载 smoke artifacts 到本地（替换 RUN_ID）
mkdir -p /tmp/d2-smoke-artifacts
gh run download RUN_ID --repo zensgit/metasheet2 --dir /tmp/d2-smoke-artifacts

# 列出 baseline JSON
find /tmp/d2-smoke-artifacts -name 'baseline-*.json' -type f
```

每个 JSON sanity check（用 `jq`）：

```bash
# mount profile artifact
jq '{
  baselineId,
  rows,
  scenario,
  metricProfile,
  ttiMs: .metrics.ttiMs,
  domNodesAfterMount: .metrics.domNodes.afterMount,
  jsHeapMbAfterMount: .metrics.jsHeapMb.afterMount,
  longTaskCount: .metrics.longTask.count,
  notes_count: (.notes | length)
}' /tmp/d2-smoke-artifacts/.../baseline-1000-mount-primary-*.json
```

**Pass 标准**（任一不满足即排查 harness）：
- `ttiMs` > 0 且 < 60000（< 1 min mount 是合理的）
- `domNodes.afterMount` > 0（grid 实际渲染了）
- `jsHeapMb.afterMount` > 0
- `longTask.count` 不为 null（PerformanceObserver 实际拿到数据）
- `notes` 含 `targetSheetId=...` + `targetViewId=...` + `baseline assumes ENABLE_YJS_COLLAB!=true...`

```bash
# scroll profile artifact
jq '{
  scrollFpsP50: .metrics.scrollFps.p50,
  scrollFpsP95: .metrics.scrollFps.p95,
  domNodesDelta: .metrics.domNodes.delta,
  jsHeapMbDelta: .metrics.jsHeapMb.delta
}' /tmp/d2-smoke-artifacts/.../baseline-1000-scroll-primary-*.json
```

**Pass 标准**：
- `scrollFps.p50` > 0（rAF 采样有数据；scroll 后 1500ms settle）
- `scrollFps.p95` > 0（数字越小代表越差，但只要非 null 就说明采样成功）
- `domNodes.delta` 不为 null

### 4.4 检查 backend metrics（mjs 半）

```bash
# 找 backend JSON（同 baselineId 不同 metricProfile=backend）
find /tmp/d2-smoke-artifacts -name 'baseline-*-backend-*.json' -type f

jq '{
  backendSeedAggregateMs: .metrics.backendSeedAggregateMs,
  backendInsertP50: .metrics.backendInsertMs.p50,
  backendInsertP95: .metrics.backendInsertMs.p95,
  backendInsertP99: .metrics.backendInsertMs.p99,
  insertSampleCount: .metrics.backendInsertMs.count,
  backendQueryP50: .metrics.backendQueryMs.p50,
  backendQueryP95: .metrics.backendQueryMs.p95,
  querySampleCount: .metrics.backendQueryMs.count
}' /tmp/d2-smoke-artifacts/.../baseline-1000-backend-primary-*.json
```

**Pass 标准**（critical — 防 review #1 静默 null bug 复发）：
- `backendInsertMs.count` ≥ 160（即 ≥80% of 200 sample size，per MIN_SAMPLE_SUCCESS_RATIO=0.8）
- `backendQueryMs.count` ≥ 40（≥80% of 50）
- `backendInsertMs.p95` 非 null 且 > 0
- `backendQueryMs.p95` 非 null 且 > 0
- `backendSeedAggregateMs` > 0

### 4.5 验证 rollback

```bash
# 检查 sheet 已删除
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/api/multitable/sheets?baseId=$BASE_ID" \
  | jq '.data.sheets | length'
```

预期：`0`（rollback 干净删除每 dispatch 创建的 sheet；只有 reused base 残留）。

如果 > 0，说明 rollback 路径出错 — 排查后再继续。

### 4.6 Pass / fail decision

- **全 pass** → 进入 §5 全量 12-run baseline
- **任一 fail** → 停。读 GH run logs；如果是 harness bug，开 fix PR（不在 v1 baseline run 期间顺手改 harness）；如果是 staging 配置问题（auth / base / yjs 等），修配置后**重新跑 §4 smoke**

---

## 5. 完整 12 dispatches baseline

3 rows × 2 metricProfile (mount + scroll) × 2 scenario (primary + expanded) = 12

### 5.1 触发 wrapper

```bash
# Save to /tmp/d2-baseline-trigger.sh; chmod +x; run
cat > /tmp/d2-baseline-trigger.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO="zensgit/metasheet2"

for rows in 10000 50000 100000; do
  WF=$([[ "$rows" == "10000" ]] && echo "multitable-perf-baseline.yml" || echo "multitable-perf-highscale.yml")
  for mp in mount scroll; do
    for sc in primary expanded; do
      echo "[dispatch] rows=$rows wf=$WF profile=$mp scenario=$sc"
      gh workflow run "$WF" --repo "$REPO" \
        -f rows="$rows" -f metric_profile="$mp" -f scenario="$sc"
      sleep 2   # 避免 GH API rate limit 突发
    done
  done
done

echo "[done] 12 dispatches triggered. Monitor via:"
echo "  gh run list --repo $REPO --workflow multitable-perf-baseline.yml --limit 10"
echo "  gh run list --repo $REPO --workflow multitable-perf-highscale.yml --limit 10"
EOF
chmod +x /tmp/d2-baseline-trigger.sh
/tmp/d2-baseline-trigger.sh
```

### 5.2 监控

```bash
# baseline (10k rows) — 30 min timeout each
gh run list --repo zensgit/metasheet2 --workflow multitable-perf-baseline.yml --limit 10

# highscale (50k / 100k rows) — 90 min timeout each（100k chunked XLSX seed 15-30 min server-side）
gh run list --repo zensgit/metasheet2 --workflow multitable-perf-highscale.yml --limit 10
```

ETA：
- 10k × 4 dispatches：~30 min（GH runner 并发上限通常 10-20 个 free-tier 同账户，应可并发完成）
- 50k × 4 dispatches：~60 min
- 100k × 4 dispatches：~90 min
- **总 wallclock：~1.5h**（并发情况下）；纯串行 ~10h（不要串行）

### 5.3 失败重试

如果某个 dispatch 失败：

```bash
# 查具体 run logs
gh run view RUN_ID --repo zensgit/metasheet2 --log-failed

# 修配置后重新触发那一个 tuple
gh workflow run multitable-perf-baseline.yml --repo zensgit/metasheet2 \
  -f rows=10000 -f metric_profile=mount -f scenario=primary
```

**绝不**在 12-run 期间改 harness（会污染 baseline 一致性）。如发现 harness bug：
1. 暂停剩余 dispatches
2. 收集已有成功 artifacts
3. 开 fix PR 修 harness
4. fix PR merge 后**重新跑整个 12-run baseline**（旧数据作废）

---

## 6. Artifact 收集 + 整理

### 6.1 下载全部 artifacts

```bash
ROOT=/tmp/d2-baseline-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ROOT"

# 列出最近 12+ run（按时间倒序）
gh run list --repo zensgit/metasheet2 \
  --workflow multitable-perf-baseline.yml --limit 8 --json databaseId,name,status,conclusion \
  | jq -r '.[] | select(.conclusion == "success") | .databaseId' \
  > "$ROOT/baseline-run-ids.txt"

gh run list --repo zensgit/metasheet2 \
  --workflow multitable-perf-highscale.yml --limit 8 --json databaseId,name,status,conclusion \
  | jq -r '.[] | select(.conclusion == "success") | .databaseId' \
  > "$ROOT/highscale-run-ids.txt"

# 下载每个 successful run 的 artifact
while read -r run_id; do
  echo "[download] run $run_id"
  gh run download "$run_id" --repo zensgit/metasheet2 --dir "$ROOT/run-$run_id"
done < "$ROOT/baseline-run-ids.txt"

while read -r run_id; do
  echo "[download] run $run_id"
  gh run download "$run_id" --repo zensgit/metasheet2 --dir "$ROOT/run-$run_id"
done < "$ROOT/highscale-run-ids.txt"
```

### 6.2 整理目录

```bash
# Aggregate all JSON files into one flat dir for review
mkdir -p "$ROOT/all-json"
find "$ROOT" -name 'baseline-*.json' -type f -exec cp {} "$ROOT/all-json/" \;

ls "$ROOT/all-json/" | wc -l
# 预期：24 files（每 dispatch 产 2 file: backend + frontend）
```

### 6.3 一致性 sanity check

```bash
# 检查每个 dispatch 是否同时有 backend + frontend pair
cd "$ROOT/all-json"

# Backend half
ls baseline-*-backend-*.json | wc -l
# 预期 12

# Frontend half (mount + scroll 各 6)
ls baseline-*-mount-*.json | wc -l
# 预期 6

ls baseline-*-scroll-*.json | wc -l
# 预期 6

# Aggregate sample success ratios
for f in baseline-*-backend-*.json; do
  jq -r '. as $r | "\($r.rows) \($r.scenario) insert_count=\(.metrics.backendInsertMs.count) query_count=\(.metrics.backendQueryMs.count)"' "$f"
done
```

期望每个 backend JSON 显示 `insert_count≥160 query_count≥40`（per MIN_SAMPLE_SUCCESS_RATIO=0.8）。

### 6.4 收集 metadata 笔记

把以下信息保存到 `$ROOT/run-metadata.txt`：

```text
[d2-baseline run notes]
Date: <ISO>
Operator: <github username>
Staging API: <API_BASE 实际值>
Staging FE: <FE_BASE 实际值>
Reused base id: <MULTITABLE_PERF_BASE_ID 值>
Server ENABLE_YJS_COLLAB verified: <value + how verified per §3>
Total dispatches: 12 (3 rows × 2 profile × 2 scenario)
Successful: <count>
Failed/retried: <list run IDs + reasons>
Total wallclock: <duration>
```

这个笔记是 review-and-lock PR 的必要附件。

---

## 7. Review-and-lock PR scope reminder（不在本 runbook 范围）

收集完 12 JSON 后，**下一独立 PR**（不在本 runbook scope）：

### 7.1 该 PR 做什么

- Propose §7.2 thresholds 数值（仅 mount + scroll + DOM/heap + backend 族；edit/sort/filter/group 族留 follow-up impl PR 后）
- 输出首 verdict ∈ {A / B / C / D；E 不输出}
- **跑第 2 次复跑稳定性验证**（再触发 12 dispatches，比对 round-1 vs round-2 差异）
- Lock thresholds 为 CI gate baseline

### 7.2 该 PR 不做什么（绝对不顺手）

- ❌ **不**实现 edit/sort/filter/group 4 个 metric profile（独立 follow-up impl PR）
- ❌ **不**启动 grid virtualization / server-side / client algorithm 任一优化 PR（按 verdict 独立 PR）
- ❌ **不**修改 harness 代码（除非首跑暴露 harness bug，这种情况下应**先**修 harness + 重新 baseline run + 再 review-and-lock）
- ❌ **不**改 design MD（design v4 candidate 若需，独立 docs PR 处理 D1-D6 design deltas）

### 7.3 Verdict 决策树（决定下一 PR 路径）

| Verdict | 触发条件（具象 baseline 数据驱动）| 后续 PR |
|---|---|---|
| **A_CSS_sufficient** | 所有指标 < proposed threshold（含 DOM `afterMountMax` 不越线）| 取消 benchmark v2 §9 #2 grid virtualization；effort 转 #3 D3 permission matrix |
| **B_frontend_dom_memory_bound** | DOM `afterMountMax` 或 `per10kSlope` 越线 ∨ JS heap 越线 ∨ scroll FPS 越线 | **唯一**解锁 grid virtualization PR |
| **C_backend_query_bound** | `backendInsertMs.p95` 或 `backendQueryMs.p95` 越线 + frontend 合格 | 独立 server-side optimization PR（virtualization 不解此问题）|
| **D_client_algorithm_bound** | edit/sort/filter/group apply 越线 + DOM/heap + backend 合格（v1 不出此 verdict，待 follow-up impl 后才能完整）| 独立 client algorithm optimization PR |
| **E_yjs_sync_overhead_bound** | multi-client scenario 越线（v1 不输出 — 没有 multi-client metric profile）| 独立 realtime perf PR |

verdict 可叠加（B+C / B+D 等），分别启对应 PR。

---

## 8. Cleanup（baseline 全完成后）

```bash
# 1. 手动删 reused base via UI 或 API
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/api/multitable/<unknown-endpoint>"
# (再确认：no DELETE /bases endpoint exists; manual UI deletion 或 直接 DB DELETE 才行)

# 2. 清理本地 artifacts（review-and-lock PR merge 后保留 ~30 天给 audit，再删）
rm -rf "$ROOT"

# 3. 清理本地临时 token / shell variables
unset TOKEN API_BASE BASE_ID
```

---

## 9. Anti-checklist — 本 runbook 期间不做的事

| ❌ 绝不顺手 | 原因 |
|---|---|
| 改 harness mjs / spec / yml | 会污染 baseline 一致性；如发现 bug，停 + 修 fix PR + 重新 baseline run |
| 实现 edit/sort/filter/group | 独立 follow-up impl PR 范围 |
| 启 virtualization / server / algorithm 优化 | 依赖 verdict + threshold lock；早做 = 盲改 |
| 改 design MD | design deltas D1-D6 留 docs-only follow-up PR |
| 改 K3 / integration-core / attendance / apps/web/src | 全程红线 |
| 在 GH issue / PR 里 paste AUTH_TOKEN | 安全 — 仅本地 shell session 用 |
| 配 baseline workflow `schedule` / `push` trigger | workflow_dispatch only 是显式锁定 |
| 跑 baseline run 期间合并任何 multitable 相关 PR | 会污染 staging 数据；review-and-lock PR 前别 merge 其它 multitable PR |

---

## 10. 失败模式 / 排查速查

| 症状 | 排查方向 |
|---|---|
| dispatch 立即 fail @ "Validate required env" | secrets/vars 配置缺失 — 回 §1 + §2 + §3 检查 |
| dispatch 失败 @ "Backend seed + measure" with `[d2-perf] BASE_ID required` | `MULTITABLE_PERF_BASE_ID` 没设 — 回 §2 |
| dispatch 失败 @ "Backend seed + measure" with `Cannot find module 'xlsx'` | pnpm install 未跑或 xlsx 不在 `packages/core-backend` deps — 检 `pnpm-lock.yaml` |
| dispatch 失败 @ backend insert with `success ratio X% below MIN_SAMPLE_SUCCESS_RATIO=80%` | staging 后端不稳 / auth token 过期 — 检 logs，单独 curl POST /records 验证 |
| dispatch 失败 @ backend query with `Unknown fieldId` | 不应再发生（precision pass 2 fix）— 如果发生说明 mjs 代码回归，开 fix PR |
| dispatch 失败 @ "Frontend measure (Playwright)" with `Perf gate requires reachable API/FE` | API_BASE_URL / FE_BASE_URL 不可达 — 排查 staging 状态 |
| dispatch 失败 @ Playwright with `Cannot resolve target` | STATE_FILE 路径不一致（应已 fix）/ 或 backend step 没成功写 state — 检 backend step logs |
| Yjs 显示 ON 在 staging | §3 precondition 没满足 — 关 staging Yjs，重启服务，重新 §4 smoke |
| artifact 缺失 / 空 | 检 workflow upload-artifact step；可能是 OUTPUT_DIR 路径错（precision pass 1 fix），如发生说明回归 |

---

## 11. Changelog

### v1 (2026-05-24) — Initial operator runbook

- 11 sections + anti-checklist + 排查速查
- 6 步主流程（user 提议）：preconditions / pre-create base / verify Yjs / 1k smoke / 12 baseline / artifact 收集
- Review-and-lock PR scope 明确：只锁 thresholds + verdict，不顺手做任何优化
- 与 design + impl verification MD + memory 锁定决策完全对齐
