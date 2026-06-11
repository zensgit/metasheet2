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

**Token lifecycle**：runbook 全程通过 shell session 持有 `TOKEN` / `API_BASE` / `BASE_ID` env vars（不导出为脚本变量、不写文件、不进 history）。所有 step 用同一 session，§8 cleanup 时 `unset`。

```bash
# 1) 用 stty + IFS read 输入 JWT — 无回显、不入 shell history、不留剪贴板
#    portable across bash + zsh（read -rsp 是 bash 特性，zsh 行为不一致；
#    这种 stty-based 方案在两 shell 下都按预期工作）。
printf 'Staging admin JWT: '
stty -echo
IFS= read -r TOKEN
stty echo
printf '\n'
export TOKEN

# 2) 设 staging endpoints + 本地归一化（与 workflow yml 同款，strip 尾部 / 和 /api）
#    避免 operator 复用带 /api 的 var 值后产生 /api/api/multitable/bases
export API_BASE='http://STAGING_HOST:8081'   # 或 'http://STAGING_HOST:8081/api'
API_BASE="${API_BASE%/}"
API_BASE="${API_BASE%/api}"
export API_BASE
echo "[normalize] API_BASE=$API_BASE"

# 3) curl POST /bases — 复用同一归一化后的 TOKEN + API_BASE
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

写入 GH var + 同时保留 shell-session env var 给后续 step 用：

```bash
# 把响应里的 base id 同时记到本地 env + GH var
export BASE_ID='base_xxxxxxxx'    # ← 从上方 response.data.base.id 复制

gh variable set MULTITABLE_PERF_BASE_ID --repo zensgit/metasheet2 \
  --body "$BASE_ID"
```

验证：
```bash
gh variable list --repo zensgit/metasheet2 | grep MULTITABLE_PERF_BASE_ID
```

**注意**：`TOKEN` / `API_BASE` / `BASE_ID` env vars 保留到 §8 cleanup 才 unset — §4.5 rollback 验证 / §6 metadata 收集 都会复用。

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
# 检查 sheet 已删除（$TOKEN / $API_BASE / $BASE_ID 从 §2 shell session 继承）
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

### 5.1 触发 wrapper — **必须捕获 dispatched run IDs**

防 §6 收集污染（§4 smoke 已跑、`gh run list --limit` 无法保证只拿 baseline runs）：wrapper 在每次 dispatch 后立即查最新 run + 通过 `run-name` 字段（含 inputs.rows/profile/scenario）匹配，写入 `$ROOT/dispatched-run-ids.txt`。§6 只下载这个 file 里的 IDs。

```bash
# 预设 ROOT（同时给 §6 用）
export ROOT="/tmp/d2-baseline-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT"
echo "[init] ROOT=$ROOT"

# Save to $ROOT/d2-baseline-trigger.sh; chmod +x; run
cat > "$ROOT/d2-baseline-trigger.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO="zensgit/metasheet2"
RUNS_FILE="${ROOT}/dispatched-run-ids.txt"
: > "$RUNS_FILE"   # truncate fresh
echo "# wf,rows,profile,scenario,run_id,dispatch_started_utc" >> "$RUNS_FILE"

