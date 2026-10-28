#!/usr/bin/env bash
# Discussion 试点 smoke — 读通道 正/负 用例 (口令③ 阶段2 用) · rev2 (owner NO-GO 修订版)
#
# 传输安全 (P1): 本脚本传输用户名/密码/Bearer/embed token。
#   仅允许: https:// 目标,或 SSH 隧道后的 http://127.0.0.1|localhost。
#   公网 http:// 一律硬拒 —— 不提供任何绕过开关。
#
# 用法 (HTTPS):
#   YUANTUS_BASE=https://plm.example.com MS2_BASE=https://ms.example.com \
#   USERNAME=admin PASSWORD=*** TENANT_ID=pilot-tenant ORG_ID=org-1 PART_ID=<part> \
#   MODE=lit bash discussion_pilot_smoke.sh
# 用法 (SSH 隧道私有验收):
#   ssh -N -L 17910:127.0.0.1:7910 -L 18900:127.0.0.1:8900 <deploy-host> &
#   YUANTUS_BASE=http://127.0.0.1:17910 MS2_BASE=http://127.0.0.1:18900 ... MODE=dark bash discussion_pilot_smoke.sh
#
# MODE=dark : 点灯前 — 严格断言暗态: 交换 401;relay 401 且 code=EMBED_SESSION_EXCHANGE_FAILED
#             (404/503 等 ≠ 暗态,是环境错误,判 FAIL)
# MODE=lit  : 点灯后 — 正向 + 负向 (重放/写路由/兄弟路由,均严格断言 401 与稳定错误码) + 限流头
#
# 端点/字段/错误码取自 ms2 与 Yuantus origin/main 原文 (harness.ts, plm-discussion-read-e2e.test.ts,
# plm-embed-discussion-read.ts) — 非猜测。
set -uo pipefail

: "${YUANTUS_BASE:?set YUANTUS_BASE}"; : "${MS2_BASE:?set MS2_BASE}"
: "${USERNAME:?set USERNAME}"; : "${PASSWORD:?set PASSWORD}"
: "${TENANT_ID:?set TENANT_ID}"; : "${ORG_ID:?set ORG_ID}"; : "${PART_ID:?set PART_ID}"
MODE="${MODE:-lit}"

# --- P1 传输安全守卫: 公网 HTTP 硬拒 ------------------------------------------
check_scheme() { # $1=name $2=url
  case "$2" in
    https://*) return 0 ;;
    http://127.0.0.1*|http://localhost*|http://\[::1\]*) return 0 ;;  # SSH 隧道
    http://*) echo "FATAL: $1=$2 是公网 HTTP — 凭证会明文暴露。改用 HTTPS 或 SSH 隧道(127.0.0.1)。"; exit 3 ;;
    *) echo "FATAL: $1=$2 不是 http(s) URL"; exit 3 ;;
  esac
}
check_scheme YUANTUS_BASE "$YUANTUS_BASE"; check_scheme MS2_BASE "$MS2_BASE"

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
need() { command -v "$1" >/dev/null || { echo "missing dependency: $1"; exit 2; }; }
need curl; need jq

BODY=/tmp/smoke_body.$$
body_code() { jq -r '.error.code // .detail // empty' "$BODY" 2>/dev/null; }

