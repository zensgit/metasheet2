#!/usr/bin/env bash
set -euo pipefail

RATE=80
CONCURRENCY=20
DURATION_SECONDS=7500 # ~2h5m 给观察收尾缓冲
INTERVAL_SECONDS=600
MAX_SAMPLES=12       # 12*600 = 7200s (~2h)
BASE_URL="http://localhost:8900"
JWT=""
COUNT_CACHE_MISS_AS_FALLBACK=false

usage() {
  cat <<EOF
Phase 5 Production Baseline Runner (orchestrator)
Usage: $0 [--base-url URL] [--rate N] [--concurrency N] [--duration-seconds N] [--jwt TOKEN] [--interval-seconds N] [--samples N]
Environment vars respected:
  METRICS_URL (Prometheus scrape endpoint) REQUIRED for real production
  COUNT_CACHE_MISS_AS_FALLBACK (default: $COUNT_CACHE_MISS_AS_FALLBACK)
Creates two background processes:
  1) Load generator (phase5-load.sh)
  2) Observation collector (phase5-observe.sh)
Artifacts:
  results/phase5-prod-<timestamp>/ (metrics.csv, raw-metrics.txt, metadata.json)
PID files:
  phase5-load.pid, phase5-observe.pid
Progress check:
  tail -n +1 results/phase5-prod-*/metrics.csv | head
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2;;
    --rate) RATE="$2"; shift 2;;
    --concurrency) CONCURRENCY="$2"; shift 2;;
    --duration-seconds) DURATION_SECONDS="$2"; shift 2;;
    --jwt) JWT="$2"; shift 2;;
    --interval-seconds) INTERVAL_SECONDS="$2"; shift 2;;
    --samples) MAX_SAMPLES="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 1;;
  esac
done

METRICS_URL="${METRICS_URL:-}" # must be set for production
if [[ -z "$METRICS_URL" ]]; then
  echo "[WARN] METRICS_URL 未设置, 使用本地默认 http://localhost:8900/metrics/prom (非生产基线)。"
  METRICS_URL="http://localhost:8900/metrics/prom"
fi

if [[ -n "${ENABLE_PHASE5_INTERNAL:-}" || -n "${ENABLE_FALLBACK_TEST:-}" ]]; then
  echo "[WARN] 检测到内部/测试特性标志 (ENABLE_PHASE5_INTERNAL 或 ENABLE_FALLBACK_TEST)。建议取消以保证基线纯净。"
fi

START_TS=$(date '+%Y%m%d-%H%M%S')
OUT_DIR="results/phase5-prod-$START_TS"
mkdir -p "$OUT_DIR"
echo "{\n  \"start_timestamp\": \"$START_TS\",\n  \"base_url\": \"$BASE_URL\",\n  \"metrics_url\": \"$METRICS_URL\",\n  \"rate\": $RATE,\n  \"concurrency\": $CONCURRENCY,\n  \"duration_seconds\": $DURATION_SECONDS,\n  \"interval_seconds\": $INTERVAL_SECONDS,\n  \"samples\": $MAX_SAMPLES,\n  \"jwt_provided\": $( [[ -n "$JWT" ]] && echo true || echo false ),\n  \"cache_miss_counted\": $( [[ "$COUNT_CACHE_MISS_AS_FALLBACK" == "true" ]] && echo true || echo false )\n}" > "$OUT_DIR/metadata.json"

echo "[INFO] Phase 5 Production Baseline 启动 ..."
echo "[INFO] 输出目录: $OUT_DIR"
echo "[INFO] 负载: rate=$RATE concurrency=$CONCURRENCY duration=$DURATION_SECONDS"
echo "[INFO] 观察: interval=$INTERVAL_SECONDS samples=$MAX_SAMPLES (~$((INTERVAL_SECONDS*MAX_SAMPLES/3600))h)"
echo "[INFO] METRICS_URL=$METRICS_URL"
echo "[INFO] COUNT_CACHE_MISS_AS_FALLBACK=$COUNT_CACHE_MISS_AS_FALLBACK"

LOAD_CMD=(./scripts/phase5-load.sh --rate "$RATE" --concurrency "$CONCURRENCY" --duration-seconds "$DURATION_SECONDS" --base-url "$BASE_URL")
if [[ -n "$JWT" ]]; then
  LOAD_CMD+=(--jwt "$JWT")
fi

"${LOAD_CMD[@]}" >"$OUT_DIR/load.log" 2>&1 & echo $! > phase5-load.pid
echo "[INFO] Load PID $(cat phase5-load.pid)"

NON_INTERACTIVE=1 COUNT_CACHE_MISS_AS_FALLBACK="$COUNT_CACHE_MISS_AS_FALLBACK" METRICS_URL="$METRICS_URL" INTERVAL_SECONDS="$INTERVAL_SECONDS" MAX_SAMPLES="$MAX_SAMPLES" OUT_DIR="$OUT_DIR" \
  ./scripts/phase5-observe.sh >"$OUT_DIR/observe.log" 2>&1 & echo $! > phase5-observe.pid
echo "[INFO] Observe PID $(cat phase5-observe.pid)"

echo "[INFO] 已后台启动。查看进度示例:"
echo "       tail -n +1 $OUT_DIR/metrics.csv"
echo "       tail -f $OUT_DIR/observe.log | grep '📊'"
echo "       ps -fp $(cat phase5-load.pid) $(cat phase5-observe.pid)"
echo "[INFO] 完成后生成 production-report 可执行:"
echo "       ./scripts/phase5-fill-production-report.sh $OUT_DIR/metrics.csv > $OUT_DIR/production-report.md"
echo "       ./scripts/phase5-append-production.sh $OUT_DIR/production-report.md"
echo "[INFO] 归档: ARCHIVE_READONLY=true ./scripts/phase5-archive.sh $OUT_DIR"

exit 0
