#!/usr/bin/env bash
# READ-ONLY feasibility probe for the Discussion pilot. Piped to the deploy host over SSH
# via `bash -s` by .github/workflows/discussion-pilot-status.yml — so NOTHING is written to
# the host filesystem for the script itself, and NO user input reaches the command line.
# Any scratch it needs lives in a private, unique `mktemp -d` cleaned by a trap. It mutates
# no host state.
#
# STRICT OUTCOME: it exits NON-ZERO whenever it cannot positively verify a dimension
# (docker permission, backend PRODUCT_MODE / route mount, or nginx visibility). It only
# exits 0 when every dimension was actually determined — a determined "attendance / not
# feasible" is a valid 0; an "inconclusive / no permission" is never dressed up as success.
set -uo pipefail

# Private, unique scratch dir (no predictable /tmp path; nothing executed from a fixed file).
umask 077
workdir="$(mktemp -d "${TMPDIR:-$HOME}/.discussion-pilot-status.XXXXXX")" || {
  printf '%s\n' "FATAL: mktemp -d failed; cannot run probe safely"; exit 2; }
trap 'rm -rf "$workdir"' EXIT

say() { printf '%s\n' "$*"; }
fail=0
flag() { fail=1; }   # mark the run unverified

say "== discussion-pilot status probe (read-only) =="
say "host: $(hostname 2>/dev/null || echo '?')   utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '?')"
say ""

# --- docker permission (hard requirement) ------------------------------------
if ! docker ps >/dev/null 2>&1; then
  say "docker: UNAVAILABLE — no permission or daemon down; mode cannot be determined"
  say ""
  say "RESULT: UNVERIFIED (docker) — exit 3"
  exit 3
fi

say "== containers (metasheet/yuantus) =="
containers="$(docker ps --format '{{.Names}}	{{.Status}}' 2>/dev/null | grep -Ei 'metasheet|yuantus' || true)"
if [ -n "$containers" ]; then printf '%s\n' "$containers" | sed 's/^/  /'; else say "  none matching metasheet|yuantus"; fi
say ""

# --- metasheet-backend PRODUCT_MODE + PLM route mount (the decision) ----------
say "== metasheet-backend PRODUCT_MODE / PLM route (DECIDES feasibility) =="
CID="$(docker ps -qf name=metasheet-backend 2>/dev/null || true)"
if [ -z "$CID" ]; then
  say "  metasheet-backend: NOT FOUND — mode INCONCLUSIVE"
  flag
else
  env_dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CID" 2>/dev/null || true)"
  if [ -z "$env_dump" ]; then
    say "  docker inspect: FAILED (no permission?) — env INCONCLUSIVE"
    flag
  else
    pm="$(printf '%s\n' "$env_dump" | grep -E '^PRODUCT_MODE=' | head -1 || echo 'PRODUCT_MODE=<unset>')"
    ep="$(printf '%s\n' "$env_dump" | grep -E '^ENABLE_PLM=' | head -1 || echo 'ENABLE_PLM=<unset>')"
    say "  ${pm}   ${ep}"
  fi
  if ! command -v curl >/dev/null 2>&1; then
    say "  curl: MISSING on host — route mount INCONCLUSIVE"
    flag
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
        http://127.0.0.1:8900/api/plm-embed/discussion/threads -H 'X-PLM-Embed-Token: probe' 2>/dev/null || echo 000)"
    say "  plm-embed route (127.0.0.1:8900) -> HTTP ${code}"
    case "$code" in
      401|403) say "  => PLM routes MOUNTED (platform) — pilot feasible on this backend (determined)" ;;
      404)     say "  => PLM routes NOT mounted (attendance) — pilot NOT feasible here (determined)" ;;
      000)     say "  => backend UNREACHABLE on loopback — route mount INCONCLUSIVE"; flag ;;
      *)       say "  => unexpected HTTP ${code} — route mount INCONCLUSIVE"; flag ;;
    esac
  fi
fi
say ""

# --- disk (host /) -----------------------------------------------------------
say "== host disk (/) =="
if avail="$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')" && [ -n "$avail" ]; then
  say "  avail_kb=${avail}"
else
  say "  df: FAILED — disk UNVERIFIED"; flag
fi
say ""

# --- nginx public-exposure of a PLM/Yuantus upstream (hard requirement) -------
say "== nginx public exposure of a PLM/Yuantus upstream =="
if ls /etc/nginx >/dev/null 2>&1; then
  hits="$(grep -rlE 'plm\..*sslip\.io|proxy_pass[^;]*:7910' /etc/nginx 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    say "  EXPOSURE RISK — nginx references a PLM upstream (would publish a pilot over public HTTP):"
    printf '%s\n' "$hits" | sed 's/^/    /'
    flag
  else
    say "  none found (/etc/nginx readable)"
  fi
else
  say "  /etc/nginx NOT readable by this user — exposure UNVERIFIED"
  flag
fi
say ""

if [ "$fail" -ne 0 ]; then
  say "RESULT: UNVERIFIED — one or more dimensions could not be positively determined (exit 1)."
  say "        Do NOT conclude the pilot is safe/feasible from this run."
  exit 1
fi
say "RESULT: verified — every dimension determined (exit 0). Read the PLM-route line for feasibility."
exit 0