for rows in 10000 50000 100000; do
  WF=$([[ "$rows" == "10000" ]] && echo "multitable-perf-baseline.yml" || echo "multitable-perf-highscale.yml")
  for mp in mount scroll; do
    for sc in primary expanded; do
      # **关键防回归**：先记 dispatch 起始时间（UTC ISO8601），过滤时强制
      # createdAt >= dispatch_started + event=="workflow_dispatch"，防 polling
      # 期间漏抓而错绑同 tuple 历史 run 的 ID 进 baseline。
      dispatch_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      echo "[dispatch] rows=$rows wf=$WF profile=$mp scenario=$sc started=$dispatch_started"
      gh workflow run "$WF" --repo "$REPO" \
        -f rows="$rows" -f metric_profile="$mp" -f scenario="$sc"

      # Polling 最多 6 × 5s = 30s
      run_id=""
      for attempt in 1 2 3 4 5 6; do
        sleep 5
        # 三重过滤：(1) event=workflow_dispatch（排掉 schedule/push 触发的同 tuple 历史）
        #          (2) createdAt >= dispatch_started（排掉本轮触发之前的同 tuple 历史）
        #          (3) displayTitle 精确匹配 rows/profile/scenario（确认是这个 tuple）
        #          --limit 20 给 polling 窗口足够 headroom
        run_id=$(gh run list --repo "$REPO" --workflow "$WF" --limit 20 \
          --json databaseId,displayTitle,createdAt,event \
          --jq "[.[] | select(.event == \"workflow_dispatch\") | select(.createdAt >= \"$dispatch_started\") | select(.displayTitle | test(\"rows=$rows.*profile=$mp.*scenario=$sc\"))] | sort_by(.createdAt) | last | .databaseId // empty" 2>/dev/null || echo "")
        if [[ -n "$run_id" && "$run_id" != "null" ]]; then break; fi
      done
      if [[ -z "$run_id" ]]; then
        echo "::warning::Could not capture run_id for ($rows, $mp, $sc) — 用 gh run list --repo $REPO --workflow $WF --created \">$dispatch_started\" --limit 10 手动补查后写到 dispatched-run-ids.txt" >&2
        echo "${WF},${rows},${mp},${sc},,${dispatch_started}" >> "$RUNS_FILE"
      else
        echo "[captured] run_id=$run_id"
        echo "${WF},${rows},${mp},${sc},${run_id},${dispatch_started}" >> "$RUNS_FILE"
      fi

      sleep 2   # GH API rate limit 缓冲
    done
  done
done

echo "[done] 12 dispatches triggered. Run IDs at: $RUNS_FILE"
echo
echo "Monitor via:"
echo "  gh run list --repo $REPO --workflow multitable-perf-baseline.yml --limit 10"
echo "  gh run list --repo $REPO --workflow multitable-perf-highscale.yml --limit 10"
echo
echo "Or watch a specific captured run:"
echo "  gh run watch <run_id> --repo $REPO"
EOF
chmod +x "$ROOT/d2-baseline-trigger.sh"
"$ROOT/d2-baseline-trigger.sh"

# Verify captured IDs after trigger:
cat "$ROOT/dispatched-run-ids.txt"
```

预期 `dispatched-run-ids.txt` 含 13 行（1 header + 12 dispatches），所有 12 行的 `run_id` 列非空。若有空行 → manual `gh run list` 补查后回填。

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

如果某个 dispatch 失败（**critical**：retry 必须同时替换 `dispatched-run-ids.txt` 里那一行的 `run_id`，否则 §6 仍会按旧失败 ID 下载 + pre-flight check 直接退出）：

```bash
# A) 查具体 run logs
gh run view <OLD_FAILED_RUN_ID> --repo zensgit/metasheet2 --log-failed

# B) 决定要重试的 tuple（替换变量）
WF='multitable-perf-baseline.yml'   # 或 multitable-perf-highscale.yml
RETRY_ROWS=10000
RETRY_MP=mount
RETRY_SC=primary

# C) 重新触发 + 用同 §5.1 三重过滤捕获新 run_id
dispatch_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run "$WF" --repo zensgit/metasheet2 \
  -f rows="$RETRY_ROWS" -f metric_profile="$RETRY_MP" -f scenario="$RETRY_SC"

new_run_id=""
for attempt in 1 2 3 4 5 6; do
  sleep 5
  new_run_id=$(gh run list --repo zensgit/metasheet2 --workflow "$WF" --limit 20 \
    --json databaseId,displayTitle,createdAt,event \
    --jq "[.[] | select(.event == \"workflow_dispatch\") | select(.createdAt >= \"$dispatch_started\") | select(.displayTitle | test(\"rows=$RETRY_ROWS.*profile=$RETRY_MP.*scenario=$RETRY_SC\"))] | sort_by(.createdAt) | last | .databaseId // empty" 2>/dev/null || echo "")
  if [[ -n "$new_run_id" && "$new_run_id" != "null" ]]; then break; fi
done

