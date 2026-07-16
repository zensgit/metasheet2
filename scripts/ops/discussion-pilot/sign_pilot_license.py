#!/usr/bin/env python3
"""PILOT ONLY — sign a multi-SKU offline PLM license for the Discussion 点灯试点. rev2.

Derived from the repo's scripts/dev/sign_dogfood_license.py (same canonical signing
scheme via yuantus.meta_engine.app_framework.license_verification.canonical_payload_bytes),
parameterized over feature keys:

  bom_multitable            -> plm.bom_multitable            (embed-token mint gate)
  metasheet_review          -> plm.metasheet_review          (Discussion READ)
  metasheet_review_writeback-> plm.metasheet_review_writeback(Discussion WRITE)

rev2 changes (owner review):
  * --kid is REQUIRED (use a distinct kid per issuance batch, e.g. pilot-read-1 /
    pilot-write-1) — reusing one kid across freshly generated keys breaks audit/re-signing.
  * --priv-in <pem> loads a FIXED private key (pairs with --priv-out from a prior run),
    so later batches can share a kid legitimately.
  * pilot licenses EXPIRE by default: --expires-at defaults to now+30d (UTC).
    Pass --expires-at none explicitly for perpetual (not recommended for the pilot).
  * prints the EXACT AppLicense keys the import stores: a single-app license stores the
    base license_key verbatim; a multi-app license stores ONE ROW PER app_name keyed
    "<base>#<app_name>" (license_import_service.py) — revoke each of THOSE, not the base.

Run FROM THE YUANTUS REPO ROOT (a checkout at/after current origin/main):

  python ~/Downloads/sign_pilot_license.py --tenant-id pilot-tenant \
      --features bom_multitable,metasheet_review --kid pilot-read-1 \
      --priv-out pilot-read-1.pem --out pilot-license.json

Then:
  1. add the printed kid->pubkey JSON entry to the deployment's YUANTUS_LICENSE_PUBLIC_KEYS
  2. yuantus license import pilot-license.json --tenant-id pilot-tenant
  3. record the printed stored license keys for later revocation.

Never commit the license file or the private key.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Import the in-repo canonical scheme (run from the Yuantus repo root).
sys.path.insert(0, str(Path.cwd() / "src"))
try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from yuantus.meta_engine.app_framework.license_verification import (
        canonical_payload_bytes,
        verify_license,
    )
except ImportError as exc:  # pragma: no cover
    sys.exit(f"run from the Yuantus repo root with its venv active (import failed: {exc})")

# Mirror entitlement_service.FEATURE_APP_NAMES for the three pilot SKUs.
FEATURE_APP_MAP = {
    "bom_multitable": "plm.bom_multitable",
    "metasheet_review": "plm.metasheet_review",
    "metasheet_review_writeback": "plm.metasheet_review_writeback",
}


def build_and_sign(priv: Ed25519PrivateKey, *, tenant_id: str, features: list[str],
                   subject: str, kid: str, plan_type: str, issued_at: str,
                   expires_at: str | None) -> dict:
    unknown = [f for f in features if f not in FEATURE_APP_MAP]
    if unknown:
        raise ValueError(f"unknown feature key(s) {unknown}; known: {sorted(FEATURE_APP_MAP)}")
    if not features:
        raise ValueError("at least one feature required")
    payload = {
        "tenant_id": tenant_id,
        "app_names": [FEATURE_APP_MAP[f] for f in features],
        "features": list(features),
        "plan_type": plan_type,
        "license_key": uuid.uuid4().hex,
        "subject": subject,
        "issued_at": issued_at,
        "expires_at": expires_at,  # pilot default: now+30d; None only via explicit --expires-at none
    }
    signature = base64.b64encode(priv.sign(canonical_payload_bytes(payload))).decode()
    return {"alg": "Ed25519", "kid": kid, "payload": payload, "signature": signature}


def stored_license_keys(payload: dict) -> list[str]:
    """The exact AppLicense.license_key values `yuantus license import` will store.

    Mirrors license_import_service.py: single app -> base key; multi-app -> one row per
    app_name keyed '<base>#<app_name>'. Revocation must target THESE keys.
    """
    base = payload["license_key"]
    apps = payload["app_names"]
    return [base] if len(apps) == 1 else [f"{base}#{app}" for app in apps]


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign a multi-SKU pilot license (Discussion 点灯). rev2")
    ap.add_argument("--tenant-id", required=True)
    ap.add_argument("--features", required=True,
                    help=f"CSV of feature keys, subset of {sorted(FEATURE_APP_MAP)}")
    ap.add_argument("--subject", default="Discussion Pilot")
    ap.add_argument("--kid", required=True,
                    help="REQUIRED. Distinct per issuance batch (e.g. pilot-read-1, pilot-write-1) "
                         "unless re-signing with --priv-in; must match the deployment's "
                         "YUANTUS_LICENSE_PUBLIC_KEYS entry")
    ap.add_argument("--plan-type", default="Pilot")
    ap.add_argument("--issued-at", default=None, help="ISO-8601; default: now (UTC)")
    ap.add_argument("--expires-at", default=None,
                    help="ISO-8601, or the literal 'none' for perpetual (NOT recommended for a "
                         "pilot). Default: now+30 days (UTC).")
    ap.add_argument("--out", default="pilot-license.json")
    key_group = ap.add_mutually_exclusive_group()
    key_group.add_argument("--priv-in", default=None,
                    help="PEM path of an EXISTING private key to sign with (keeps kid stable "
                         "across batches)")
    ap.add_argument("--priv-out", default=None,
                    help="write the private key (PEM) here for later --priv-in re-signing. "
                         "Keep in custody; never commit.")
    args = ap.parse_args()

    features = [f.strip() for f in args.features.split(",") if f.strip()]

    if args.priv_in:
        priv = serialization.load_pem_private_key(Path(args.priv_in).read_bytes(), password=None)
        if not isinstance(priv, Ed25519PrivateKey):
            sys.exit(f"--priv-in {args.priv_in} is not an Ed25519 private key")
    else:
        priv = Ed25519PrivateKey.generate()

    pub_b64 = base64.b64encode(priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    issued_at = args.issued_at or now.isoformat()
    if args.expires_at is None:
        expires_at: str | None = (now + timedelta(days=30)).isoformat()
    elif args.expires_at.strip().lower() == "none":
        expires_at = None
        print("WARNING: perpetual license requested — not recommended for a pilot", file=sys.stderr)
    else:
        expires_at = args.expires_at

    lic = build_and_sign(priv, tenant_id=args.tenant_id, features=features,
                         subject=args.subject, kid=args.kid,
                         plan_type=args.plan_type, issued_at=issued_at,
                         expires_at=expires_at)

    # Self-verify with the repo's own verifier before writing (fail here, not at import time).
    verify_license(lic, {args.kid: pub_b64})

    Path(args.out).write_text(json.dumps(lic, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if args.priv_out:
        Path(args.priv_out).write_bytes(priv.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))

    print(f"license written: {args.out}")
    print(f"features: {features} -> app_names: {[FEATURE_APP_MAP[f] for f in features]}")
    print(f"issued_at: {issued_at}   expires_at: {expires_at or 'PERPETUAL'}")
    print("add to YUANTUS_LICENSE_PUBLIC_KEYS:")
    print(json.dumps({args.kid: pub_b64}))
    print(f"then: yuantus license import {args.out} --tenant-id {args.tenant_id}")
    print("stored AppLicense keys (REVOKE TARGETS — record these):")
    for key in stored_license_keys(lic["payload"]):
        print(f"  {key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