# --- login (1次) -------------------------------------------------------------
login_res=$(curl -sS -m 20 -w '\n%{http_code}' -X POST "$YUANTUS_BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"tenant_id\":\"$TENANT_ID\",\"org_id\":\"$ORG_ID\"}")
login_code=${login_res##*$'\n'}; login_body=${login_res%$'\n'*}
BEARER=$(jq -r '.access_token // empty' <<<"$login_body")
[ "$login_code" = "200" ] && [ -n "$BEARER" ] && ok "login 200 + access_token" || { bad "login ($login_code)"; echo "$login_body" | head -c 300; echo; exit 1; }

mint() { # -> embed_token 到 stdout;失败输出空
  curl -sS -m 20 -X POST "$YUANTUS_BASE/api/v1/bom/multitable/$PART_ID/embed-token" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $BEARER" \
    -H "x-tenant-id: $TENANT_ID" -H "x-org-id: $ORG_ID" -d '{}' | jq -r '.embed_token // empty'
}

code_of() { # method url [json_body] x [extra_header...]
  local method=$1 url=$2 body=${3:-}; shift; shift; [ $# -gt 0 ] && shift
  local args=(-sS -m 20 -o "$BODY" -w '%{http_code}' -X "$method" "$url" -H 'Content-Type: application/json')
  for h in "$@"; do args+=(-H "$h"); done
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

exchange_code() { # embed_token -> http code (body 存 $BODY)
  code_of POST "$YUANTUS_BASE/api/v1/auth/embed/discussion-read-session" "{\"embed_token\":\"$1\"}"
}

if [ "$MODE" = "dark" ]; then
  echo "== MODE=dark:点灯前暗态验证 (严格断言,404/503 = 环境错误 = FAIL) =="
  t=$(mint)
  if [ -z "$t" ]; then bad "mint (dark 模式也应可铸 embed token — 检查 bom_multitable 授权 / 数据源租户)"; else
    ok "mint embed token"
    c=$(exchange_code "$t"); [ "$c" = "401" ] && ok "read exchange 暗态 401" || bad "read exchange 期望 401 实得 $c ($(body_code))"
    c=$(code_of GET "$MS2_BASE/api/plm-embed/discussion/threads" "" x "X-PLM-Embed-Token: $t")
    ec=$(body_code)
    if [ "$c" = "401" ] && [ "$ec" = "EMBED_SESSION_EXCHANGE_FAILED" ]; then
      ok "relay 暗态 401 + EMBED_SESSION_EXCHANGE_FAILED"
    else
      bad "relay 暗态期望 401+EMBED_SESSION_EXCHANGE_FAILED,实得 $c+${ec:-<no code>} (404=路由未挂载? 503=数据源/Redis 未配? 403 EMBED_TENANT_MISMATCH=数据源租户不符?)"
    fi
  fi
else
  echo "== MODE=lit:点灯后正负用例 (负向严格断言 401 与错误码) =="
  # P1 relay list (真实浏览器路径同款: 仅 X-PLM-Embed-Token)
  t1=$(mint); [ -n "$t1" ] || { bad "mint#1"; exit 1; }
  c=$(code_of GET "$MS2_BASE/api/plm-embed/discussion/threads" "" x "X-PLM-Embed-Token: $t1")
  if [ "$c" = "200" ] && jq -e '.ok == true or (.threads|type=="array") or (.data|type=="array")' "$BODY" >/dev/null 2>&1; then
    ok "relay list 200 + JSON"; else bad "relay list ($c $(body_code)): $(head -c 200 "$BODY")"; fi
  # P2 同 token 重放 relay → 401 + EMBED_TOKEN_REPLAYED (relay Redis jti)
  c=$(code_of GET "$MS2_BASE/api/plm-embed/discussion/threads" "" x "X-PLM-Embed-Token: $t1")
  ec=$(body_code)
  [ "$c" = "401" ] && [ "$ec" = "EMBED_TOKEN_REPLAYED" ] && ok "relay 重放 401 + EMBED_TOKEN_REPLAYED" \
    || bad "relay 重放期望 401+EMBED_TOKEN_REPLAYED 实得 $c+${ec:-<no code>}"
  # P3 provider 直连: exchange → 200 + aud=discussion; 限流头; 交换重放 → 401
  t2=$(mint); c=$(exchange_code "$t2")
  if [ "$c" = "200" ] && [ "$(jq -r '.aud // empty' "$BODY")" = "discussion" ]; then
    ok "read exchange 200 + aud=discussion"; READ_CRED=$(jq -r '.access_token' "$BODY")
  else bad "read exchange ($c $(body_code))"; READ_CRED=""; fi
  rl=$(curl -sSI -m 20 -X POST "$YUANTUS_BASE/api/v1/auth/embed/discussion-read-session" \
        -H 'Content-Type: application/json' -d '{"embed_token":"x"}' | grep -i 'x-ratelimit-limit' || true)
  [ -n "$rl" ] && ok "PREAUTH 限流头存在 ($(echo "$rl"|tr -d '\r'))" || bad "缺 X-RateLimit-Limit — 限流未开?"
  c=$(exchange_code "$t2"); [ "$c" = "401" ] && ok "provider 交换重放 401 (AuthEmbedExchangeJti)" || bad "交换重放期望 401 实得 $c"
  if [ -n "$READ_CRED" ]; then
    # P4 读凭证 → provider list
    c=$(code_of GET "$YUANTUS_BASE/api/v1/discussions?target_type=item&target_id=$PART_ID&include_resolved=true" "" x \
        "Authorization: Bearer $READ_CRED")
    [ "$c" = "200" ] && ok "provider list (读凭证) 200" || bad "provider list ($c $(body_code))"
    # N1 读凭证发写 → 401 (middleware 只放行 2 个读 (method,path) 对)
    c=$(code_of POST "$YUANTUS_BASE/api/v1/discussions" "{\"target_type\":\"item\",\"target_id\":\"$PART_ID\",\"body\":\"smoke\"}" x \
        "Authorization: Bearer $READ_CRED")
    [ "$c" = "401" ] && ok "读凭证写路由 401" || bad "读凭证写路由期望 401 实得 $c ($(body_code))"
    # N2 读凭证访问兄弟路由 /my → 401
    c=$(code_of GET "$YUANTUS_BASE/api/v1/discussions/my" "" x "Authorization: Bearer $READ_CRED")
    [ "$c" = "401" ] && ok "读凭证 /my 401" || bad "读凭证 /my 期望 401 实得 $c ($(body_code))"
    # N3 读凭证当普通登录用 → 401
    c=$(code_of GET "$YUANTUS_BASE/api/v1/search/" "" x "Authorization: Bearer $READ_CRED")
    [ "$c" = "401" ] && ok "读凭证通用路由 401" || bad "读凭证通用路由期望 401 实得 $c ($(body_code))"
  fi
fi

rm -f "$BODY" 2>/dev/null
echo; echo "== 结果: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
