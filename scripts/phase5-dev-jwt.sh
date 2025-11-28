#!/bin/bash
# Generate a development JWT token for local RBAC-protected endpoint testing.
# Uses JWT_SECRET (default dev-secret to match jwt-middleware.ts default). Payload kept minimal.
set -euo pipefail
SECRET=${JWT_SECRET:-dev-secret}
SUB=${1:-phase5-user}
EXP_MINUTES=${EXP_MINUTES:-60}
HEADER='{"alg":"HS256","typ":"JWT"}'
NOW=$(date +%s)
EXP=$((NOW + EXP_MINUTES*60))
PAYLOAD=$(cat <<EOF
{
  "sub": "$SUB",
  "name": "Phase5 User",
  "iat": $NOW,
  "exp": $EXP,
  "roles": ["admin"],
  "permissions": ["write","read","reload","snapshot"]
}
EOF
)

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
HEADER_B64=$(printf '%s' "$HEADER" | base64url)
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | base64url)
SIGN_INPUT="$HEADER_B64.$PAYLOAD_B64"
SIGNATURE=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64url)
TOKEN="$SIGN_INPUT.$SIGNATURE"
echo "$TOKEN"