if [[ -z "$new_run_id" ]]; then
  echo "::error::retry capture failed; manual lookup via gh run list --created \">$dispatch_started\""
  exit 1
fi
echo "[retry] new run_id=$new_run_id"

# D) **替换** dispatched-run-ids.txt 里那一行（grep + awk-based portable replace；
#    avoid `sed -i` 的 macOS vs Linux 差异）
new_line="${WF},${RETRY_ROWS},${RETRY_MP},${RETRY_SC},${new_run_id},${dispatch_started}"
tmpfile=$(mktemp)
grep -v -E "^${WF},${RETRY_ROWS},${RETRY_MP},${RETRY_SC}," "$ROOT/dispatched-run-ids.txt" > "$tmpfile"
echo "$new_line" >> "$tmpfile"
mv "$tmpfile" "$ROOT/dispatched-run-ids.txt"

# E) 验证替换成功
grep -E "^${WF},${RETRY_ROWS},${RETRY_MP},${RETRY_SC}," "$ROOT/dispatched-run-ids.txt"
# 应该只有 1 行，且 run_id 列等于 $new_run_id
```

**绝不**在 12-run 期间改 harness（会污染 baseline 一致性）。如发现 harness bug：
1. 暂停剩余 dispatches
2. 收集已有成功 artifacts（仅用作 debug，不进 baseline 数据集）
3. 开 fix PR 修 harness
4. fix PR merge 后**重新跑整个 12-run baseline**（旧 `dispatched-run-ids.txt` 作废，重新 §5.1）

---

## 6. Artifact 收集 + 整理

### 6.1 下载 artifacts —— **仅** §5.1 捕获的 12 个 run IDs

**核心防回归**：不能再用 `gh run list --limit 8` 拉"最近成功的 run"——§4 smoke 也会被收进来。直接从 `$ROOT/dispatched-run-ids.txt`（§5.1 捕获）按 IDs 下载。

```bash
# $ROOT 从 §5.1 继承（同一 shell session）
test -f "$ROOT/dispatched-run-ids.txt" || {
  echo "::error::missing $ROOT/dispatched-run-ids.txt — re-trigger §5.1 first" >&2
  exit 1
}

REPO="zensgit/metasheet2"

# Pre-flight #1: 验证 captured run_id 数量 — **必须用 awk 检查 CSV 第 5 列非空**
# v3 CSV 是 6 列（wf,rows,mp,sc,run_id,dispatch_started），空 run_id 行形如
# 'wf,10000,mount,primary,,2026-05-24T...' — 行尾是 dispatch_started 不是空，
# 所以 `grep -c -v ',$'` 会把空 run_id 行误算为已捕获 → 必须用 awk 检 $5。
captured_count=$(awk -F, 'NR > 1 && $5 != "" { count++ } END { print count + 0 }' "$ROOT/dispatched-run-ids.txt")
echo "[verify] captured run IDs: ${captured_count}/12"
if [[ "$captured_count" -lt 12 ]]; then
  echo "::error::dispatched-run-ids.txt 缺 run_id 行（第 5 列空）— 用 'gh run list ... --created \">$<行内 dispatch_started_utc>\"' 手动补查后回填那一行" >&2
  awk -F, 'NR > 1 && $5 == "" { print "  missing: " $0 }' "$ROOT/dispatched-run-ids.txt" >&2
  exit 1
fi

