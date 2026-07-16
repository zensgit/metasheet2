"""PLM-COLLAB Discussion read-auth line — sub-slice 6 (capstone dual-service E2E).

Mint helper: emit REAL Ed25519 embed tokens via the PRODUCTION `mint_embed_token` service — the
exact signing path the provider's own end-to-end test uses (`_mint_real_embed_token` in
`test_discussion_router.py`). The provider independently verifies the Ed25519 signature at the read
exchange, so a token minted here is as real as one minted through the HTTP endpoint.

WHY the service and not the `POST /api/v1/bom/multitable/{part_id}/embed-token` HTTP endpoint:
the HTTP mint binds `tenant_id`/`part_id` to the AUTHENTICATED request context
(`resolve_license_scope()` -> the caller's tenant; the part must exist and be entitled), so it
CANNOT mint the adversarial tokens this E2E requires — a cross-TENANT token (tenant != the served
tenant) or a token bound to an arbitrary part. It also needs a full login + entitlement +
permission bootstrap. The signing key here is the SAME one the temp provider verifies with, so the
mint hop stays real; only the issuance vehicle differs. Stated plainly in the E2E reality table.

Reads a JSON array of specs from stdin:
  [{ "name": str, "user_id": int, "tenant_id": str, "org_id": str|null, "part_id": str }, ...]
and writes `{ name: token }` JSON to stdout. Signing material comes from the SAME env the provider
uses (YUANTUS_EMBED_TOKEN_SIGNING_KEY / _KEY_ID / _AUDIENCE / _TTL_SECONDS) plus EMBED_ORIGIN.
"""
from __future__ import annotations

import json
import os
import sys


def main() -> int:
    signing_key = os.environ.get("YUANTUS_EMBED_TOKEN_SIGNING_KEY")
    key_id = os.environ.get("YUANTUS_EMBED_TOKEN_KEY_ID", "embed-1")
    audience = os.environ.get("YUANTUS_EMBED_TOKEN_AUDIENCE", "metasheet2.embed")
    ttl_seconds = int(os.environ.get("YUANTUS_EMBED_TOKEN_TTL_SECONDS", "600"))
    origin = os.environ.get("EMBED_ORIGIN", "https://plm.example.com")
    if not signing_key:
        print("mint_embed_token: YUANTUS_EMBED_TOKEN_SIGNING_KEY must be set", file=sys.stderr)
        return 2

    from yuantus.meta_engine.services.bom_multitable_embed_token_service import mint_embed_token

    specs = json.load(sys.stdin)
    out = {}
    for spec in specs:
        minted = mint_embed_token(
            user_id=spec["user_id"],
            tenant_id=spec["tenant_id"],
            org_id=spec.get("org_id"),
            part_id=spec["part_id"],
            origin=origin,
            audience=audience,
            signing_key_b64=signing_key,
            key_id=key_id,
            ttl_seconds=ttl_seconds,
        )
        out[spec["name"]] = minted["token"]

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
