"""Exercise Meta personal change-read transport against an isolated Native source process.

Needs the Native pytest/SQLAlchemy environment and Meta Node/tsx dependencies.
All credentials and three authority DBs are synthetic; provider responses are real.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

import pytest
import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revoke-only", action="store_true", help="Only the changed self-revoke/received-error path")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(args.native_root.resolve() / "src"))
    from yuantus.api.tests import test_plm_bom_change_read_grants as api
    from yuantus.meta_engine.tests.plm_change_fixture import change_fixture
    from yuantus.security.auth.plm_approval_grant_models import PlmApprovalGrant
    args.output.parent.mkdir(parents=True, exist_ok=True)
    owned = Path(tempfile.mkdtemp(prefix="plm-personal-change-read-", dir="/tmp"))
    marker = "owned-three-authority-change-read\n"
    (owned / ".owner").write_text(marker)
    patch = pytest.MonkeyPatch()
    generator = world = client = server = thread = sock = None
    previous = None
    proof = {"source_process_only": True, "phases": []}
    try:
        generator = change_fixture.__wrapped__(owned, patch)
        world = next(generator)
        client, previous = api._finish(world, patch, a1=False)
        row = client.post(api.ENDPOINT, headers=world.headers, json=api._body())
        assert row.status_code == 201
        issued = row.json()
        event_id = None
        if not args.revoke_only:
            world.write("meta-personal-read-native-1", {"quantity": 2})
            event_id = api._event_id(world)
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(128)
        origin = "http://127.0.0.1:" + str(sock.getsockname()[1])
        server = uvicorn.Server(uvicorn.Config(world.app, log_level="error", lifespan="off"))
        thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            if time.monotonic() > deadline: raise RuntimeError("Owned Native server did not start")
            time.sleep(.02)
        authority = {"origin": origin, "connectionId": api.CONN, "tenantId": "default", "orgId": "fixture-org",
            "authUserId": "42", "rootPartId": api.SCOPE["root_part_id"], "target": api.TARGET,
            "reviewBindingId": api.BINDING, "reviewBindingVersion": 1}
        for revoke in ((True,) if args.revoke_only else (False, True)):
            result = subprocess.run([os.environ.get("PLM_TEST_NODE_BINARY", "node"),
                str(root / "node_modules/tsx/dist/cli.mjs"),
                str(root / "packages/core-backend/tests/helpers/personal-change-read-native.ts")],
                cwd=root / "packages/core-backend", env={**os.environ, "NODE_ENV": "test"},
                input=json.dumps({"authority": authority, "grant": issued["token"], "eventId": event_id, "revoke": revoke}),
                capture_output=True, text=True, timeout=45)
            if result.returncode:
                (owned / ("revoke.stderr" if revoke else "read.stderr")).write_text(result.stderr)
                raise RuntimeError("Meta/Native personal read failed; private fixture retained")
            (owned / ("revoke.stdout" if revoke else "read.stdout")).write_text(result.stdout)
            lines = [line.removeprefix("PLM_PERSONAL_CHANGE_READ_PROOF=") for line in result.stdout.splitlines()
                     if line.startswith("PLM_PERSONAL_CHANGE_READ_PROOF=")]
            assert len(lines) == 1, "Missing or duplicate owned helper receipt"
            phase = json.loads(lines[0]); assert phase["passed"] and phase["personalOnly"]
            proof["phases"].append(phase)
        with world.identity() as db:
            grant = db.get(PlmApprovalGrant, issued["id"])
            assert grant.user_id == 42 and grant.purpose == "bom_change_read" and grant.target == api.TARGET
            assert grant.revoked_at is not None
        proof["database_verified"] = proof["passed"] = True
    finally:
        if server is not None: server.should_exit = True
        if thread is not None: thread.join(10)
        proof["owned_server_stopped"] = thread is None or not thread.is_alive()
        if client is not None: api._teardown(world, client, previous)
        if generator is not None:
            try: next(generator)
            except StopIteration: pass
        patch.undo()
        if sock is not None: sock.close()
        if proof.get("passed") and proof["owned_server_stopped"] and (owned / ".owner").read_text() == marker:
            shutil.rmtree(owned)
        proof["owned_runtime_removed"] = not owned.exists()
        if owned.exists(): proof["private_failure_directory"] = str(owned)
        args.output.write_text(json.dumps(proof, indent=2) + "\n")
        print(json.dumps({key: proof.get(key, False) for key in ("passed", "database_verified", "owned_server_stopped", "owned_runtime_removed")}))
    if not proof["owned_runtime_removed"]: raise RuntimeError("Owned Native runtime retained")


if __name__ == "__main__":
    main()
