#!/usr/bin/env python3
"""Thin coordinator for a future W23 paired full-index HTTP profile.

preflight and an unadmitted run do not start PostgreSQL, Redis, Native, Meta,
browsers, or TLS listeners. There is no e3 or canonical-tree fallback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import native_fixture

E3_PLANNING_COMMIT = native_fixture.E3_PLANNING_COMMIT
MAIN_ANCESTOR = native_fixture.MAIN_ANCESTOR
PLANNING_META_COMMIT = "37516a0b3cd002c3d416e8f29f4415c2d2b539fc"
META_TREE = "/Users/chouhua/.codex/worktrees/plm-w23-meta-readonly-20261023/metasheet2"
OWNED_SOCKET = "scripts/verification/plm-managed-companion-pg/owned-socket.mjs"
SHA40 = __import__("re").compile(r"^[0-9a-f]{40}$")
SHA64 = __import__("re").compile(r"^[0-9a-f]{64}$")

META_CONFIRM = (
    "zzzz20261024010000_create_plm_collaboration_snapshots",
    "zzzz20261024020000_admit_plm_readiness_snapshots",
)
EXECUTABLE_FILES = ("redis_server", "node", "tsx", "python", "openssl")

MISSING_PREREQS = [
    "Root-reviewed Native pin: full commit, not e3f44e5a8816b52f0e30be553c98fff7b344ab25, reviewed true. The Main ancestor is the constant 3fd21e31cca358f1b1a80dd6365ec060cc23bc5e. A pin field named main_ancestor or rebased_base is refused.",
    "Explicit native tree whose HEAD equals that commit and whose status is clean. No e3 commit and no canonical path is substituted.",
    "Explicit --meta-tree equal to this worktree and --meta-ref equal to that checkout HEAD. Planning meta 37516a0b3cd002c3d416e8f29f4415c2d2b539fc and published tip fa8eeee6429be86ff0344fa4e9f0596d9427424c are not defaults.",
    "Pin executables are absolute existing paths: redis_server plus redis_server_sha256, pg_bin containing pg_ctl, initdb, createdb, and psql, node, tsx, python, openssl. owned-socket discoverBin fallback is not used.",
    "Native schema mode is alembic-upgrade-head through alembic.ini, alembic.identity.ini, and alembic_tenant.ini. metadata.create_all is not acceptance. native_fixture.py calls AuthService, the RBAC link, and the diagnostic services. It does not take a seed argv.",
    "Admitted seed signs one finite fixture license in memory with an ephemeral Ed25519 key and calls LicenseImportService.import_license with only that public map. It commits, then calls is_entitled on a new session. license_signature_verified is true only when that engine writes the verification metadata and the entitlement read succeeds. Uvicorn starts only when signed_import_refusal returns None. A bare true signature flag is refused. Production issuance and install acceptance stay NOT_RUN. Missing diagnostic families stay in the receipt and make the HTTP profile RED.",
    "Meta migrations run only after admission and only when signed_import_refusal returns None: tsx src/db/migrate.ts --latest, then separate --confirm for the two collaboration migrations. seed-meta then reads the owned-socket marker and proves current_database is the owned w23meta nonce and that users and user_orgs are empty, then AuthService.register plus fixture user_orgs, admin role, and permission rows. Password login later must return a server sid. No JWT is minted here.",
    "Source-only commands do not start owned PG, Redis, Meta, or Native. Docker, image/install, browser, and the W10 >=3600 hour profile stay separate.",
]


class Stop(Exception):
    def __init__(self, reason: str, **extra: object) -> None:
        super().__init__(reason)
        self.reason = reason
        self.extra = extra


def parent_env_flags() -> dict[str, str]:
    node_env = os.environ.get("NODE_ENV")
    return {
        "NODE_TLS_REJECT_UNAUTHORIZED": "set" if "NODE_TLS_REJECT_UNAUTHORIZED" in os.environ else "unset",
        "NODE_ENV_test": "true" if node_env == "test" else "false",
        "VITEST": "set" if "VITEST" in os.environ else "unset",
        "REDIS_URL": "set" if os.environ.get("REDIS_URL") else "unset",
        "REDIS_HOST": "set" if os.environ.get("REDIS_HOST") else "unset",
        "REDIS_PORT": "set" if os.environ.get("REDIS_PORT") else "unset",
        "PRODUCT_MODE_attendance": "true" if os.environ.get("PRODUCT_MODE") == "attendance" else "false",
    }


def emit(payload: dict, code: int) -> None:
    payload.setdefault("status", "NOT_RUN")
    payload.setdefault("runtime", "NOT_RUN")
    payload.setdefault("services_started", False)
    payload.setdefault("http_executed", False)
    payload.setdefault("fallback_commit", None)
    payload.setdefault("profile_result", payload["status"])
    payload.setdefault("missing_prereqs", MISSING_PREREQS)
    payload.setdefault("parent_env", parent_env_flags())
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    raise SystemExit(code)


def fail_closed_environment() -> None:
    flags = parent_env_flags()
    if flags["NODE_TLS_REJECT_UNAUTHORIZED"] == "set":
        raise Stop("inherited_tls_bypass_refused")
    if flags["NODE_ENV_test"] == "true":
        raise Stop("inherited_node_env_test_refused")
    if flags["VITEST"] == "set":
        raise Stop("inherited_vitest_refused")
    if flags["REDIS_URL"] == "set" or flags["REDIS_HOST"] == "set" or flags["REDIS_PORT"] == "set":
        raise Stop("inherited_redis_refused")
    if flags["PRODUCT_MODE_attendance"] == "true":
        raise Stop("inherited_attendance_mode_refused")


def read_pin(path: str) -> dict:
    if os.path.islink(path) or not os.path.isfile(path):
        raise Stop("native_pin_unreadable")
    try:
        pin = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise Stop("native_pin_invalid", error=type(exc).__name__) from exc
    if not isinstance(pin, dict):
        raise Stop("native_pin_invalid")
    return pin


def require_commit(pin: dict) -> str:
    commit = pin.get("commit")
    # Refuse the planning commit before any tree, status, or ancestry call.
    if isinstance(commit, str) and commit.lower() == E3_PLANNING_COMMIT:
        raise Stop("e3_planning_ref_refused")
    if not isinstance(commit, str) or SHA40.fullmatch(commit) is None:
        raise Stop("native_commit_invalid")
    if pin.get("reviewed") is not True:
        raise Stop("native_pin_not_reviewed")
    return commit


def require_tree_shape(pin: dict) -> str:
    tree = pin.get("tree")
    if not isinstance(tree, str) or not tree.startswith("/") or tree == META_TREE:
        raise Stop("native_tree_invalid")
    if os.path.islink(tree):
        raise Stop("native_tree_symlink_refused")
    return tree


def refuse_ancestor_override(pin: dict) -> None:
    if native_fixture.ancestor_override(pin):
        raise Stop("ancestor_override_refused")


def require_executables(pin: dict) -> dict:
    raw = pin.get("executables")
    if not isinstance(raw, dict):
        raise Stop("executables_missing")
    out: dict[str, str] = {}
    for name in EXECUTABLE_FILES:
        admitted = native_fixture.pinned_executable(raw.get(name))
        if admitted is None:
            raise Stop("executable_path_invalid", executable=name)
        out[name] = admitted
    pg_bin = raw.get("pg_bin")
    if not isinstance(pg_bin, str) or not pg_bin.startswith("/") or os.path.islink(pg_bin) or not os.path.isdir(pg_bin):
        raise Stop("executable_path_invalid", executable="pg_bin")
    for tool in ("pg_ctl", "initdb", "createdb", "psql"):
        candidate = os.path.join(pg_bin, tool)
        if os.path.islink(candidate) or not os.path.isfile(candidate):
            raise Stop("pg_bin_incomplete", tool=tool)
    digest = raw.get("redis_server_sha256")
    if not isinstance(digest, str) or SHA64.fullmatch(digest) is None:
        raise Stop("redis_sha256_invalid")
    actual = hashlib.sha256(Path(out["redis_server"]).read_bytes()).hexdigest()
    if actual != digest:
        raise Stop("redis_sha256_mismatch")
    out["pg_bin"] = pg_bin
    out["redis_server_sha256"] = digest
    return out


def git_text(tree: str, args: list[str]) -> str:
    git_bin = shutil.which("git")
    if not git_bin:
        raise Stop("git_missing")
    completed = subprocess.run([git_bin, "-C", tree, *args], capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise Stop("git_command_failed", git_args=args, code=completed.returncode)
    return completed.stdout.strip()


def git_ancestor(tree: str, ancestor: str, commit: str, reason: str) -> None:
    git_bin = shutil.which("git")
    if not git_bin:
        raise Stop("git_missing")
    completed = subprocess.run(
        [git_bin, "-C", tree, "merge-base", "--is-ancestor", ancestor, commit],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise Stop(reason, code=completed.returncode)


def require_exact_head(tree: str, commit: str, dirty_reason: str, mismatch_reason: str) -> None:
    if not os.path.isdir(tree):
        raise Stop("tree_unavailable", tree_role=mismatch_reason)
    head = git_text(tree, ["rev-parse", "HEAD"])
    if head != commit:
        raise Stop(mismatch_reason, actual_prefix=head[:12])
    status = git_text(tree, ["status", "--porcelain=v1"])
    if status:
        raise Stop(dirty_reason)


VERIFIER_STATUS_LINES = (
    "?? docs/development/PLM_W23_REAL_HTTP_DESIGN_VALIDATION_20261024.md",
    "?? scripts/verification/plm-collaboration-paired/",
)


def meta_status_is_verifier_only(status: str) -> bool:
    """The six verifier files are untracked and are not a commit. Any other porcelain line is dirt."""
    lines = [line for line in status.splitlines() if line]
    return all(line in VERIFIER_STATUS_LINES for line in lines)


def require_meta(meta_tree: str | None, meta_ref: str | None) -> str:
    if meta_tree is None or meta_ref is None:
        raise Stop("meta_tree_or_ref_missing")
    if meta_tree != META_TREE or os.path.islink(meta_tree):
        raise Stop("meta_tree_not_admitted_worktree")
    if SHA40.fullmatch(meta_ref) is None:
        raise Stop("meta_ref_invalid")
    if not os.path.isdir(meta_tree):
        raise Stop("tree_unavailable", tree_role="meta_head_mismatch")
    head = git_text(meta_tree, ["rev-parse", "HEAD"])
    if head != meta_ref:
        raise Stop("meta_head_mismatch", actual_prefix=head[:12])
    status = git_text(meta_tree, ["status", "--porcelain=v1"])
    if not meta_status_is_verifier_only(status):
        raise Stop("meta_tree_dirty")
    return meta_ref


def preflight(args: argparse.Namespace) -> dict:
    if not args.native_pin:
        raise Stop("missing_native_pin")
    pin = read_pin(args.native_pin)
    if pin.get("docker") is True:
        raise Stop("docker_refused")
    commit = require_commit(pin)
    refuse_ancestor_override(pin)
    tree = require_tree_shape(pin)
    executables = require_executables(pin)
    require_exact_head(tree, commit, "native_tree_dirty", "native_head_mismatch")
    git_ancestor(tree, MAIN_ANCESTOR, commit, "main_ancestor_not_ancestor")
    meta_ref = require_meta(args.meta_tree, args.meta_ref)
    fail_closed_environment()
    return {
        "status": "ADMITTED",
        "runtime": "NOT_RUN",
        "services_started": False,
        "http_executed": False,
        "fallback_commit": None,
        "commit_prefix": commit[:12],
        "meta_ref_prefix": meta_ref[:12],
        "planning_meta_is_not_default": PLANNING_META_COMMIT,
        "main_ancestor": MAIN_ANCESTOR,
        "schema_mode": native_fixture.SCHEMA_MODE,
        "executables_admitted": sorted(executables),
        "_pin": pin,
        "_commit": commit,
        "_tree": tree,
        "_executables": executables,
    }


def child_env(base: dict[str, str]) -> dict[str, str]:
    fail_closed_environment()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LC_ALL": "C",
        "LANG": "C",
    }
    env.update(base)
    for forbidden in ("NODE_TLS_REJECT_UNAUTHORIZED", "VITEST"):
        if forbidden in env:
            raise Stop("child_env_refused", name=forbidden)
    if env.get("NODE_ENV") == "test":
        raise Stop("child_env_refused", name="NODE_ENV")
    return env


def redis_argv(binary: str, root: Path) -> list[str]:
    return [
        binary, "--port", "0", "--unixsocket", str(root / "redis.sock"),
        "--unixsocketperm", "700", "--dir", str(root / "redis"),
        "--save", "", "--appendonly", "yes", "--appendfsync", "always",
    ]


def openssl_config(root: Path) -> Path:
    path = root / "openssl.cnf"
    path.write_text(
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n"
        "[dn]\nCN=127.0.0.1\n[v3]\n"
        "subjectAltName=IP:127.0.0.1,DNS:localhost\n"
        "basicConstraints=critical,CA:TRUE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n"
        "extendedKeyUsage=serverAuth\n",
        encoding="utf-8",
    )
    path.chmod(0o600)
    return path


def public_admission(admission: dict) -> dict:
    hidden = {key: value for key, value in admission.items() if not key.startswith("_")}
    hidden["profile_result"] = "NOT_GREEN"
    hidden["http_executed"] = False
    hidden["services_started"] = False
    return hidden


_SECRET_MARKERS = ("password", "access_token", "authorization", "secret", "postgresql://", "postgresql+psycopg://")


def _bounded_redacted(text: str | None) -> list[str]:
    lines: list[str] = []
    for raw in (text or "").splitlines():
        lower = raw.lower()
        lines.append("[redacted]" if any(marker in lower for marker in _SECRET_MARKERS) else raw[:240])
        if len(lines) >= 30:
            break
    return lines


def phase_note(label: str, completed: subprocess.CompletedProcess[str], transcript: object = None) -> dict:
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    counts: dict[str, int] = {}
    if isinstance(transcript, list):
        for item in transcript:
            if isinstance(item, dict):
                status = str(item.get("status"))
                counts[status] = counts.get(status, 0) + 1
    return {
        "phase": label,
        "exit": completed.returncode,
        "stdout_sha256": hashlib.sha256(stdout.encode()).hexdigest(),
        "stderr_sha256": hashlib.sha256(stderr.encode()).hexdigest(),
        "stdout_lines": _bounded_redacted(stdout),
        "stderr_lines": _bounded_redacted(stderr),
        "case_counts": counts,
        "transcript": transcript if isinstance(transcript, list) else [],
    }


def checked(
    argv: list[str],
    env: dict[str, str],
    cwd: str,
    timeout: int,
    phases: list[dict] | None = None,
    label: str = "",
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(argv, env=env, cwd=cwd, capture_output=True, text=True, check=False, timeout=timeout)
    if phases is not None and label:
        phases.append(phase_note(label, completed))
    if completed.returncode != 0:
        raise Stop(
            "profile_red",
            error="command_exit_" + str(completed.returncode),
            phases=list(phases or []),
        )
    return completed


def wait_tcp(port: int, process: subprocess.Popen[str]) -> None:
    deadline = time.time() + 30
    while time.time() < deadline:
        if process.poll() is not None:
            raise Stop("profile_red", error="process_exited")
        probe = socket.socket()
        try:
            probe.settimeout(0.2)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        finally:
            probe.close()
        time.sleep(0.1)
    raise Stop("profile_red", error="port_not_open")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def last_json(text: str) -> dict:
    line = (text or "").strip().splitlines()
    if not line:
        return {}
    try:
        parsed = json.loads(line[-1])
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def execute_profile(args: argparse.Namespace, admission: dict) -> dict:
    """Start owned services only after preflight returned ADMITTED."""
    if admission.get("status") != "ADMITTED":
        raise Stop("not_admitted")
    fail_closed_environment()
    executables = admission["_executables"]
    node = executables["node"]
    tree = admission["_tree"]
    socket_script = os.path.join(META_TREE, OWNED_SOCKET)
    if not os.path.isfile(socket_script):
        raise Stop("owned_socket_missing")
    runtime: Path | None = None
    pg_receipt: dict | None = None
    processes: list[subprocess.Popen[str]] = []
    result: dict | None = None
    outcome: dict | None = None
    cleanup_fault: str | None = None
    phases: list[dict] = []
    witnesses: list[dict] = []
    cleanup_evidence: dict = {}
    fault: Stop | None = None
    try:
        start = subprocess.run(
            [node, socket_script, "start"],
            env=child_env({"PG_BIN": executables["pg_bin"]}),
            capture_output=True, text=True, check=False, timeout=180,
        )
        phases.append(phase_note("owned_socket_start", start))
        line = (start.stdout or "").strip().splitlines()
        proof = json.loads(line[-1]) if line else {}
        if proof.get("root") and proof.get("nonce"):
            pg_receipt = proof
        if start.returncode != 0 or proof.get("ok") is not True:
            raise Stop("profile_red", error="owned_socket_start_failed", phases=list(phases))
        if proof.get("pgBin") != executables["pg_bin"]:
            raise Stop("profile_red", error="pg_bin_fallback_refused")
        dsn = str(proof.get("dsn") or "")
        if "localhost" not in dsn or "host=" not in dsn or "@localhost/" not in dsn:
            raise Stop("profile_red", error="dsn_shape_refused")
        nonce = str(proof["nonce"])
        if proof.get("root") != native_fixture.OWNED_SOCKET_PREFIX + nonce or proof.get("socket") != proof["root"] + "/s":
            raise Stop("profile_red", error="owned_socket_root_refused")
        runtime = Path("/tmp/plm-w23-real-http-run-" + nonce)
        if runtime.exists():
            raise Stop("profile_red", error="runtime_directory_exists")
        runtime.mkdir(mode=0o700)
        (runtime / ".plm-w23-real-http-owned").write_text(json.dumps({"nonce": nonce}) + "\n", encoding="utf-8")
        os.chmod(runtime / ".plm-w23-real-http-owned", 0o600)
        (runtime / "redis").mkdir(mode=0o700)
        actual_redis = hashlib.sha256(Path(executables["redis_server"]).read_bytes()).hexdigest()
        if actual_redis != executables["redis_server_sha256"]:
            raise Stop("profile_red", error="redis_sha256_mismatch")
        redis = subprocess.Popen(
            redis_argv(executables["redis_server"], runtime), env=child_env({}), cwd=runtime,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        processes.append(redis)
        witnesses.append({"name": "redis", "pid": redis.pid})
        deadline = time.time() + 5
        while not (runtime / "redis.sock").exists():
            if redis.poll() is not None or time.time() > deadline:
                raise Stop("profile_red", error="redis_socket")
            time.sleep(0.1)
        openssl_config(runtime)
        checked([
            executables["openssl"], "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(runtime / "private.pem"), "-out", str(runtime / "cert.pem"),
            "-config", str(runtime / "openssl.cnf"),
        ], child_env({}), str(runtime), 30, phases, "openssl_cert")
        os.chmod(runtime / "private.pem", 0o600)
        admission_names = {
            "meta": "w23meta" + nonce,
            "global": "w23glob" + nonce,
            "identity": "w23ident" + nonce,
            "tenant": native_fixture.PLANE_PREFIX["tenant"] + nonce,
        }
        for database in admission_names.values():
            checked([
                os.path.join(executables["pg_bin"], "createdb"), "-h", proof["socket"], "-p", "5432", "-U", "plm_test", database,
            ], child_env({}), str(runtime), 60, phases, "createdb")
        witnesses.append({
            "name": "owned_databases",
            "source": "createdb",
            "roles": ["meta", "global", "identity", "tenant"],
        })

        def database_dsn(role: str) -> str:
            return "postgresql://plm_test@localhost/" + admission_names[role] + "?host=" + proof["socket"] + "&port=5432"

        databases = {
            "meta": database_dsn("meta"),
            "global": database_dsn("global"),
            "identity": database_dsn("identity"),
            "tenant": database_dsn("tenant"),
            "tenant_orm": database_dsn("tenant") + "&options=-csearch_path%3D" + native_fixture.TENANT_SCHEMA,
        }
        secret_path = runtime / "secret.json"
        receipt_path = runtime / "fixture.json"
        owned_path = runtime / "owned-resource.json"
        marker_path = proof["root"] + "/" + native_fixture.OWNED_SOCKET_MARKER
        fixture_context = {
            "services_admitted": True,
            "allow_spawn": True,
            "commit": admission["_commit"],
            "tree": tree,
            "python": executables["python"],
            "databases": databases,
            "names": admission_names,
            "secret_path": str(secret_path),
            "receipt_path": str(receipt_path),
            "owned_path": str(owned_path),
            "owned_nonce": nonce,
            "owned_root": proof["root"],
            "owned_socket": proof["socket"],
            "owned_marker": marker_path,
        }
        owned_descriptor = {
            "nonce": nonce,
            "root": proof["root"],
            "socket": proof["socket"],
            "marker": marker_path,
            "kind": native_fixture.OWNED_SOCKET_KIND,
            "names": admission_names,
            "databases": databases,
        }
        owned_fd = os.open(owned_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(owned_fd, "w", encoding="utf-8") as handle:
            json.dump(owned_descriptor, handle)
        os.chmod(owned_path, 0o600)
        context_path = runtime / "native-context.json"
        fd = os.open(context_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(fixture_context, handle)
        os.chmod(context_path, 0o600)
        fixture_script = os.path.join(META_TREE, "scripts", "verification", "plm-collaboration-paired", "native_fixture.py")
        checked(
            [executables["python"], fixture_script, "seed", "--context", str(context_path)],
            child_env({"PYTHONPATH": os.path.join(tree, "src")}),
            tree,
            600,
            phases,
            "native_seed",
        )
        if not receipt_path.is_file():
            raise Stop("profile_red", error="fixture_receipt_missing")
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        route = receipt.get("routing_witness") if isinstance(receipt, dict) else None
        if isinstance(route, dict):
            observed_database = route.get("current_database")
            observed_schema = route.get("current_schema")
            if (
                not isinstance(observed_database, str)
                or not isinstance(observed_schema, str)
                or observed_database != admission_names["tenant"]
                or observed_schema != native_fixture.TENANT_SCHEMA
            ):
                raise Stop(
                    "profile_red",
                    error="business_route_refused",
                    http_executed=False,
                    phases=list(phases),
                )
            routing_witness = {
                "current_database": observed_database,
                "current_schema": observed_schema,
            }
            if phases and phases[-1].get("phase") == "native_seed":
                phases[-1]["routing_witness"] = routing_witness
            witnesses.append({
                "name": "business_route",
                "source": "current_database_current_schema",
                "current_database": observed_database,
                "current_schema": observed_schema,
            })
        else:
            raise Stop(
                "profile_red",
                error="business_route_refused",
                http_executed=False,
                phases=list(phases),
            )
        refusal = native_fixture.signed_import_refusal(receipt)
        if refusal is not None:
            gaps = receipt.get("gaps") if isinstance(receipt, dict) else None
            raise Stop(
                "profile_red",
                error=refusal,
                http_executed=False,
                phases=list(phases),
                gap_codes=[item.get("code") for item in gaps or [] if isinstance(item, dict)],
            )
        meta_env = child_env({
            "DATABASE_URL": database_dsn("meta"),
            "NODE_ENV": "development",
            "ENABLE_PLM": "true",
            "PRODUCT_MODE": "platform",
            "RBAC_TOKEN_TRUST": "false",
            "MULTITABLE_ENABLE_WRITER_FENCE": "true",
            "CACHE_TYPE": "memory",
            "FEATURE_CACHE": "false",
            "CACHE_IMPL": "null",
            "REDIS_URL": str(runtime / "redis.sock"),
        })
        backend = os.path.join(META_TREE, "packages", "core-backend")
        checked([node, executables["tsx"], "src/db/migrate.ts", "--latest"], meta_env, backend, 600, phases, "meta_migrate_latest")
        for name in META_CONFIRM:
            checked([node, executables["tsx"], "src/db/migrate.ts", "--confirm", name], meta_env, backend, 120, phases, "meta_confirm")
        runner = os.path.join(META_TREE, "scripts", "verification", "plm-collaboration-paired", "run.mts")
        checked(
            [node, executables["tsx"], runner, "seed-meta", "--secret", str(secret_path), "--owned", str(owned_path)],
            meta_env,
            backend,
            180,
            phases,
            "meta_seed",
        )
        native_env = child_env({
            "PYTHONPATH": os.path.join(tree, "src"),
            "PYTHONUNBUFFERED": "1",
            "YUANTUS_DATABASE_URL": native_fixture.native_sqlalchemy_url(databases["global"]),
            "YUANTUS_IDENTITY_DATABASE_URL": native_fixture.native_sqlalchemy_url(databases["identity"]),
            "YUANTUS_DATABASE_URL_TEMPLATE": native_fixture.owned_tenant_template(databases["tenant_orm"]),
            "YUANTUS_TENANCY_MODE": native_fixture.TENANCY_MODE,
            "YUANTUS_SCHEMA_MODE": "migrations",
            "YUANTUS_AUTH_MODE": "required",
        })
        native_port = free_port()
        meta_port = free_port()
        native_log = (runtime / "native.log").open("w", encoding="utf-8")
        native = subprocess.Popen(
            [executables["python"], "-m", "uvicorn", "yuantus.api.app:app", "--host", "127.0.0.1",
             "--port", str(native_port), "--ssl-certfile", str(runtime / "cert.pem"),
             "--ssl-keyfile", str(runtime / "private.pem"), "--access-log"],
            cwd=tree, env=native_env, stdout=native_log, stderr=native_log,
        )
        processes.append(native)
        witnesses.append({"name": "native", "pid": native.pid, "source": "uvicorn"})
        wait_tcp(native_port, native)
        native_origin = "https://127.0.0.1:" + str(native_port)
        tls_negative = (
            "const url=process.argv[1];"
            "fetch(url).then(()=>process.exit(2),(err)=>{"
            "const cause=(err&&err.cause)||{};"
            "const code=String(cause.code||err.code||'');"
            "const text=String(cause.message||err.message||'');"
            "const certificate=/CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|ALTNAME|ERR_TLS/.test(code+' '+text);"
            "process.stdout.write(JSON.stringify({certificate:certificate,code:code.slice(0,80)}));"
            "process.exit(certificate?0:3);"
            "});"
        )
        negative = subprocess.run(
            [node, "-e", tls_negative, native_origin],
            env=child_env({}), capture_output=True, text=True, check=False, timeout=15,
        )
        phases.append(phase_note("tls_negative", negative))
        tls_proof = last_json(negative.stdout)
        if negative.returncode != 0 or tls_proof.get("certificate") is not True:
            raise Stop(
                "profile_red",
                error="tls_certificate_rejection_missing",
                http_executed=False,
                phases=list(phases),
                tls_code=tls_proof.get("code"),
            )
        meta_env["PORT"] = str(meta_port)
        meta_env["NODE_EXTRA_CA_CERTS"] = str(runtime / "cert.pem")
        meta_log = (runtime / "meta.log").open("w", encoding="utf-8")
        meta = subprocess.Popen(
            [node, executables["tsx"], "src/index.ts"], cwd=backend, env=meta_env, stdout=meta_log, stderr=meta_log,
        )
        processes.append(meta)
        witnesses.append({"name": "meta", "pid": meta.pid, "source": "index.ts"})
        wait_tcp(meta_port, meta)
        phase = "before_restart"
        seen: set[str] = set()
        actions = {
            "after_restart": lambda: None,
            "after_delta": lambda: native_fixture.descriptive_delta(fixture_context),
            "after_revoke": lambda: native_fixture.revoke_membership(fixture_context),
            "after_restore": lambda: native_fixture.restore_membership(fixture_context),
        }

        def restart_meta() -> None:
            nonlocal meta
            if meta.poll() is None:
                meta.terminate()
                meta.wait(timeout=10)
            meta = subprocess.Popen(
                [node, executables["tsx"], "src/index.ts"], cwd=backend, env=meta_env, stdout=meta_log, stderr=meta_log,
            )
            processes.append(meta)
            witnesses.append({"name": "meta_restart", "pid": meta.pid, "source": "index.ts"})
            wait_tcp(meta_port, meta)

        actions["after_restart"] = restart_meta
        while True:
            http_admission = {
                "ready": True, "services_admitted": True, "commit": admission["_commit"], "phase": phase,
                "metaOrigin": "http://127.0.0.1:" + str(meta_port), "nativeOrigin": native_origin,
                "secretPath": str(secret_path), "journalPath": str(runtime / "native.log"),
                "statePath": str(runtime / "state.json"), "fixtureReceiptPath": str(runtime / "fixture.json"),
                "tlsCertificateRejected": True, "nativePid": native.pid,
                "profile": "w23-real-http",
            }
            http_path = runtime / "admission.json"
            http_path.write_text(json.dumps(http_admission), encoding="utf-8")
            os.chmod(http_path, 0o600)
            completed = subprocess.run(
                [node, executables["tsx"], runner, str(http_path)],
                env=child_env({
                "NODE_EXTRA_CA_CERTS": str(runtime / "cert.pem"),
                "NODE_ENV": "development",
                "DATABASE_URL": database_dsn("meta"),
                "W23_OWNED_META_URL": database_dsn("meta"),
            }),
                capture_output=True, text=True, check=False, timeout=180,
            )
            payload_line = (completed.stdout or "").strip().splitlines()
            payload = json.loads(payload_line[-1]) if payload_line else {}
            note = phase_note("http_" + phase, completed, payload.get("transcript"))
            note["status"] = payload.get("status")
            note["reason"] = payload.get("reason")
            note["journal"] = payload.get("journal") if isinstance(payload.get("journal"), list) else []
            phases.append(note)
            if completed.returncode == 0 and payload.get("status") == "GREEN" and payload.get("http_executed") is True:
                result = {
                    "status": "GREEN", "runtime": "GREEN", "profile_result": "GREEN",
                    "http_executed": True, "services_started": True, "fallback_commit": None,
                    "missing_prereqs": [], "phases": list(phases),
                    "credential_negative": payload.get("credential_negative"),
                }
                break
            if completed.returncode != 10 or payload.get("status") != "CONTINUE" or payload.get("next_phase") not in actions:
                raise Stop(
                    "profile_red",
                    error=str(payload.get("reason") or "http_failed"),
                    http_executed=True,
                    phases=list(phases),
                )
            nxt = str(payload["next_phase"])
            if nxt in seen:
                raise Stop("profile_red", error="phase_loop", http_executed=True, phases=list(phases))
            seen.add(nxt)
            actions[nxt]()
            phase = nxt
        outcome = result
    except Stop as stopped:
        fault = stopped
    except Exception as exc:
        fault = Stop(
            "profile_red",
            error=type(exc).__name__,
            http_executed=any(
                note.get("phase", "").startswith("http_") and bool(note.get("transcript"))
                for note in phases
            ),
        )
    finally:
        try:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if pg_receipt and pg_receipt.get("root") and pg_receipt.get("nonce"):
                owned_env = child_env({"PG_BIN": executables["pg_bin"]})
                stop = subprocess.run(
                    [node, socket_script, "stop", "--root", pg_receipt["root"], "--nonce", pg_receipt["nonce"]],
                    env=owned_env, capture_output=True, text=True, check=False, timeout=120,
                )
                stop_proof = last_json(stop.stdout)
                phases.append(phase_note("owned_stop", stop))
                if stop.returncode != 0 or stop_proof.get("postgresStopped") is not True or stop_proof.get("directoryRemoved") is not False:
                    cleanup_fault = "owned_stop_unproved"
                cleaned = subprocess.run(
                    [node, socket_script, "cleanup", "--root", pg_receipt["root"], "--nonce", pg_receipt["nonce"]],
                    env=owned_env, capture_output=True, text=True, check=False, timeout=120,
                )
                cleaned_proof = last_json(cleaned.stdout)
                phases.append(phase_note("owned_cleanup", cleaned))
                cleanup_evidence.update({
                    "stop_exit": stop.returncode,
                    "stop_postgres_stopped": stop_proof.get("postgresStopped"),
                    "stop_directory_removed": stop_proof.get("directoryRemoved"),
                    "cleanup_exit": cleaned.returncode,
                    "cleanup_directory_removed": cleaned_proof.get("directoryRemoved"),
                    "cleanup_postgres_stopped": cleaned_proof.get("postgresStopped"),
                    "cleanup_marker_matched": cleaned_proof.get("markerMatched"),
                })
                if (
                    cleaned.returncode != 0
                    or cleaned_proof.get("directoryRemoved") is not True
                    or cleaned_proof.get("postgresStopped") is not True
                    or cleaned_proof.get("markerMatched") is not True
                ):
                    cleanup_fault = cleanup_fault or "owned_cleanup_unproved"
                if os.path.isdir(str(pg_receipt["root"])):
                    cleanup_fault = cleanup_fault or "owned_directory_retained"
            elif pg_receipt is not None or processes:
                cleanup_fault = cleanup_fault or "owned_stop_unproved"
            if runtime and (runtime / ".plm-w23-real-http-owned").is_file():
                marker = json.loads((runtime / ".plm-w23-real-http-owned").read_text(encoding="utf-8"))
                expected = "/tmp/plm-w23-real-http-run-" + str(marker.get("nonce"))
                alive = any(process.poll() is None for process in processes)
                if str(runtime) == expected and not alive:
                    shutil.rmtree(runtime)
                    if runtime.exists():
                        cleanup_fault = cleanup_fault or "runtime_directory_retained"
                else:
                    cleanup_fault = cleanup_fault or "runtime_cleanup_refused"
            cleanup_evidence["fault"] = cleanup_fault
            cleanup_evidence["runtime_removed"] = runtime is None or not runtime.exists()
        except Exception:
            cleanup_fault = cleanup_fault or "owned_cleanup_unproved"
            cleanup_evidence["fault"] = cleanup_fault
    if fault is not None:
        fault.extra["phases"] = list(phases)
        fault.extra["cleanup"] = cleanup_evidence
        fault.extra["witnesses"] = witnesses
        raise fault
    if outcome is not None and cleanup_fault:
        raise Stop(
            "profile_red",
            error=cleanup_fault,
            http_executed=True,
            profile_result="RED",
            phases=list(phases),
            cleanup=cleanup_evidence,
            witnesses=witnesses,
        )
    if outcome is None:
        raise Stop(
            "profile_red",
            error="profile_result_missing",
            phases=list(phases),
            cleanup=cleanup_evidence,
            witnesses=witnesses,
        )
    outcome["phases"] = list(phases)
    outcome["cleanup"] = cleanup_evidence
    outcome["witnesses"] = witnesses
    return outcome


def command_preflight(args: argparse.Namespace) -> None:
    try:
        admission = preflight(args)
    except Stop as stopped:
        emit({"status": "NOT_RUN", "runtime": "NOT_RUN", "reason": stopped.reason, **stopped.extra}, 2)
        return
    emit(public_admission(admission), 0)


def command_run(args: argparse.Namespace) -> None:
    try:
        admission = preflight(args)
    except Stop as stopped:
        emit({
            "status": "NOT_RUN",
            "runtime": "NOT_RUN",
            "reason": stopped.reason,
            "services_started": False,
            "http_executed": False,
            **stopped.extra,
        }, 2)
        return
    try:
        result = execute_profile(args, admission)
    except Stop as stopped:
        emit({
            "status": "RED",
            "runtime": "RED",
            "reason": stopped.reason,
            "services_started": True,
            "http_executed": False,
            "profile_result": "RED",
            **stopped.extra,
        }, 1)
        return
    emit(result, 0 if result.get("status") == "GREEN" else 1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "W23 paired HTTP coordinator. Unadmitted commands do not start services and are not an HTTP pass. "
            "Native SQLAlchemy URLs use postgresql+psycopg. The Meta pg URL stays postgresql."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("preflight", command_preflight), ("run", command_run)):
        command = sub.add_parser(name)
        command.add_argument("--native-pin", default=None)
        command.add_argument("--meta-tree", default=None)
        command.add_argument("--meta-ref", default=None)
        command.set_defaults(handler=handler)
    return parser


def main(argv: list[str]) -> None:
    args = build_parser().parse_args(argv)
    args.handler(args)


if __name__ == "__main__":
    main(sys.argv[1:])