# Pre-flight #2: 验证 captured runs 都已 completed + success；run_id 空行硬 guard
while IFS=, read -r wf rows mp sc run_id dispatch_started; do
  [[ "$wf" == \#* || -z "$wf" ]] && continue
  [[ -n "$run_id" ]] || {
    echo "::error::missing run_id for $wf $rows $mp $sc dispatch_started=$dispatch_started" >&2
    exit 1
  }
  status=$(gh run view "$run_id" --repo "$REPO" --json status,conclusion --jq '.status + "/" + .conclusion')
  echo "[check] $wf rows=$rows mp=$mp sc=$sc run=$run_id status=$status"
  if [[ "$status" != "completed/success" ]]; then
    echo "::error::run $run_id not completed/success (got: $status). Wait or retry." >&2
    exit 1
  fi
done < "$ROOT/dispatched-run-ids.txt"

# 下载每个 captured run 的 artifact，按 (rows, profile, scenario) 命名子目录
while IFS=, read -r wf rows mp sc run_id dispatch_started; do
  [[ "$wf" == \#* || -z "$wf" ]] && continue
  [[ -n "$run_id" ]] || {
    echo "::error::missing run_id for $wf $rows $mp $sc — should have been caught by Pre-flight #1; re-run §6.1 from start" >&2
    exit 1
  }
  dir="$ROOT/run-${rows}-${mp}-${sc}-${run_id}"
  echo "[download] run_id=$run_id → $dir"
  gh run download "$run_id" --repo "$REPO" --dir "$dir"
done < "$ROOT/dispatched-run-ids.txt"
```

**核心保证**：本 step 只 touch §5.1 captured runs，§4 smoke runs 完全隔离不进 baseline 收集。

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

## 8. Cleanup（baseline 全完成 + review-and-lock PR merge 后）

### 8.1 Reused base 残留处理

无 `DELETE /api/multitable/bases/:id` endpoint（已在 §2 注释 + memory `project_multitable_d2_perf_gate_design_locked.md` §8 锁定）。不要伪造任何 DELETE 命令。三个合规选项，按可用性优先：

1. **UI 删除**（推荐）：admin 登录前端 base 管理界面 → 找到 `d2-perf-baseline-shared` → 删除。前提：UI 已有 "delete base" 功能（未必所有版本都暴露）。
2. **保留作下次复用**：把 `MULTITABLE_PERF_BASE_ID` 这 1 个 reused base 留着，下次 D2 baseline 复跑（review-and-lock 第 2 round / follow-up impl PR 之后 +24 runs / verdict-driven optimization 后 re-baseline）继续复用，**完全省下重 setup**。仅 1 个 orphan，磁盘+列表噪音极低，强烈推荐采用此路径。
3. **DBA 程序删除**：如果一定要清，走 DBA 流程独立 review（直接 SQL `DELETE FROM meta_bases WHERE id = '<BASE_ID>'`；级联删 sheets/fields/views/records via FK）。这是受控操作不应在 runbook 里写运行式命令。

### 8.2 本地 artifacts 保留 / 清理

```bash
# review-and-lock PR merge 后保留 ~30 天给 audit，到期再删
# Until then, keep $ROOT for traceability
ls "$ROOT"

# 到期清理（手动确认目录无误后执行）
# rm -rf "$ROOT"
```

### 8.3 本地 shell session 清理

```bash
# 把贯穿全 runbook 的临时 env 卸掉（zsh / bash 通用）
unset TOKEN API_BASE BASE_ID ROOT
```

**可选** — bash-only history 清理（zsh 用户跳过；zsh 的 history 由 fc 控制，行为不同；强行执行可能报错）：

```bash
# Bash-only. zsh skip. Uncomment if you really want to redact `gh secret/variable set` lines.
# history -d $(history | grep -n 'gh secret set\|gh variable set' | tail -3 | cut -d: -f1) 2>/dev/null || true
```

更稳的做法：runbook 全程在专门 shell session 跑完后直接 `exit` 关掉那个 session — history 不写到 disk 即可（前提是你的 shell 配置 `HISTFILE` 在 session 关闭时才 append）。或在 session 内提前 `unset HISTFILE` 阻止持久化。

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
| dispatch 失败 @ "Backend seed + measure" with `Cannot resolve undici package` | pnpm install 未跑或 root devDeps 缺 `undici`（S5a 起 seed-upload dispatcher 依赖）— 检 root `package.json` + `pnpm-lock.yaml` |
| dispatch 失败 @ backend insert with `success ratio X% below MIN_SAMPLE_SUCCESS_RATIO=80%` | staging 后端不稳 / auth token 过期 — 检 logs，单独 curl POST /records 验证 |
| dispatch 失败 @ backend query with `Unknown fieldId` | 不应再发生（precision pass 2 fix）— 如果发生说明 mjs 代码回归，开 fix PR |
| dispatch 失败 @ "Frontend measure (Playwright)" with `Perf gate requires reachable API/FE` | API_BASE_URL / FE_BASE_URL 不可达 — 排查 staging 状态 |
| dispatch 失败 @ Playwright with `Cannot resolve target` | STATE_FILE 路径不一致（应已 fix）/ 或 backend step 没成功写 state — 检 backend step logs |
| Yjs 显示 ON 在 staging | §3 precondition 没满足 — 关 staging Yjs，重启服务，重新 §4 smoke |
| artifact 缺失 / 空 | 检 workflow upload-artifact step；可能是 OUTPUT_DIR 路径错（precision pass 1 fix），如发生说明回归 |

---

## 11. Changelog

### v5 (2026-06-11) — S5a harness fix addendum：seed 现可承受 >300s chunk（undici dispatcher + err.cause 日志）

按 verdict（`multitable-perf-gate-d2-baseline-verdict-20260525.md` §6）的两条 harness-side 处方落地，**harness-only，不触 `packages/core-backend/src/**`，不含任何实际 perf run**：

- **Seed-upload-only undici dispatcher**：`scripts/ops/multitable-perf-baseline.mjs` 的 XLSX chunk 上传改走自定义 `undici.Agent`（`headersTimeout`/`bodyTimeout` = 1800s，env `SEED_UPLOAD_TIMEOUT_MS` 只可上调不可低于 1800s）；其余 API 调用保持 Node 默认 dispatcher 不变。此前 50k/100k seed 全部死于客户端 undici 默认 300s `headersTimeout`（~307s 墙），现在 >300s 的同步 import chunk 可存活。`undici@^6` 加为 root devDependency（lockfile 同步更新）。
- **错误日志补 `err.cause`**：harness 此前只打 `err.message`（"fetch failed"），掩盖了底层 `UND_ERR_HEADERS_TIMEOUT`；现统一经 `formatErrorWithCause()`（含 cause 链 + code）输出。
- **Chunk 大小指引（belt-and-braces）**：默认 `XLSX_CHUNK_SIZE=50000` 不变；如想让单 chunk 服务端耗时落在 verdict 验证过的安全区（~≤200s；10k chunk 实测 ~100s），设 `XLSX_CHUNK_SIZE=20000`（50k→3 chunks、100k→5 chunks）。
- 新增单测 `scripts/ops/multitable-perf-baseline-upload.test.mjs`（`pnpm run verify:multitable-perf:baseline-harness:test`，无网络）。
- **本 runbook 操作流程不变**：staging run 程序照旧；**runs 仍必须串行**（verdict §5 contention 教训：一次只 dispatch 一个）；实际 50k/100k staging run（S5b）仍是 operator-gated 的独立 opt-in，本次未执行。

### v4 (2026-05-24) — Pre-push precision pass 3 — 2 Medium + 1 Low fixes

- **(Medium) §6.1 captured_count 改 awk 检查 CSV 第 5 列非空**：v3 用 `grep -c -v ',$'` 检查"行尾非逗号"，但 v3 CSV 是 6 列（`wf,rows,mp,sc,run_id,dispatch_started_utc`）— 空 run_id 行形如 `wf,10000,mount,primary,,2026-05-24T...`，行尾是 dispatch_started 不是空，所以 grep 误算为已捕获 → 空 run_id 漏过第一道门。v4 改 `awk -F, 'NR>1 && $5 != "" { count++ }'` 精确检查第 5 列；下载 while-loop 加 `[[ -n "$run_id" ]] || exit 1` 第二道 guard。失败时 awk 同时打印缺失行帮 operator 定位。
- **(Medium) §2 token 输入 portable 化 zsh + bash 通用**：v3 用 `read -rsp` 是 bash 特性，zsh 下行为不一致（zsh 的 `read` 不接 `-s -p` 组合）。v4 改 `stty -echo + IFS= read -r TOKEN + stty echo` 在两个 shell 下都按预期无回显地读 token。
- **(Low) §6.1 missing-file guard 加 exit 1**：v3 缺失 `$ROOT/dispatched-run-ids.txt` 时只 echo 不退出，会让后续 awk/while 二级错误一串。v4 改为 `{ echo "::error::..." >&2; exit 1 }`。所有错误输出也统一重定向到 stderr (`>&2`)。

### v3 (2026-05-24) — Pre-push precision pass 2 — 3 finding fixes + 1 nit

- **(High) §5.1 run ID 捕获三重过滤**：v2 只按 `displayTitle` 匹配 `rows/profile/scenario`，polling 期间漏抓时可能误绑最近一次**历史**同 tuple run（例如 §4 smoke 跑过相同 tuple 的话）。v3 加 `event == "workflow_dispatch"` + `createdAt >= dispatch_started`（dispatch 前 `date -u +%Y-%m-%dT%H:%M:%SZ` 记下）两道过滤，`--limit` 提至 20 给 polling 留 headroom。`dispatched-run-ids.txt` 新增 `dispatch_started_utc` 列存证。
- **(Medium) §5.3 失败 retry 强制替换 dispatched-run-ids.txt 行**：v2 §5.3 只说"重新触发那一个 tuple"，但 §6.1 仍读旧 failed run_id 直接 pre-flight 失败退出。v3 补完整 retry 程序（A 查 logs / B 设 tuple / C 同 §5.1 三重过滤捕获新 run_id / D 用 portable grep+mktemp 替换那一行 / E 验证替换）— 旧 failed run 不进 §6 collection。
- **(Medium) §2 本地 curl `$API_BASE` 同步归一化**：v2 §1 告诉 operator "with or without trailing /api"，workflow yml 内 normalize，但 §2 本地 curl 没 normalize → 若 operator 复用带 `/api` 的 var 值会产 `/api/api/multitable/bases`。v3 在 §2 curl 前加 `API_BASE="${API_BASE%/}"; API_BASE="${API_BASE%/api}"; export API_BASE` 同款归一化。
- **(Nit) §8.3 `history -d` bash-only → zsh 兼容化**：原命令在 zsh 下未必可用。v3 拆为默认通用 `unset` 段 + 可选 bash-only 注释段 + 建议"用专用 shell session 跑完后 `exit`"或"`unset HISTFILE`"等更稳路径。

### v2 (2026-05-24) — Pre-push precision pass — 3 review finding fixes

- **(High) Artifact collection 反 smoke 污染**：§5.1 wrapper 新增 captured run IDs 写到 `$ROOT/dispatched-run-ids.txt`（每 dispatch 后通过 `gh run list --json displayTitle` 精确匹配 `rows=X profile=Y scenario=Z` 找最新 run）；§6.1 不再用 `gh run list --limit 8`，改读 `dispatched-run-ids.txt` 仅下载 12 个捕获 IDs。§4 smoke runs 完全隔离不进 baseline 收集。
- **(Medium) Token / env vars lifecycle 一致性**：§2 用 `read -rsp` 输入 JWT（无回显、不入 history）后 `export TOKEN`；同步 `export BASE_ID` 给后续 step。§4.5 / §6 metadata 收集都复用同一 shell session 的 `TOKEN` / `API_BASE` / `BASE_ID`。**§8 cleanup 才 unset**（不再在 §2 末尾 unset TOKEN，那会让 §4.5 rollback verify 拿不到 token）。
- **(Medium) §8 cleanup 去 fake DELETE endpoint**：原 `curl DELETE "$API_BASE/api/multitable/<unknown-endpoint>"` 与同文 §2 "no DELETE /bases endpoint exists" 矛盾；移除该命令，replace with 3 个合规处置路径（UI 删 / 保留复用（推荐）/ DBA SQL 程序）— 不再 paste 看似可运行的 unknown 删除指令。

### v1 (2026-05-24) — Initial operator runbook

- 11 sections + anti-checklist + 排查速查
- 6 步主流程（user 提议）：preconditions / pre-create base / verify Yjs / 1k smoke / 12 baseline / artifact 收集
- Review-and-lock PR scope 明确：只锁 thresholds + verdict，不顺手做任何优化
- 与 design + impl verification MD + memory 锁定决策完全对齐
