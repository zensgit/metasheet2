#!/usr/bin/env python3
"""Owned Native fixture for the one W23 paired HTTP profile.

Importing this module does not open a database, listen on a socket, or import
the Native package. Admitted operations call the existing Alembic configs and
AuthService / diagnostic services. They do not accept an arbitrary argv.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import stat
import subprocess
import sys
import uuid
from pathlib import Path

E3_PLANNING_COMMIT = "e3f44e5a8816b52f0e30be553c98fff7b344ab25"
MAIN_ANCESTOR = "3fd21e31cca358f1b1a80dd6365ec060cc23bc5e"
SCHEMA_MODE = "alembic-upgrade-head"
TENANCY_MODE = "db-per-tenant"
TENANT_ID = "w23http"
ORG_ID = "w23org"
USERNAME = "w23owner"
TENANT_SCHEMA = "yt_t_w23http"
ITEM_NUMBER = "W23-HTTP-ITEM"
CHILD_ITEM_NUMBER = "W23-HTTP-CHILD"
ROUTING_NAME = "W23 owned routing"
BASELINE_NAME = "W23 owned baseline"
MBOM_NAME = "W23 owned mbom"
DELTA_MBOM_NAME = "W23 owned mbom delta"
ECO_NAME = "W23 owned diagnostic eco"
DELTA_ECO_NAME = "W23 owned eco delta"
DELTA_ECO_DESCRIPTION = "owned fixture eco descriptive delta"
APP_LICENSE_NAME = "plm.collaboration_source_read"
FEATURE_KEY = "collaboration_source_read"
PART_TYPE_ID = "Part"
ASSEMBLY_TYPE_ID = "ASSEMBLY"
PART_BOM_TYPE_ID = "Part BOM"
FIXTURE_RELEASE_STATE = "Released"
FIXTURE_LICENSE_KID = "w23-owned-fixture-kid"
PLANE_PREFIX = {"global": "w23glob", "identity": "w23ident", "tenant": "w23ten" + TENANT_ID}
OWNED_SOCKET_PREFIX = "/tmp/plm-managed-consumer-pg-"
OWNED_SOCKET_MARKER = ".plm-managed-owned"
OWNED_SOCKET_KIND = "plm-managed-companion-socket"
RUNTIME_PREFIX = "/tmp/plm-w23-real-http-run-"
ADMISSION_NAMES = ("meta", "global", "identity", "tenant")
NATIVE_SQLALCHEMY_SCHEME = "postgresql+psycopg"
NATIVE_SQLALCHEMY_PREFIX = NATIVE_SQLALCHEMY_SCHEME + "://"
DECLARED_PSYCOPG3_DRIVER = "psycopg"
R11_RUN_MTS_SHA256 = "2686de1808f350f6742e58abbc0e21b20c09de2b8b077a42efc1c4ef32a3e986"
RUN_MTS_SHA256 = "014605bfc908968503d09c519d4879db5d601a5cee266f6ad04f0a0d367cbf15"

SCHEMA_PLAN = (
    {"role": "global", "ini": "alembic.ini", "extra": ()},
    {"role": "identity", "ini": "alembic.identity.ini", "extra": ()},
    {
        "role": "tenant",
        "ini": "alembic_tenant.ini",
        "extra": ("-x", "target_schema=" + TENANT_SCHEMA, "-x", "create_schema=1"),
    },
)


class FixtureRefusal(Exception):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def ancestor_override(pin: dict) -> str | None:
    if "main_ancestor" in pin or "rebased_base" in pin:
        return "ancestor_override_refused"
    return None


def license_not_written_here() -> dict:
    """Self-check fact. Admitted seed is the only writer, and it is not called here."""
    return {
        "code": "app_license_written_only_in_admitted_seed",
        "entitled": False,
        "app_license_written": False,
        "license_signature_verified": False,
        "app_name": APP_LICENSE_NAME,
        "feature": FEATURE_KEY,
    }


def static_family_gaps() -> list[dict]:
    """Source-check facts. Admitted seed writes the rows; this function does not."""
    return [
        license_not_written_here(),
        {
            "code": "service_assigned_primary_keys",
            "detail": (
                "RoutingService, MBOMService, BaselineService, RelationshipService, and "
                "BOMService.add_child assign their own primary keys. The receipt freezes "
                "the returned ids. Fixture Item, ItemVersion, ECO, and ECOStage rows use "
                "uuid4 because those string primary keys have no server default."
            ),
        },
        {
            "code": "alembic_not_importable_not_executed",
            "detail": "self-check does not import alembic and does not call upgrade_schema.",
        },
    ]


def owned_plane_refusal(url: object) -> str | None:
    """Pure DSN shape check. No connection."""
    if not isinstance(url, str) or "sqlite" in url.lower():
        return "sqlite_fallback_refused"
    if not url.startswith("postgresql://plm_test@localhost/"):
        return "dsn_refused"
    if ":" in url.split("://", 1)[1].split("@", 1)[0]:
        return "dsn_refused"
    if "host=" not in url or "port=5432" not in url:
        return "dsn_refused"
    return None


def database_name(url: str) -> str:
    return url.split("://", 1)[1].split("@", 1)[1].split("/", 1)[1].split("?", 1)[0]


def same_owned_nonce(names: dict) -> bool:
    if set(names) != set(PLANE_PREFIX):
        return False
    suffix = names["global"][len(PLANE_PREFIX["global"]):]
    if not suffix or any(character not in "0123456789abcdef" for character in suffix):
        return False
    return all(names[role] == PLANE_PREFIX[role] + suffix for role in PLANE_PREFIX)


def _hex16(value: object) -> bool:
    return isinstance(value, str) and len(value) == 16 and all(character in "0123456789abcdef" for character in value)


def parse_owned_dsn(url: object) -> str | None:
    """Return a refusal, or None when the URL has one host and exactly one port=5432."""
    if not isinstance(url, str) or "sqlite" in url.lower():
        return "sqlite_fallback_refused"
    if not url.startswith("postgresql://plm_test@localhost/"):
        return "dsn_refused"
    user = url.split("://", 1)[1].split("@", 1)[0]
    if ":" in user or "password=" in url or "sslmode=disable" in url:
        return "dsn_refused"
    query = url.split("?", 1)[1] if "?" in url else ""
    parts = [part for part in query.split("&") if part]
    hosts = [part for part in parts if part.startswith("host=")]
    ports = [part for part in parts if part.startswith("port=")]
    if len(hosts) != 1 or len(ports) != 1 or ports[0] != "port=5432":
        return "dsn_refused"
    return None


def native_sqlalchemy_url(url: object) -> str:
    """Map one owned libpq URL after parse_owned_dsn and owned_plane_refusal.

    Canonical admission stays in owned_socket_refusal. The owned descriptor and
    the Meta pg URL stay plain postgresql://. This replaces only that prefix.
    It does not open a connection.
    """
    refusal = parse_owned_dsn(url) or owned_plane_refusal(url)
    if refusal:
        raise FixtureRefusal(refusal)
    if not isinstance(url, str) or not url.startswith("postgresql://") or "+" in url:
        raise FixtureRefusal("dsn_refused")
    mapped = "postgresql+psycopg://" + url[len("postgresql://"):]
    if mapped.count("+") != 1 or not mapped.startswith(NATIVE_SQLALCHEMY_PREFIX):
        raise FixtureRefusal("dsn_refused")
    return mapped


def owned_tenant_template(url: object) -> str:
    """Derive the one Native template from an admitted concrete tenant_orm DSN.

    The database token w23ten + TENANT_ID + nonce becomes w23ten{tenant_id} + that
    nonce. Socket, port, user, and the one search_path option stay. This function
    does not accept a caller template, environment template, or fallback.
    """
    mapped = native_sqlalchemy_url(url)
    if "{" in mapped or "}" in mapped:
        raise FixtureRefusal("tenant_template_refused")
    name = database_name(mapped)
    prefix = PLANE_PREFIX["tenant"]
    if not name.startswith(prefix):
        raise FixtureRefusal("tenant_template_refused")
    nonce = name[len(prefix):]
    if not _hex16(nonce):
        raise FixtureRefusal("tenant_template_refused")
    needle = "/" + name + "?"
    if mapped.count(needle) != 1:
        raise FixtureRefusal("tenant_template_refused")
    derived = mapped.replace(needle, "/w23ten{tenant_id}" + nonce + "?", 1)
    if derived.count("{tenant_id}") != 1 or "{org_id}" in derived:
        raise FixtureRefusal("tenant_template_refused")
    database, query = derived.split("?", 1)
    if "{tenant_id}" not in database or "{tenant_id}" in query:
        raise FixtureRefusal("tenant_template_refused")
    if derived.format(tenant_id=TENANT_ID, org_id=ORG_ID) != mapped:
        raise FixtureRefusal("tenant_template_refused")
    sentinel = derived.format(tenant_id=TENANT_ID + "__other_scope", org_id=ORG_ID)
    if database_name(sentinel) == name or sentinel.split("?", 1)[1] != query:
        raise FixtureRefusal("tenant_template_refused")
    return derived


def physical_target_refusal(current: str, sentinel: str, *, socket_path: str, nonce: str) -> str | None:
    """Refuse unless parsed database names are the exact owned current/sentinel pair.

    Driver, socket, port, and search_path must match. A query-only difference is refused.
    """
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError

    if not isinstance(current, str) or not isinstance(sentinel, str) or not _hex16(nonce):
        return "physical_target_refused"
    try:
        current_url = make_url(current)
        sentinel_url = make_url(sentinel)
    except (ArgumentError, ValueError, TypeError):
        return "physical_target_refused"
    expected_current = PLANE_PREFIX["tenant"] + nonce
    expected_sentinel = "w23ten" + TENANT_ID + "__other_scope" + nonce
    if current_url.database != expected_current or sentinel_url.database != expected_sentinel:
        return "physical_target_refused"
    if len(current_url.database) >= 63 or len(sentinel_url.database) >= 63:
        return "physical_target_refused"
    option = "-csearch_path=" + TENANT_SCHEMA
    for parsed in (current_url, sentinel_url):
        if str(parsed.drivername) != NATIVE_SQLALCHEMY_SCHEME:
            return "physical_target_refused"
        if parsed.username != "plm_test" or parsed.host != "localhost" or parsed.password is not None:
            return "physical_target_refused"
        if parsed.query.get("host") != socket_path or parsed.query.get("port") != "5432":
            return "physical_target_refused"
        if parsed.query.get("options") != option or set(parsed.query.keys()) != {"host", "port", "options"}:
            return "physical_target_refused"
    return None


def owned_socket_refusal(proof: object) -> str | None:
    """Pure owned-socket admission. This does not read a marker or open a database."""
    if not isinstance(proof, dict):
        return "owned_socket_refused"
    nonce = proof.get("nonce")
    if not _hex16(nonce):
        return "owned_socket_refused"
    root = OWNED_SOCKET_PREFIX + str(nonce)
    socket_path = root + "/s"
    marker = root + "/" + OWNED_SOCKET_MARKER
    if proof.get("root") != root or proof.get("socket") != socket_path or proof.get("marker") != marker:
        return "owned_socket_refused"
    if proof.get("root_is_symlink") is not False or proof.get("socket_is_symlink") is not False:
        return "owned_socket_refused"
    if proof.get("marker_is_symlink") is True or proof.get("marker_is_regular_file") is not True:
        return "owned_socket_refused"
    if proof.get("root_realpath") != root or proof.get("socket_realpath") != socket_path or proof.get("marker_realpath") != marker:
        return "owned_socket_refused"
    body = proof.get("marker_body")
    if not isinstance(body, dict) or set(body) != {"nonce", "kind"}:
        return "owned_socket_refused"
    if body.get("nonce") != nonce or body.get("kind") != OWNED_SOCKET_KIND:
        return "owned_socket_refused"
    names = proof.get("names")
    if not isinstance(names, dict) or set(names) != set(ADMISSION_NAMES):
        return "owned_socket_refused"
    expected_names = {
        "meta": "w23meta" + str(nonce),
        "global": "w23glob" + str(nonce),
        "identity": "w23ident" + str(nonce),
        "tenant": PLANE_PREFIX["tenant"] + str(nonce),
    }
    if any(names.get(role) != expected_names[role] for role in ADMISSION_NAMES):
        return "owned_socket_refused"
    query = "host=" + socket_path + "&port=5432"
    base = "postgresql://plm_test@localhost/"
    expected = {
        "meta": base + expected_names["meta"] + "?" + query,
        "global": base + expected_names["global"] + "?" + query,
        "identity": base + expected_names["identity"] + "?" + query,
        "tenant": base + expected_names["tenant"] + "?" + query,
        "tenant_orm": base + expected_names["tenant"] + "?" + query + "&options=-csearch_path%3D" + TENANT_SCHEMA,
    }
    databases = proof.get("databases")
    if not isinstance(databases, dict) or set(databases) != set(expected):
        return "owned_socket_refused"
    for role, url in expected.items():
        if databases.get(role) != url:
            return "owned_socket_refused"
        parsed = parse_owned_dsn(url)
        if parsed:
            return parsed
    runtime = RUNTIME_PREFIX + str(nonce)
    if proof.get("secret_path") != runtime + "/secret.json":
        return "owned_socket_refused"
    if proof.get("owned_path") != runtime + "/owned-resource.json":
        return "owned_socket_refused"
    if proof.get("receipt_path") != runtime + "/fixture.json":
        return "owned_socket_refused"
    return None


def _sample_owned_proof(nonce: str = "0123456789abcdef") -> dict:
    root = OWNED_SOCKET_PREFIX + nonce
    socket_path = root + "/s"
    names = {
        "meta": "w23meta" + nonce,
        "global": "w23glob" + nonce,
        "identity": "w23ident" + nonce,
        "tenant": PLANE_PREFIX["tenant"] + nonce,
    }
    query = "host=" + socket_path + "&port=5432"
    base = "postgresql://plm_test@localhost/"
    runtime = RUNTIME_PREFIX + nonce
    return {
        "nonce": nonce,
        "root": root,
        "socket": socket_path,
        "marker": root + "/" + OWNED_SOCKET_MARKER,
        "root_is_symlink": False,
        "socket_is_symlink": False,
        "root_realpath": root,
        "socket_realpath": socket_path,
        "marker_realpath": root + "/" + OWNED_SOCKET_MARKER,
        "marker_is_regular_file": True,
        "marker_is_symlink": False,
        "marker_body": {"nonce": nonce, "kind": OWNED_SOCKET_KIND},
        "names": names,
        "databases": {
            "meta": base + names["meta"] + "?" + query,
            "global": base + names["global"] + "?" + query,
            "identity": base + names["identity"] + "?" + query,
            "tenant": base + names["tenant"] + "?" + query,
            "tenant_orm": base + names["tenant"] + "?" + query + "&options=-csearch_path%3D" + TENANT_SCHEMA,
        },
        "secret_path": runtime + "/secret.json",
        "owned_path": runtime + "/owned-resource.json",
        "receipt_path": runtime + "/fixture.json",
    }


def _owned_location_matches(lexical: str) -> bool:
    """True when the final component is not a symlink and resolves under the /tmp prefix.

    /tmp itself is a platform symlink on macOS. The owned root, socket, and marker
    still have to be the real final components of the generated path.
    """
    if not isinstance(lexical, str) or not lexical.startswith("/tmp/"):
        return False
    try:
        info = os.lstat(lexical)
        if stat.S_ISLNK(info.st_mode):
            return False
        return os.path.realpath(lexical) == os.path.realpath("/tmp") + lexical[len("/tmp"):]
    except OSError:
        return False


def _admit_owned_socket(context: dict) -> None:
    """Prove the generated root, socket, and marker before reading the marker body."""
    root = context.get("owned_root")
    socket_path = context.get("owned_socket")
    marker = context.get("owned_marker")
    if not isinstance(root, str) or not isinstance(socket_path, str) or not isinstance(marker, str):
        raise FixtureRefusal("owned_socket_refused")
    try:
        root_stat = os.lstat(root)
        socket_stat = os.lstat(socket_path)
        marker_stat = os.lstat(marker)
    except OSError as exc:
        raise FixtureRefusal("owned_socket_refused") from exc
    root_link = stat.S_ISLNK(root_stat.st_mode)
    socket_link = stat.S_ISLNK(socket_stat.st_mode)
    marker_link = stat.S_ISLNK(marker_stat.st_mode)
    if (
        root_link or socket_link or marker_link
        or not stat.S_ISDIR(root_stat.st_mode) or not stat.S_ISDIR(socket_stat.st_mode)
        or not stat.S_ISREG(marker_stat.st_mode)
        or not _owned_location_matches(root)
        or not _owned_location_matches(socket_path)
        or not _owned_location_matches(marker)
    ):
        raise FixtureRefusal("owned_socket_refused")
    try:
        body = json.loads(Path(marker).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FixtureRefusal("owned_socket_refused") from exc
    names = context.get("names")
    databases = context.get("databases")
    proof = {
        "nonce": context.get("owned_nonce"),
        "root": root,
        "socket": socket_path,
        "marker": marker,
        "root_is_symlink": False,
        "socket_is_symlink": False,
        "root_realpath": root,
        "socket_realpath": socket_path,
        "marker_realpath": marker,
        "marker_is_regular_file": True,
        "marker_is_symlink": False,
        "marker_body": body if isinstance(body, dict) else {},
        "names": names if isinstance(names, dict) else {},
        "databases": databases if isinstance(databases, dict) else {},
        "secret_path": context.get("secret_path"),
        "owned_path": context.get("owned_path"),
        "receipt_path": context.get("receipt_path"),
    }
    refusal = owned_socket_refusal(proof)
    if refusal:
        raise FixtureRefusal(refusal)


def pinned_executable(path: object) -> str | None:
    """Return the logical path when its resolved target is a regular executable.

    A dangling link, a directory, and a non-executable are refused. The returned
    path is the path that was pinned, so a venv interpreter keeps its packages.
    """
    if not isinstance(path, str) or not path.startswith("/") or os.path.normpath(path) != path:
        return None
    try:
        os.lstat(path)
        followed = os.stat(path)
    except OSError:
        return None
    if not stat.S_ISREG(followed.st_mode) or not os.access(path, os.X_OK):
        return None
    resolved = os.path.realpath(path)
    try:
        resolved_stat = os.stat(resolved)
    except OSError:
        return None
    if not stat.S_ISREG(resolved_stat.st_mode) or not os.access(resolved, os.X_OK):
        return None
    return path


def assert_admitted(context: dict) -> dict:
    if not isinstance(context, dict):
        raise FixtureRefusal("context_invalid")
    if context.get("services_admitted") is not True or context.get("allow_spawn") is not True:
        raise FixtureRefusal("services_not_admitted")
    commit = context.get("commit")
    if isinstance(commit, str) and commit.lower() == E3_PLANNING_COMMIT:
        raise FixtureRefusal("e3_planning_ref_refused")
    if not isinstance(commit, str) or len(commit) != 40 or any(ch not in "0123456789abcdef" for ch in commit):
        raise FixtureRefusal("commit_invalid")
    tree = context.get("tree")
    if not isinstance(tree, str) or not tree.startswith("/") or os.path.islink(tree):
        raise FixtureRefusal("tree_invalid")
    python = pinned_executable(context.get("python"))
    if python is None:
        raise FixtureRefusal("python_invalid")
    if os.path.realpath(python) != os.path.realpath(sys.executable):
        raise FixtureRefusal("python_pin_mismatch")
    databases = context.get("databases")
    if not isinstance(databases, dict):
        raise FixtureRefusal("databases_invalid")
    for role in ("global", "identity", "tenant", "tenant_orm", "meta"):
        _require_dsn(databases.get(role))
    _admit_owned_socket(context)
    return context


def _require_dsn(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("postgresql://plm_test@localhost/"):
        raise FixtureRefusal("dsn_refused")
    user = value.split("://", 1)[1].split("@", 1)[0]
    if ":" in user or "password=" in value or "sslmode=disable" in value:
        raise FixtureRefusal("dsn_refused")
    if "host=" not in value or "port=5432" not in value:
        raise FixtureRefusal("dsn_refused")
    return value


def _write_private(path: Path, text: str) -> None:
    if path.exists() or path.is_symlink():
        raise FixtureRefusal("private_file_exists")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, 0o600)
    if (path.stat().st_mode & 0o777) != 0o600:
        raise FixtureRefusal("secret_mode_refused")


def _alembic(context: dict, step: dict, url: str) -> None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "LC_ALL": "C",
        "LANG": "C",
        "PYTHONPATH": os.path.join(context["tree"], "src"),
        "YUANTUS_DATABASE_URL": native_sqlalchemy_url(url),
        "YUANTUS_SCHEMA_MODE": "migrations",
        "ALEMBIC_RUNNING": "true",
    }
    argv = [context["python"], "-m", "alembic", "-c", step["ini"], *step["extra"], "upgrade", "head"]
    completed = subprocess.run(
        argv,
        cwd=context["tree"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
    )
    if completed.returncode != 0:
        raise FixtureRefusal("alembic_exit_" + step["role"], str(completed.returncode))


def upgrade_schema(context: dict) -> dict:
    """Exact mode alembic-upgrade-head. Not metadata.create_all and not install acceptance."""
    assert_admitted(context)
    import importlib.util

    if importlib.util.find_spec("alembic") is None:
        raise FixtureRefusal("alembic_not_importable", "pinned python has no alembic module; nothing was installed")
    urls = {
        "global": context["databases"]["global"],
        "identity": context["databases"]["identity"],
        "tenant": context["databases"]["tenant"],
    }
    for step in SCHEMA_PLAN:
        _alembic(context, step, urls[step["role"]])
    return {"schema_mode": SCHEMA_MODE, "roles": [step["role"] for step in SCHEMA_PLAN]}


def _prepare_import(context: dict) -> None:
    src = os.path.join(context["tree"], "src")
    if src not in sys.path:
        sys.path.insert(0, src)
    os.environ["YUANTUS_DATABASE_URL"] = native_sqlalchemy_url(context["databases"]["global"])
    os.environ["YUANTUS_IDENTITY_DATABASE_URL"] = native_sqlalchemy_url(context["databases"]["identity"])
    os.environ["YUANTUS_DATABASE_URL_TEMPLATE"] = owned_tenant_template(context["databases"]["tenant_orm"])
    os.environ["YUANTUS_TENANCY_MODE"] = TENANCY_MODE
    os.environ["YUANTUS_SCHEMA_MODE"] = "migrations"
    os.environ["YUANTUS_AUTH_MODE"] = "required"
    os.environ.pop("YUANTUS_LICENSE_PUBLIC_KEYS", None)
    os.environ.pop("NODE_TLS_REJECT_UNAUTHORIZED", None)


def prove_owned_engines(context: dict) -> dict:
    """Resolve the three Native planes from Settings and refuse sqlite or a non-empty database.

    Admitted DSNs stay postgresql://. Settings, Alembic, and these probes use the one
    map to postgresql+psycopg. This runs before Alembic. SELECT current_database and a
    relation count are the proof. They do not create tables.
    """
    assert_admitted(context)
    if os.path.realpath(os.getcwd()) != os.path.realpath(context["tree"]):
        raise FixtureRefusal("engine_cwd_refused")
    for role, url in (
        ("global", context["databases"]["global"]),
        ("identity", context["databases"]["identity"]),
        ("tenant", context["databases"]["tenant"]),
        ("tenant_orm", context["databases"]["tenant_orm"]),
    ):
        refusal = owned_plane_refusal(url)
        if refusal:
            raise FixtureRefusal(refusal, role)
    _prepare_import(context)
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from yuantus.config.settings import get_settings
    from yuantus.database import resolve_database_url
    from yuantus.security.auth.database import get_identity_database_url

    get_settings.cache_clear()
    settings = get_settings()
    sqlalchemy_urls = {
        role: native_sqlalchemy_url(context["databases"][role])
        for role in ("global", "identity", "tenant", "tenant_orm")
    }
    resolved = {
        "global": settings.DATABASE_URL,
        "identity": get_identity_database_url(),
        "tenant": resolve_database_url(tenant_id=TENANT_ID, org_id=ORG_ID),
    }
    expected = {
        "global": sqlalchemy_urls["global"],
        "identity": sqlalchemy_urls["identity"],
        "tenant": sqlalchemy_urls["tenant_orm"],
    }
    if settings.IDENTITY_DATABASE_URL != expected["identity"]:
        raise FixtureRefusal("identity_plane_fell_back")
    derived_template = owned_tenant_template(context["databases"]["tenant_orm"])
    if settings.DATABASE_URL_TEMPLATE != derived_template:
        raise FixtureRefusal("tenant_template_refused")
    if resolved["tenant"] != sqlalchemy_urls["tenant_orm"] or make_url(resolved["tenant"]) != make_url(sqlalchemy_urls["tenant_orm"]):
        raise FixtureRefusal("resolved_engine_refused", "tenant")
    if resolve_database_url(tenant_id=TENANT_ID, org_id=ORG_ID + "_other") != resolved["tenant"]:
        raise FixtureRefusal("resolved_engine_refused", "tenant_org")
    sentinel_route = resolve_database_url(tenant_id=TENANT_ID + "__other_scope", org_id=ORG_ID)
    route_refusal = physical_target_refusal(
        resolved["tenant"],
        sentinel_route,
        socket_path=str(context["owned_socket"]),
        nonce=str(context["owned_nonce"]),
    )
    if route_refusal:
        raise FixtureRefusal(route_refusal)
    separated = {
        make_url(resolved["tenant"]).database,
        make_url(sentinel_route).database,
        make_url(resolved["global"]).database,
        make_url(resolved["identity"]).database,
        database_name(context["databases"]["meta"]),
    }
    if len(separated) != 5:
        raise FixtureRefusal("physical_target_refused")
    if settings.TENANCY_MODE != TENANCY_MODE or settings.SCHEMA_MODE != "migrations":
        raise FixtureRefusal("settings_mode_refused")
    names = {}
    for role in ("global", "identity", "tenant"):
        if resolved[role] != expected[role] or not resolved[role].startswith(NATIVE_SQLALCHEMY_PREFIX):
            raise FixtureRefusal("resolved_engine_refused", role)
        canonical_role = "tenant_orm" if role == "tenant" else role
        canonical = "postgresql://" + resolved[role][len(NATIVE_SQLALCHEMY_PREFIX):]
        if canonical != context["databases"][canonical_role] or owned_plane_refusal(canonical) or parse_owned_dsn(canonical):
            raise FixtureRefusal("resolved_engine_refused", role)
        probe = sqlalchemy_urls["tenant"] if role == "tenant" else resolved[role]
        engine = create_engine(probe)
        try:
            if engine.dialect.driver != DECLARED_PSYCOPG3_DRIVER or str(engine.url.drivername) != NATIVE_SQLALCHEMY_SCHEME:
                raise FixtureRefusal("sqlalchemy_driver_refused", role)
            with engine.connect() as connection:
                current = connection.execute(text("SELECT current_database()")).scalar()
                count = connection.execute(text(
                    "SELECT count(*) FROM pg_class AS c "
                    "JOIN pg_namespace AS n ON n.oid = c.relnamespace "
                    "WHERE c.relkind = 'r' "
                    "AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
                )).scalar()
        finally:
            engine.dispose()
        expected_name = database_name(probe)
        if current != expected_name or int(count or 0) != 0:
            raise FixtureRefusal("owned_database_not_empty", role)
        if not expected_name.startswith(PLANE_PREFIX[role]):
            raise FixtureRefusal("owned_database_name_refused", role)
        names[role] = expected_name
    if not same_owned_nonce(names):
        raise FixtureRefusal("owned_nonce_mismatch")
    return {"planes": names, "sqlite": False, "schema_mode": settings.SCHEMA_MODE}


def _business_session(tenant_id: str, org_id: str):
    from sqlalchemy import text
    from yuantus.database import _stamp_session_scope, get_sessionmaker_for_tenant

    session = get_sessionmaker_for_tenant(tenant_id)()
    _stamp_session_scope(session, tenancy_mode=TENANCY_MODE, tenant_id=tenant_id, org_id=org_id)
    session.execute(text('SET search_path TO "' + TENANT_SCHEMA + '", public'))
    return session


def business_route_refusal(observed_database: object, observed_schema: object, *, tenant_name: object) -> str | None:
    """Refuse a post-migration observation that is not the admitted tenant name and schema."""
    if (
        not isinstance(observed_database, str)
        or not isinstance(observed_schema, str)
        or not isinstance(tenant_name, str)
        or not observed_database
        or not observed_schema
        or observed_database != tenant_name
        or observed_schema != TENANT_SCHEMA
    ):
        return "business_route_refused"
    return None


def _observe_business_route(context: dict) -> dict:
    """Read current_database and current_schema on the existing business session.

    Migrations have already run. This does not construct another session manager.
    """
    from sqlalchemy import text

    tenant_name = context["names"]["tenant"]
    if (
        tenant_name != database_name(context["databases"]["tenant"])
        or tenant_name != database_name(context["databases"]["tenant_orm"])
    ):
        raise FixtureRefusal("business_route_refused")
    session = _business_session(TENANT_ID, ORG_ID)
    try:
        observed = session.execute(text("SELECT current_database(), current_schema()")).one()
        observed_database, observed_schema = observed[0], observed[1]
    finally:
        session.close()
    if business_route_refusal(observed_database, observed_schema, tenant_name=tenant_name):
        raise FixtureRefusal("business_route_refused")
    return {"current_database": observed_database, "current_schema": observed_schema}


def _identity(context: dict) -> dict:
    _prepare_import(context)
    from yuantus.api.dependencies.auth import Identity, _ensure_rbac_user
    from yuantus.database import tenant_id_to_schema
    from yuantus.security.auth.database import get_identity_db_session
    from yuantus.security.auth.service import AuthService
    from yuantus.security.rbac.database import get_global_rbac_db_session
    from yuantus.security.rbac.models import RBACRole

    if tenant_id_to_schema(TENANT_ID) != TENANT_SCHEMA:
        raise FixtureRefusal("tenant_schema_helper_mismatch")
    password = secrets.token_urlsafe(24) + "Aa1"
    with get_identity_db_session() as identity_db:
        auth = AuthService(identity_db)
        auth.ensure_tenant(TENANT_ID, name="W23 HTTP tenant")
        auth.ensure_org(TENANT_ID, ORG_ID, name="W23 HTTP org")
        user = auth.create_user(
            tenant_id=TENANT_ID,
            username=USERNAME,
            password=password,
            email=None,
            is_superuser=False,
        )
        auth.add_membership(tenant_id=TENANT_ID, org_id=ORG_ID, user_id=int(user.id), roles=["admin"])
        auth.authenticate(tenant_id=TENANT_ID, username=USERNAME, password=password)
        auth_id = int(user.id)
    identity = Identity(
        user_id=auth_id,
        tenant_id=TENANT_ID,
        org_id=ORG_ID,
        username=USERNAME,
        email=None,
        is_superuser=False,
    )
    with get_global_rbac_db_session() as rbac_db:
        row = _ensure_rbac_user(rbac_db, identity)
        if row is None or int(row.user_id) != auth_id:
            raise FixtureRefusal("rbac_link_missing")
        role = rbac_db.query(RBACRole).filter(RBACRole.name == "admin").one_or_none()
        if role is None:
            role = RBACRole(name="admin", display_name="admin", is_active=True, is_system=False)
            rbac_db.add(role)
            rbac_db.flush()
        if role not in row.roles:
            row.roles.append(role)
        rbac_db.commit()
        rbac_id = int(row.id)
    _write_private(
        Path(context["secret_path"]),
        json.dumps(
            {
                "native": {
                    "tenant_id": TENANT_ID,
                    "org_id": ORG_ID,
                    "username": USERNAME,
                    "password": password,
                }
            }
        ),
    )
    return {"auth_user_id": auth_id, "rbac_user_id": rbac_id}


def _identifier_token(value: object) -> str:
    """Stable code or exception class. Messages, SQL, and DSNs are dropped."""
    if not isinstance(value, str) or not value or len(value) > 120:
        return ""
    first = value[0]
    if not (first.isascii() and (first.isalpha() or first == "_")):
        return ""
    for char in value[1:]:
        if not (char.isascii() and (char.isalnum() or char == "_")):
            return ""
    return value


def _gap(code: str, error: str = "") -> dict:
    item = {"code": _identifier_token(code) or "gap_code_refused"}
    token = _identifier_token(error)
    if token:
        item["error"] = token
    return item


def _note(journal: list, table: str, row_id: object, note: str) -> None:
    journal.append({
        "table": table,
        "id": str(row_id),
        "note": note,
        "acceptance": "fixture_row_only",
    })


def _ensure_item_type(session, journal: list, type_id: str, relationship: bool) -> None:
    from yuantus.meta_engine.models.meta_schema import ItemType

    row = session.get(ItemType, type_id)
    if row is not None:
        conflict = bool(row.is_relationship) != relationship
        if relationship and (
            row.source_item_type_id != PART_TYPE_ID or row.related_item_type_id != PART_TYPE_ID
        ):
            conflict = True
        if conflict:
            raise FixtureRefusal("item_type_flag_conflict", type_id)
        _note(journal, "meta_item_types", type_id, "already_present_after_alembic")
        return
    session.add(ItemType(
        id=type_id,
        label=type_id,
        is_relationship=relationship,
        is_versionable=not relationship,
        version_control_enabled=not relationship,
        source_item_type_id=PART_TYPE_ID if relationship else None,
        related_item_type_id=PART_TYPE_ID if relationship else None,
    ))
    session.flush()
    _note(journal, "meta_item_types", type_id, "orm_catalog_row_empty_after_alembic")


def _insert_part(session, journal: list, number: str, name: str, released: bool):
    from yuantus.meta_engine.models.item import Item
    from yuantus.meta_engine.version.models import ItemVersion

    item_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    state = FIXTURE_RELEASE_STATE if released else "Draft"
    item = Item(
        id=item_id,
        item_type_id=PART_TYPE_ID,
        config_id=str(uuid.uuid4()),
        generation=1,
        is_current=True,
        state=state,
        is_versionable=True,
        properties={"item_number": number, "name": name},
    )
    session.add(item)
    session.flush()
    session.add(ItemVersion(
        id=version_id,
        item_id=item_id,
        generation=1,
        revision="A",
        version_label="1.A",
        state=state,
        is_current=True,
        is_released=released,
        is_superseded=False,
        branch_name="main",
        properties={"item_number": number},
    ))
    session.flush()
    item.current_version_id = version_id
    session.flush()
    _note(
        journal,
        "meta_items",
        item_id,
        "released_fixture_state_not_release_acceptance" if released else "draft_fixture_part",
    )
    return item


def _seed_item_acl(session, journal: list, actor: dict, item_ids: list[str]) -> None:
    from yuantus.meta_engine.models.item import Item
    from yuantus.meta_engine.permission.models import Access, Permission

    permission_id = str(uuid.uuid4())
    access_id = str(uuid.uuid4())
    session.add(Permission(id=permission_id, name="W23 owned item access"))
    session.flush()
    session.add(Access(
        id=access_id,
        permission_id=permission_id,
        identity_id=str(actor["auth_user_id"]),
        can_get=True,
        can_update=True,
        can_discover=True,
    ))
    for item_id in item_ids:
        row = session.get(Item, item_id)
        if row is not None:
            row.permission_id = permission_id
    session.flush()
    _note(journal, "meta_permissions", permission_id, "owned_item_acl_auth_identity")
    _note(journal, "meta_access", access_id, "owned_item_acl_get_update_discover")


def _seed_business(actor: dict) -> dict:
    from yuantus.meta_engine.manufacturing.mbom_service import MBOMService
    from yuantus.meta_engine.services.baseline_service import BaselineService
    from yuantus.meta_engine.services.bom_service import BOMService

    gaps: list[dict] = []
    journal: list[dict] = []
    seeded: dict = {
        "item_id": None,
        "current_version_id": None,
        "child_item_id": None,
        "assembly_edge_id": None,
        "bom_edge_id": None,
        "routing_id": None,
        "mbom_id": None,
        "baseline_id": None,
        "eco_id": None,
        "rules": [],
        "provenance": journal,
        "child_release_state": None,
    }
    session = _business_session(TENANT_ID, ORG_ID)
    try:
        for type_id, relationship in (
            (PART_TYPE_ID, False),
            (PART_BOM_TYPE_ID, True),
            (ASSEMBLY_TYPE_ID, True),
        ):
            _ensure_item_type(session, journal, type_id, relationship)
        _note(
            journal,
            "meta_item_types",
            PART_BOM_TYPE_ID,
            "add_child_hardcodes_item_type_id_part_bom",
        )
        session.commit()
        parent = _insert_part(session, journal, ITEM_NUMBER, "W23 HTTP item", True)
        child = _insert_part(session, journal, CHILD_ITEM_NUMBER, "W23 HTTP child", True)
        seeded["item_id"] = parent.id
        seeded["current_version_id"] = parent.current_version_id
        seeded["child_item_id"] = child.id
        seeded["child_release_state"] = "fixture_released_not_release_acceptance"
        session.commit()
        try:
            _seed_item_acl(session, journal, actor, [parent.id, child.id])
            session.commit()
        except Exception as exc:
            session.rollback()
            gaps.append(_gap("item_acl_not_seeded", type(exc).__name__))
        _try_bom_edge(session, seeded, gaps, actor, BOMService)
        _try_assembly(session, seeded, gaps, actor)
        _try_routing(session, seeded, gaps, actor["rbac_user_id"])
        _try_mbom(session, seeded, gaps, actor["rbac_user_id"], MBOMService)
        _try_baseline(session, seeded, gaps, actor["rbac_user_id"], BaselineService)
        _try_eco(session, seeded, gaps, journal)
        return {"gaps": gaps, **seeded}
    finally:
        session.close()


def _record_rules(session, service, resource_id: str, family: str, seeded: dict, gaps: list) -> None:
    recorded = 0
    for ruleset in ("default", "readiness"):
        result = service(session).get_release_diagnostics(resource_id, ruleset_id=ruleset)
        if not isinstance(result, dict) or result.get("ruleset_id") != ruleset:
            continue
        errors = result.get("errors") or []
        missing = False
        for issue in errors:
            code = issue.get("code") if isinstance(issue, dict) else getattr(issue, "code", "")
            if str(code).endswith("_not_found"):
                missing = True
        if not missing:
            seeded["rules"].append({"family": family, "ruleset_id": ruleset})
            recorded += 1
    if recorded != 2:
        gaps.append(_gap(family + "_diagnostics_incomplete"))


def _try_bom_edge(session, seeded: dict, gaps: list, actor: dict, service) -> None:
    """BOMService.add_child checks the child version's is_released flag. The child row is fixture state."""
    if not seeded.get("child_item_id"):
        gaps.append(_gap("bom_edge_not_seeded", "missing_child"))
        return
    try:
        edge = service(session).add_child(
            str(seeded["item_id"]),
            str(seeded["child_item_id"]),
            auth_user_id=int(actor["auth_user_id"]),
            rbac_user_id=int(actor["rbac_user_id"]),
            quantity=1.0,
            uom="EA",
        )
        session.commit()
        seeded["bom_edge_id"] = edge.get("relationship_id") if isinstance(edge, dict) else None
        if not seeded["bom_edge_id"]:
            gaps.append(_gap("bom_edge_not_seeded", "missing_relationship_id"))
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("bom_edge_not_seeded", type(exc).__name__))


def _try_assembly(session, seeded: dict, gaps: list, actor: dict) -> None:
    """ASSEMBLY edge through RelationshipService. The ItemType row was inserted above."""
    from yuantus.meta_engine.models.meta_schema import ItemType
    from yuantus.meta_engine.relationship.service import RelationshipService
    from yuantus.meta_engine.services.item_release_service import ItemReleaseService

    item_type = session.get(ItemType, ASSEMBLY_TYPE_ID)
    if item_type is None or not bool(item_type.is_relationship) or item_type.id != ASSEMBLY_TYPE_ID:
        gaps.append(_gap("assembly_relationship_type_id_not_assembly"))
        return
    if not seeded.get("child_item_id"):
        gaps.append(_gap("item_release_not_seeded", "missing_child"))
        return
    try:
        edge = RelationshipService(session).create_relationship(
            source_id=str(seeded["item_id"]),
            related_id=str(seeded["child_item_id"]),
            relationship_type_name=ASSEMBLY_TYPE_ID,
            properties={},
            user_id=actor["rbac_user_id"],
        )
        session.commit()
        seeded["assembly_edge_id"] = edge.id
        _record_rules(session, ItemReleaseService, seeded["item_id"], "item_release", seeded, gaps)
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("item_release_not_seeded", type(exc).__name__))


def _try_routing(session, seeded: dict, gaps: list, rbac_user_id: int) -> None:
    from yuantus.meta_engine.manufacturing.routing_service import RoutingService

    try:
        routing = RoutingService(session).create_routing(
            ROUTING_NAME,
            item_id=seeded["item_id"],
            routing_code="W23-HTTP-RTG",
            is_primary=False,
            rbac_user_id=rbac_user_id,
        )
        session.commit()
        seeded["routing_id"] = routing.id
        _record_rules(session, RoutingService, routing.id, "routing_release", seeded, gaps)
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("routing_release_not_seeded", type(exc).__name__))


def _try_mbom(session, seeded: dict, gaps: list, rbac_user_id: int, service) -> None:
    try:
        mbom = service(session).create_mbom_from_ebom(
            seeded["item_id"],
            MBOM_NAME,
            version="1.0",
            plant_code="W23",
            rbac_user_id=rbac_user_id,
        )
        session.commit()
        seeded["mbom_id"] = mbom.id
        _record_rules(session, service, mbom.id, "mbom_release", seeded, gaps)
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("mbom_release_not_seeded", type(exc).__name__))


def _try_baseline(session, seeded: dict, gaps: list, rbac_user_id: int, service) -> None:
    try:
        baseline = service(session).create_baseline(
            name=BASELINE_NAME,
            description="W23 owned diagnostic baseline",
            root_item_id=seeded["item_id"],
            root_version_id=seeded["current_version_id"],
            max_levels=1,
            effective_at=None,
            include_substitutes=False,
            include_effectivity=False,
            line_key="item_id",
            rbac_user_id=rbac_user_id,
            roles=["admin"],
            auto_populate=True,
        )
        session.commit()
        seeded["baseline_id"] = baseline.id
        _record_rules(session, service, baseline.id, "baseline_release", seeded, gaps)
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("baseline_release_not_seeded", type(exc).__name__))


def _try_eco(session, seeded: dict, gaps: list, journal: list) -> None:
    """ORM ECO and ECOStage. create_eco notifies, so it is not called."""
    from yuantus.meta_engine.models.eco import ECO, ECOStage

    if not seeded.get("item_id"):
        gaps.append(_gap("eco_not_seeded", "missing_item"))
        return
    try:
        stage_id = str(uuid.uuid4())
        eco_id = str(uuid.uuid4())
        session.add(ECOStage(
            id=stage_id,
            name="W23 fixture stage",
            sequence=10,
            approval_type="none",
            description="fixture stage row; notification not dispatched",
        ))
        session.flush()
        session.add(ECO(
            id=eco_id,
            name=ECO_NAME,
            eco_type="bom",
            tenant_id=TENANT_ID,
            org_id=ORG_ID,
            product_id=seeded["item_id"],
            source_version_id=seeded.get("current_version_id"),
            stage_id=stage_id,
            state="draft",
            kanban_state="normal",
            priority="normal",
            description="owned fixture eco; notify approve apply release promote were not called",
        ))
        session.commit()
        seeded["eco_id"] = eco_id
        _note(journal, "meta_eco_stages", stage_id, "fixture_stage_not_business_issuance")
        _note(journal, "meta_ecos", eco_id, "orm_insert_notification_not_dispatched")
    except Exception as exc:
        session.rollback()
        gaps.append(_gap("eco_not_seeded", type(exc).__name__))


def _canonical_fixture_bytes(payload: dict) -> bytes:
    """Documented canonical JSON. Self-check uses this only as a private memory control."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def memory_signature_controls() -> list[str]:
    """Tamper and unknown-key refusal in process memory. No database and no Native import."""
    failed: list[str] = []
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except Exception:
        return ["cryptography_unavailable"]
    if _canonical_fixture_bytes({"b": 1, "a": 2}) != b'{"a":2,"b":1}':
        failed.append("canonical_bytes_drift")
    private = Ed25519PrivateKey.generate()
    public = private.public_key()
    payload = {
        "app_names": [APP_LICENSE_NAME],
        "features": [FEATURE_KEY],
        "tenant_id": TENANT_ID,
    }
    signature = private.sign(_canonical_fixture_bytes(payload))
    public.verify(signature, _canonical_fixture_bytes(payload))
    tampered = dict(payload)
    tampered["tenant_id"] = "attacker"
    try:
        public.verify(signature, _canonical_fixture_bytes(tampered))
        failed.append("tampered_signature_accepted")
    except InvalidSignature:
        pass
    unknown = Ed25519PrivateKey.generate().public_key()
    try:
        unknown.verify(signature, _canonical_fixture_bytes(payload))
        failed.append("unknown_key_accepted")
    except InvalidSignature:
        pass
    return failed


def owned_license_provenance() -> dict:
    """Facts the receipt may carry. The private key and license_key are absent."""
    return {
        "engine": "LicenseImportService.import_license",
        "verifier": "license_verification.verify_license",
        "direct_app_license_insert": False,
        "tenant_id": TENANT_ID,
        "org_id": ORG_ID,
        "app_name": APP_LICENSE_NAME,
        "features": [FEATURE_KEY],
        "kid": FIXTURE_LICENSE_KID,
        "alg": "Ed25519",
        "key_lifetime": "ephemeral_process_memory",
        "private_key_persisted": False,
        "production_issuance": "NOT_RUN",
        "install_acceptance": "NOT_RUN",
        "entitlement_reader": "EntitlementService.is_entitled",
        "entitlement_context": "separate_session",
        "license_data_role": "verification_metadata_not_authorization",
    }


def signed_import_refusal(receipt: object) -> str | None:
    """Require a verified owned-fixture import. A bare true signature flag is refused."""
    if not isinstance(receipt, dict):
        return "license_provenance_missing"
    if receipt.get("license_signature_verified") is not True:
        return "license_signature_not_verified"
    provenance = receipt.get("license_provenance")
    if not isinstance(provenance, dict):
        return "license_provenance_missing"
    if provenance.get("engine") != "LicenseImportService.import_license":
        return "license_import_engine_missing"
    if provenance.get("verifier") != "license_verification.verify_license":
        return "license_verifier_missing"
    if provenance.get("direct_app_license_insert") is not False:
        return "direct_app_license_insert_refused"
    if provenance.get("tenant_id") == provenance.get("org_id"):
        return "license_scope_collapsed"
    if provenance.get("tenant_id") != TENANT_ID or provenance.get("org_id") != ORG_ID:
        return "license_scope_refused"
    if provenance.get("app_name") != APP_LICENSE_NAME or provenance.get("features") != [FEATURE_KEY]:
        return "license_feature_refused"
    if provenance.get("private_key_persisted") is not False or provenance.get("key_lifetime") != "ephemeral_process_memory":
        return "license_key_lifetime_refused"
    if provenance.get("production_issuance") != "NOT_RUN" or provenance.get("install_acceptance") != "NOT_RUN":
        return "production_issuance_claim_refused"
    if receipt.get("entitled") is not True or receipt.get("app_license_written") is not True:
        return "fixture_not_entitled"
    return None


def _ephemeral_keypair():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    private = Ed25519PrivateKey.generate()
    raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return private, {FIXTURE_LICENSE_KID: base64.b64encode(raw).decode("ascii")}


def _license_payload(license_key: str) -> dict:
    return {
        "app_names": [APP_LICENSE_NAME],
        "expires_at": None,
        "features": [FEATURE_KEY],
        "issued_at": "2026-10-24T00:00:00Z",
        "license_key": license_key,
        "subject": "W23 owned fixture",
        "tenant_id": TENANT_ID,
    }


def _license_object(private, payload: dict, canonical) -> dict:
    signature = private.sign(canonical(payload))
    return {
        "alg": "Ed25519",
        "kid": FIXTURE_LICENSE_KID,
        "payload": payload,
        "signature": base64.b64encode(signature).decode("ascii"),
    }


def _refuse_bad_signatures_in_memory() -> None:
    """Real verify_license, before any license session. A pass here writes nothing."""
    from yuantus.meta_engine.app_framework.license_verification import (
        LicenseVerificationError,
        canonical_payload_bytes,
        verify_license,
    )

    private, public_keys = _ephemeral_keypair()
    signed = _license_object(private, _license_payload("w23-negative-not-imported"), canonical_payload_bytes)
    tampered = {
        "alg": signed["alg"],
        "kid": signed["kid"],
        "payload": dict(signed["payload"]),
        "signature": signed["signature"],
    }
    tampered["payload"]["tenant_id"] = "attacker"
    try:
        verify_license(tampered, public_keys)
    except LicenseVerificationError:
        pass
    else:
        raise FixtureRefusal("tampered_signature_accepted")
    unknown = {
        "alg": signed["alg"],
        "kid": "unknown-kid",
        "payload": signed["payload"],
        "signature": signed["signature"],
    }
    try:
        verify_license(unknown, public_keys)
    except LicenseVerificationError:
        return
    raise FixtureRefusal("unknown_kid_accepted")


def _write_app_license() -> dict:
    """Signed import through LicenseImportService, then is_entitled on a new session."""
    provenance = owned_license_provenance()
    refused = {
        "entitled": False,
        "app_license_written": False,
        "license_signature_verified": False,
        "provenance": provenance,
        "code": "app_license_not_written",
    }
    if TENANT_ID == ORG_ID:
        refused["code"] = "license_scope_collapsed"
        return refused
    private = None
    import_session = None
    read_session = None
    import_tenant = None
    import_org = None
    read_tenant = None
    read_org = None
    tenant_id_var = None
    org_id_var = None
    committed = False
    try:
        _refuse_bad_signatures_in_memory()
        from yuantus.meta_engine.app_framework.models import AppRegistry

        if AppRegistry.__table__.name != "meta_app_registry":
            raise FixtureRefusal("app_registry_registration_refused")
        from yuantus.context import org_id_var as imported_org
        from yuantus.context import tenant_id_var as imported_tenant
        from yuantus.meta_engine.app_framework.entitlement_service import EntitlementService
        from yuantus.meta_engine.app_framework.license_import_service import LicenseImportService
        from yuantus.meta_engine.app_framework.license_verification import canonical_payload_bytes
        from yuantus.meta_engine.app_framework.store_models import AppLicense

        tenant_id_var = imported_tenant
        org_id_var = imported_org
        private, public_keys = _ephemeral_keypair()
        signed = _license_object(private, _license_payload("w23fix-" + secrets.token_hex(16)), canonical_payload_bytes)
        private = None
        import_session = _business_session(TENANT_ID, ORG_ID)
        import_tenant = tenant_id_var.set(TENANT_ID)
        import_org = org_id_var.set(ORG_ID)
        result = LicenseImportService(import_session).import_license(signed, public_keys)
        signed = None
        public_keys = None
        if result.tenant_id != TENANT_ID or len(result.activated) != 1:
            raise FixtureRefusal("license_import_scope_refused")
        row_id = result.activated[0].id
        import_session.commit()
        committed = True
        tenant_id_var.reset(import_tenant)
        org_id_var.reset(import_org)
        import_tenant = None
        import_org = None
        import_session.close()
        import_session = None
        read_session = _business_session(TENANT_ID, ORG_ID)
        read_tenant = tenant_id_var.set(TENANT_ID)
        read_org = org_id_var.set(ORG_ID)
        found = (
            read_session.query(AppLicense)
            .filter(
                AppLicense.id == row_id,
                AppLicense.tenant_id == TENANT_ID,
                AppLicense.app_name == APP_LICENSE_NAME,
                AppLicense.status == "Active",
            )
            .one()
        )
        metadata = found.license_data if isinstance(found.license_data, dict) else {}
        features = list(metadata.get("features") or [])
        engine_verified = (
            metadata.get("kid") == FIXTURE_LICENSE_KID
            and isinstance(metadata.get("payload_hash"), str)
            and bool(metadata.get("payload_hash"))
            and FEATURE_KEY in features
            and found.tenant_id != ORG_ID
            and found.org_id != TENANT_ID
        )
        entitled = EntitlementService(read_session).is_entitled(FEATURE_KEY) is True
        return {
            "entitled": entitled,
            "app_license_written": True,
            "license_signature_verified": engine_verified,
            "provenance": provenance,
            "code": None if entitled and engine_verified else "app_license_not_entitled",
        }
    except FixtureRefusal:
        raise
    except Exception as exc:
        if import_session is not None and not committed:
            import_session.rollback()
        refused["app_license_written"] = committed
        refused["code"] = "app_license_not_entitled" if committed else "app_license_not_written"
        refused["error"] = _identifier_token(type(exc).__name__)
        return refused
    finally:
        private = None
        if import_tenant is not None and tenant_id_var is not None:
            tenant_id_var.reset(import_tenant)
        if import_org is not None and org_id_var is not None:
            org_id_var.reset(import_org)
        if read_tenant is not None and tenant_id_var is not None:
            tenant_id_var.reset(read_tenant)
        if read_org is not None and org_id_var is not None:
            org_id_var.reset(read_org)
        if import_session is not None:
            import_session.close()
        if read_session is not None:
            read_session.close()


def _receipt(actor: dict, business: dict, license_row: dict, planes: dict, route: dict) -> dict:
    gaps = list(business["gaps"])
    if license_row.get("code"):
        gaps.insert(0, _gap(str(license_row["code"]), str(license_row.get("error") or "")))
    verified = license_row.get("license_signature_verified") is True
    entitled = license_row["entitled"] is True
    item_release_id = business["item_id"] if business.get("assembly_edge_id") else None
    return {
        "schema_mode": SCHEMA_MODE,
        "tenancy_mode": TENANCY_MODE,
        "tenant_schema": TENANT_SCHEMA,
        "entitled": entitled,
        "app_license_written": license_row["app_license_written"] is True,
        "license_signature_verified": verified,
        "license_provenance": license_row.get("provenance"),
        "blocking_gap": None if verified and entitled else license_row.get("code"),
        "item_id": business["item_id"],
        "current_version_id": business["current_version_id"],
        "child_item_id": business["child_item_id"],
        "assembly_edge_id": business["assembly_edge_id"],
        "eco_id": business["eco_id"],
        "base_id": business["baseline_id"],
        "routing_id": business["routing_id"],
        "mbom_id": business["mbom_id"],
        "baseline_id": business["baseline_id"],
        "mbom_name": MBOM_NAME,
        "mbom_name_delta": DELTA_MBOM_NAME,
        "eco_name": ECO_NAME,
        "eco_name_delta": DELTA_ECO_NAME,
        "eco_description_delta": DELTA_ECO_DESCRIPTION,
        "resource_ids": {
            "mbom_release": business["mbom_id"],
            "routing_release": business["routing_id"],
            "baseline_release": business["baseline_id"],
            "item_release": item_release_id,
        },
        "auth_user_id": actor["auth_user_id"],
        "rbac_user_id": actor["rbac_user_id"],
        "rules": business["rules"],
        "gaps": gaps,
        "provenance": business.get("provenance") or [],
        "child_release_state": business.get("child_release_state"),
        "bom_edge_id": business.get("bom_edge_id"),
        "engine_planes": planes,
        "routing_witness": {
            "current_database": route["current_database"],
            "current_schema": route["current_schema"],
        },
    }


def seed(context: dict) -> dict:
    assert_admitted(context)
    planes = prove_owned_engines(context)["planes"]
    upgrade_schema(context)
    route = _observe_business_route(context)
    actor = _identity(context)
    business = _seed_business(actor)
    license_row = _write_app_license()
    receipt = _receipt(actor, business, license_row, planes, route)
    _write_private(Path(context["receipt_path"]), json.dumps(receipt, sort_keys=True))
    return {
        "status": "SEEDED",
        "entitled": receipt["entitled"],
        "app_license_written": receipt["app_license_written"],
        "license_signature_verified": receipt["license_signature_verified"],
        "blocking_gap": receipt["blocking_gap"],
        "schema_mode": SCHEMA_MODE,
        "gap_codes": [item.get("code") for item in receipt["gaps"]],
        "rule_count": len(receipt["rules"]),
        "routing_witness": receipt["routing_witness"],
    }


def descriptive_delta(context: dict) -> dict:
    """Rename the owned MBOM and the owned ECO name and description. No notify path is used."""
    assert_admitted(context)
    _prepare_import(context)
    from yuantus.meta_engine.bootstrap import import_all_models

    import_all_models()
    from yuantus.meta_engine.manufacturing.models import ManufacturingBOM
    from yuantus.meta_engine.models.eco import ECO

    receipt = json.loads(Path(context["receipt_path"]).read_text(encoding="utf-8"))
    mbom_id = receipt.get("mbom_id")
    eco_id = receipt.get("eco_id")
    if not isinstance(mbom_id, str) or not mbom_id:
        raise FixtureRefusal("descriptive_delta_no_mbom")
    if not isinstance(eco_id, str) or not eco_id:
        raise FixtureRefusal("descriptive_delta_no_eco")
    session = _business_session(TENANT_ID, ORG_ID)
    try:
        row = session.get(ManufacturingBOM, mbom_id)
        eco = session.get(ECO, eco_id)
        if row is None:
            raise FixtureRefusal("descriptive_delta_no_mbom")
        if eco is None:
            raise FixtureRefusal("descriptive_delta_no_eco")
        row.name = DELTA_MBOM_NAME
        eco.name = DELTA_ECO_NAME
        eco.description = DELTA_ECO_DESCRIPTION
        session.commit()
        stored = session.get(ManufacturingBOM, mbom_id)
        stored_eco = session.get(ECO, eco_id)
        if stored is None or stored.name != DELTA_MBOM_NAME:
            raise FixtureRefusal("descriptive_delta_not_stored")
        if (
            stored_eco is None
            or stored_eco.name != DELTA_ECO_NAME
            or stored_eco.description != DELTA_ECO_DESCRIPTION
        ):
            raise FixtureRefusal("descriptive_delta_not_stored")
    finally:
        session.close()
    return {
        "ok": True,
        "changed": "mbom_name_and_eco_name",
        "mbom_name": DELTA_MBOM_NAME,
        "eco_name": DELTA_ECO_NAME,
    }


def revoke_membership(context: dict) -> dict:
    """AuthService has no deactivate method. The login reads OrgMembership.is_active."""
    assert_admitted(context)
    _prepare_import(context)
    from yuantus.security.auth.database import get_identity_db_session
    from yuantus.security.auth.models import AuthUser, OrgMembership

    with get_identity_db_session() as identity_db:
        user = (
            identity_db.query(AuthUser)
            .filter(AuthUser.tenant_id == TENANT_ID, AuthUser.username == USERNAME)
            .one()
        )
        membership = (
            identity_db.query(OrgMembership)
            .filter(
                OrgMembership.tenant_id == TENANT_ID,
                OrgMembership.org_id == ORG_ID,
                OrgMembership.user_id == user.id,
            )
            .one()
        )
        membership.is_active = False
    return {"ok": True, "membership_active": False}


def restore_membership(context: dict) -> dict:
    """Existing add_membership sets is_active true. It does not mint a second user."""
    assert_admitted(context)
    _prepare_import(context)
    from yuantus.security.auth.database import get_identity_db_session
    from yuantus.security.auth.models import AuthUser
    from yuantus.security.auth.service import AuthService

    with get_identity_db_session() as identity_db:
        user = (
            identity_db.query(AuthUser)
            .filter(AuthUser.tenant_id == TENANT_ID, AuthUser.username == USERNAME)
            .one()
        )
        AuthService(identity_db).add_membership(
            tenant_id=TENANT_ID,
            org_id=ORG_ID,
            user_id=int(user.id),
            roles=["admin"],
        )
    return {"ok": True, "membership_active": True}


def _scheme_refusal(url: object) -> str:
    try:
        native_sqlalchemy_url(url)
    except FixtureRefusal as refusal:
        return refusal.reason
    return ""


def sqlalchemy_driver_report(proof: dict) -> dict:
    """Construct SQLAlchemy engines for admitted Native planes. Do not connect.

    Plain postgresql:// is the historical driver RED. This does not import Native.
    """
    from sqlalchemy import create_engine

    if any(name == "yuantus" or name.startswith("yuantus.") for name in sys.modules):
        raise FixtureRefusal("native_product_imported")
    databases = proof["databases"]
    plain = databases["global"]
    try:
        engine = create_engine(plain)
    except ModuleNotFoundError as exc:
        red = {
            "scheme": "postgresql",
            "created": False,
            "connected": False,
            "error": "ModuleNotFoundError",
            "message": str(exc),
        }
    else:
        engine.dispose()
        red = {"scheme": "postgresql", "created": True, "connected": False, "error": None, "message": ""}
    nonce = proof["nonce"]
    socket_path = proof["socket"]
    prefixes = {
        "global": PLANE_PREFIX["global"],
        "identity": PLANE_PREFIX["identity"],
        "tenant": PLANE_PREFIX["tenant"],
        "tenant_orm": PLANE_PREFIX["tenant"],
    }
    mapped: dict[str, dict] = {}
    for role in ("global", "identity", "tenant", "tenant_orm"):
        url = native_sqlalchemy_url(databases[role])
        engine = create_engine(url)
        try:
            query = list(engine.url.query.items())
            hosts = [value for key, value in query if key == "host"]
            ports = [value for key, value in query if key == "port"]
            options = [value for key, value in query if key == "options"]
            database = engine.url.database or ""
            mapped[role] = {
                "created": True,
                "connected": False,
                "checked_out": engine.pool.checkedout(),
                "checked_in": engine.pool.checkedin(),
                "driver": engine.dialect.driver,
                "drivername": str(engine.url.drivername),
                "username": engine.url.username,
                "password_set": engine.url.password is not None,
                "authority_host": engine.url.host,
                "nonce_matches": database == prefixes[role] + nonce,
                "query_host_matches_socket": hosts == [socket_path],
                "query_port": ports[0] if len(ports) == 1 else None,
                "host_count": len(hosts),
                "port_count": len(ports),
                "options": options[0] if len(options) == 1 else None,
                "option_count": len(options),
            }
        finally:
            engine.dispose()
    native_imported = any(name == "yuantus" or name.startswith("yuantus.") for name in sys.modules)
    return {
        "plain": red,
        "mapped": mapped,
        "native_product_imported": native_imported,
        "connections": False,
    }


def _driver_control_records(owned_proof: dict) -> tuple[list[tuple[str, bool]], dict]:
    import inspect

    databases = owned_proof["databases"]
    nonce = str(owned_proof["nonce"])
    socket_path = str(owned_proof["socket"])
    records: list[tuple[str, bool]] = []
    native_roles = ("global", "identity", "tenant", "tenant_orm")
    plain_roles = ("meta", "global", "identity", "tenant", "tenant_orm")
    records.append((
        "canonical_proof_stays_postgresql",
        owned_socket_refusal(owned_proof) is None
        and all(
            isinstance(databases[role], str)
            and databases[role].startswith("postgresql://")
            and "+" not in databases[role]
            and parse_owned_dsn(databases[role]) is None
            and owned_plane_refusal(databases[role]) is None
            for role in plain_roles
        ),
    ))
    mapped_urls: dict[str, str] = {}
    native_ok = True
    for role in native_roles:
        url = databases[role]
        if parse_owned_dsn(url) is not None or owned_plane_refusal(url) is not None:
            native_ok = False
            continue
        try:
            mapped = native_sqlalchemy_url(url)
        except FixtureRefusal:
            native_ok = False
            continue
        mapped_urls[role] = mapped
        if mapped != "postgresql+psycopg://" + url[len("postgresql://"):]:
            native_ok = False
        if "postgresql://" + mapped[len("postgresql+psycopg://"):] != url:
            native_ok = False
        if parse_owned_dsn(mapped) != "dsn_refused" or owned_plane_refusal(mapped) != "dsn_refused":
            native_ok = False
    records.append((
        "native_map_after_admission",
        native_ok and set(mapped_urls) == set(native_roles),
    ))
    meta = databases["meta"]
    records.append((
        "meta_url_stays_postgresql",
        meta == "postgresql://plm_test@localhost/w23meta" + nonce + "?host=" + socket_path + "&port=5432"
        and "+psycopg" not in meta
        and meta not in mapped_urls.values(),
    ))
    records.append((
        "tenant_orm_options_preserved",
        "tenant" in mapped_urls
        and mapped_urls.get("tenant_orm") == mapped_urls["tenant"] + "&options=-csearch_path%3D" + TENANT_SCHEMA,
    ))
    tail = "plm_test@localhost/w23glob" + nonce + "?host=" + socket_path + "&port=5432"
    records.append(("psycopg2_scheme_refused", _scheme_refusal("postgresql+psycopg2://" + tail) == "dsn_refused"))
    records.append(("asyncpg_scheme_refused", _scheme_refusal("postgresql+asyncpg://" + tail) == "dsn_refused"))
    records.append((
        "already_mapped_not_remapped",
        "global" in mapped_urls and _scheme_refusal(mapped_urls["global"]) == "dsn_refused",
    ))
    records.append((
        "password_userinfo_refused",
        _scheme_refusal("postgresql://plm_test:secret@localhost/w23glob" + nonce + "?host=" + socket_path + "&port=5432") == "dsn_refused",
    ))
    records.append(("duplicate_host_not_mapped", _scheme_refusal(databases["global"] + "&host=/tmp/other") == "dsn_refused"))
    records.append(("sqlite_not_mapped", _scheme_refusal("sqlite:///owned.db") == "sqlite_fallback_refused"))
    records.append(("empty_url_not_mapped", _scheme_refusal("") == "dsn_refused"))
    stored = dict(owned_proof)
    stored["databases"] = dict(databases)
    if "global" in mapped_urls:
        stored["databases"]["global"] = mapped_urls["global"]
    records.append(("stored_driver_url_refused", owned_socket_refusal(stored) == "owned_socket_refused"))
    try:
        report = sqlalchemy_driver_report(owned_proof)
        report_error = ""
    except Exception as exc:
        report = {"plain": {}, "mapped": {}, "native_product_imported": True, "connections": False}
        report_error = type(exc).__name__
    plain = report.get("plain") if isinstance(report.get("plain"), dict) else {}
    records.append((
        "plain_postgresql_driver_red",
        report_error == ""
        and plain.get("created") is False
        and plain.get("connected") is False
        and plain.get("error") == "ModuleNotFoundError"
        and plain.get("message") == "No module named 'psycopg2'",
    ))
    engine_ok = report_error == "" and report.get("native_product_imported") is False and report.get("connections") is False
    mapped_report = report.get("mapped") if isinstance(report.get("mapped"), dict) else {}
    if set(mapped_report) != {"global", "identity", "tenant", "tenant_orm"}:
        engine_ok = False
    for role, item in mapped_report.items():
        expect_options = "-csearch_path=" + TENANT_SCHEMA if role == "tenant_orm" else None
        if not (
            item.get("created") is True
            and item.get("connected") is False
            and item.get("checked_out") == 0
            and item.get("checked_in") == 0
            and item.get("driver") == DECLARED_PSYCOPG3_DRIVER
            and item.get("drivername") == NATIVE_SQLALCHEMY_SCHEME
            and item.get("username") == "plm_test"
            and item.get("password_set") is False
            and item.get("authority_host") == "localhost"
            and item.get("nonce_matches") is True
            and item.get("query_host_matches_socket") is True
            and item.get("query_port") == "5432"
            and item.get("host_count") == 1
            and item.get("port_count") == 1
            and item.get("option_count") == (1 if role == "tenant_orm" else 0)
            and item.get("options") == expect_options
        ):
            engine_ok = False
    records.append(("sqlalchemy_engines_psycopg3_without_connect", engine_ok))
    verify_source = Path(__file__).with_name("verify.py").read_text(encoding="utf-8")
    records.append((
        "coordinator_maps_native_env_only",
        verify_source.count('native_fixture.native_sqlalchemy_url(databases["global"])') == 1
        and verify_source.count('native_fixture.native_sqlalchemy_url(databases["identity"])') == 1
        and verify_source.count('native_fixture.owned_tenant_template(databases["tenant_orm"])') == 1
        and 'native_fixture.native_sqlalchemy_url(databases["tenant_orm"])' not in verify_source
        and 'native_fixture.native_sqlalchemy_url(databases["meta"])' not in verify_source
        and 'native_fixture.native_sqlalchemy_url(database_dsn("meta"))' not in verify_source
        and verify_source.count('"DATABASE_URL": database_dsn("meta")') == 2
        and verify_source.index("owned_socket_start") < verify_source.index(
            'native_fixture.native_sqlalchemy_url(databases["global"])'
        ),
    ))
    records.append((
        "run_mts_reviewed_sha256",
        hashlib.sha256(Path(__file__).with_name("run.mts").read_bytes()).hexdigest() == RUN_MTS_SHA256
        and RUN_MTS_SHA256 != R11_RUN_MTS_SHA256
        and R11_RUN_MTS_SHA256 == "2686de1808f350f6742e58abbc0e21b20c09de2b8b077a42efc1c4ef32a3e986",
    ))
    mapper = inspect.getsource(native_sqlalchemy_url)
    prefix_at = mapper.find("postgresql+psycopg://")
    records.append((
        "mapper_is_one_scheme",
        mapper.count("postgresql+psycopg://") == 1
        and prefix_at > mapper.find("parse_owned_dsn")
        and prefix_at > mapper.find("owned_plane_refusal")
        and "psycopg2" not in mapper
        and "asyncpg" not in mapper
        and "fallback" not in mapper
        and "meta_scheme_refused" not in mapper
        and "w23meta" not in mapper
        and "w23glob" not in mapper
        and "OWNED_SOCKET" not in mapper
        and "database_name" not in mapper,
    ))
    prepare = inspect.getsource(_prepare_import)
    alembic = inspect.getsource(_alembic)
    prove = inspect.getsource(prove_owned_engines)
    records.append((
        "alembic_and_orm_use_exact_map",
        prepare.count("native_sqlalchemy_url(") == 2
        and prepare.count("owned_tenant_template(") == 1
        and "native_sqlalchemy_url(url)" in alembic
        and "DATABASE_URL_TEMPLATE" not in alembic
        and "create_engine(probe)" in prove
        and "sqlalchemy_driver_refused" in prove
        and "owned_tenant_template(" in prove
        and "physical_target_refusal(" in prove
        and prove.index("physical_target_refusal(") < prove.index("engine.connect()"),
    ))
    records.append((
        "preimport_plane_check_preserved",
        "assert_admitted(context)" in prove
        and "owned_plane_refusal(url)" in prove
        and "_prepare_import(context)" in prove
        and prove.index("assert_admitted(context)") < prove.index("owned_plane_refusal(url)")
        and prove.index("owned_plane_refusal(url)") < prove.index("_prepare_import(context)")
        and prove.index("_prepare_import(context)") < prove.index("native_sqlalchemy_url("),
    ))
    upgrade = inspect.getsource(upgrade_schema)
    seed_source = inspect.getsource(seed)
    delta = inspect.getsource(descriptive_delta)
    revoke = inspect.getsource(revoke_membership)
    restore = inspect.getsource(restore_membership)
    records.append((
        "callers_map_after_assert_admitted",
        upgrade.index("assert_admitted(context)") < upgrade.index("_alembic(")
        and seed_source.index("assert_admitted(context)") < seed_source.index("prove_owned_engines(")
        and delta.index("assert_admitted(context)") < delta.index("_prepare_import(context)")
        and revoke.index("assert_admitted(context)") < revoke.index("_prepare_import(context)")
        and restore.index("assert_admitted(context)") < restore.index("_prepare_import(context)"),
    ))
    fixture_source = Path(__file__).read_text(encoding="utf-8")
    bare_meta = "native_sqlalchemy_url(" + 'databases["meta"]' + ")"
    context_meta = "native_sqlalchemy_url(" + 'context["databases"]["meta"]' + ")"
    records.append((
        "fixture_map_skips_meta",
        fixture_source.count(bare_meta) == 1
        and ("native_fixture." + bare_meta) in fixture_source
        and context_meta not in fixture_source,
    ))
    records.append((
        "nonempty_database_still_refused",
        "owned_database_not_empty" in prove and "int(count or 0) != 0" in prove,
    ))
    if report_error:
        report = dict(report)
        report["error"] = report_error
    return records, report


def self_check() -> dict:
    """Pure checks. No Native import, socket, or database."""
    checks = []

    def record(name: str, ok: bool) -> None:
        checks.append({"name": name, "ok": ok})

    record("ancestor_exact", MAIN_ANCESTOR == "3fd21e31cca358f1b1a80dd6365ec060cc23bc5e")
    record("ancestor_not_prefix_only", len(MAIN_ANCESTOR) == 40)
    record("override_refused", ancestor_override({"main_ancestor": MAIN_ANCESTOR}) == "ancestor_override_refused")
    record("rebased_field_refused", ancestor_override({"rebased_base": "3fd21e31cca358f1b1a80dd6365ec060cc23bc5e"}) == "ancestor_override_refused")
    record("schema_mode", SCHEMA_MODE == "alembic-upgrade-head" and "create_all" not in SCHEMA_MODE)
    record("three_alembic_configs", [step["ini"] for step in SCHEMA_PLAN] == ["alembic.ini", "alembic.identity.ini", "alembic_tenant.ini"])
    unwritten = license_not_written_here()
    record(
        "self_check_does_not_write_license",
        unwritten["entitled"] is False
        and unwritten["app_license_written"] is False
        and unwritten["license_signature_verified"] is False
        and unwritten["app_name"] == "plm.collaboration_source_read",
    )
    record(
        "delta_is_mbom_name",
        DELTA_MBOM_NAME == "W23 owned mbom delta"
        and DELTA_MBOM_NAME != MBOM_NAME
        and DELTA_ECO_NAME == "W23 owned eco delta"
        and DELTA_ECO_NAME != ECO_NAME
        and DELTA_ECO_NAME != DELTA_MBOM_NAME
        and DELTA_ECO_DESCRIPTION == "owned fixture eco descriptive delta",
    )
    record("sqlite_refused", owned_plane_refusal("sqlite:///yuantus_dev.db") == "sqlite_fallback_refused")
    record("memory_sqlite_refused", owned_plane_refusal("sqlite:///:memory:") == "sqlite_fallback_refused")
    suffix = "abc"
    owned_names = {"global": "w23glob" + suffix, "identity": "w23ident" + suffix, "tenant": PLANE_PREFIX["tenant"] + suffix}
    record("owned_nonce_shape", same_owned_nonce(owned_names) is True)
    record(
        "owned_nonce_mismatch",
        same_owned_nonce({"global": "w23glob" + suffix, "identity": "w23identxyz", "tenant": PLANE_PREFIX["tenant"] + suffix}) is False,
    )
    record(
        "legacy_tenant_prefix_refused",
        same_owned_nonce({"global": "w23glob" + suffix, "identity": "w23ident" + suffix, "tenant": "w23ten" + suffix}) is False,
    )
    record(
        "short_prefix_is_not_main",
        "3fd" != MAIN_ANCESTOR and "3fd21e31cca358f1b1a80dd6365ec060cc23bc5" != MAIN_ANCESTOR,
    )
    implemented = {
        "prove_owned_engines",
        "_ensure_item_type",
        "_insert_part",
        "_seed_item_acl",
        "_try_bom_edge",
        "_try_eco",
        "_write_app_license",
    }
    record("fixture_functions_present", implemented <= set(globals()))
    retired = {
        "item_type_part_absent_after_alembic",
        "mbom_child_edge_requires_released_part",
        "assembly_relationship_type_absent",
        "eco_create_notifies_when_stage_exists",
        "meta_register_does_not_write_user_orgs",
        "meta_permission_grant_requires_admin",
    }
    record("retired_refusal_codes_absent", retired.isdisjoint(item["code"] for item in static_family_gaps()))
    record("signature_gap_does_not_entitle", license_not_written_here()["entitled"] is False)
    record("memory_signature_controls", memory_signature_controls() == [])
    record("signature_gap_absent", "license_signature_unsupported" not in [item["code"] for item in static_family_gaps()])
    record("bare_signature_refused", signed_import_refusal(None) == "license_provenance_missing")
    record(
        "false_signature_refused",
        signed_import_refusal({"license_signature_verified": False}) == "license_signature_not_verified",
    )
    record(
        "true_without_provenance_refused",
        signed_import_refusal({
            "license_signature_verified": True,
            "entitled": True,
            "app_license_written": True,
        }) == "license_provenance_missing",
    )
    accepted = {
        "license_signature_verified": True,
        "entitled": True,
        "app_license_written": True,
        "license_provenance": owned_license_provenance(),
    }
    record("owned_signed_import_accepted", signed_import_refusal(accepted) is None)
    collapsed = dict(owned_license_provenance())
    collapsed["tenant_id"] = "same"
    collapsed["org_id"] = "same"
    record(
        "collapsed_scope_refused",
        signed_import_refusal(dict(accepted, license_provenance=collapsed)) == "license_scope_collapsed",
    )
    issued = dict(owned_license_provenance())
    issued["production_issuance"] = "ACCEPTED"
    record(
        "production_issuance_claim_refused",
        signed_import_refusal(dict(accepted, license_provenance=issued)) == "production_issuance_claim_refused",
    )
    secret_names = {"license_key", "signature", "private_key", "password", "token", "public_key"}
    record("provenance_has_no_secret", secret_names.isdisjoint(owned_license_provenance()))
    import inspect
    writer = inspect.getsource(_write_app_license)
    receipt_source = inspect.getsource(_receipt)
    seed_source = inspect.getsource(seed)
    record(
        "writer_source_calls_import_license",
        "LicenseImportService" in writer
        and "import_license" in writer
        and "canonical_payload_bytes" in writer
        and "session.add(row)" not in writer
        and "AppLicense(" not in writer
        and "YUANTUS_LICENSE_PUBLIC_KEYS" not in writer
        and "test_license_import" not in writer,
    )
    record(
        "receipt_reports_engine_flag",
        "SIGNATURE_GAP" not in receipt_source
        and "license_provenance" in receipt_source
        and '"license_signature_verified": False' not in receipt_source
        and '"license_signature_verified": False' not in seed_source,
    )
    record("self_check_does_not_call_import", ("LicenseImportService" + "(") not in inspect.getsource(self_check))
    owned_proof = _sample_owned_proof()
    record("owned_socket_exact_admitted", owned_socket_refusal(owned_proof) is None)
    nonce = owned_proof["nonce"]
    concrete = PLANE_PREFIX["tenant"] + nonce
    databases = owned_proof["databases"]
    mapped = native_sqlalchemy_url(databases["tenant_orm"])
    derived = owned_tenant_template(databases["tenant_orm"])
    current = derived.format(tenant_id=TENANT_ID, org_id=ORG_ID)
    sentinel = derived.format(tenant_id=TENANT_ID + "__other_scope", org_id=ORG_ID)
    record("r12_canonical_namespace", owned_proof["names"]["tenant"] == concrete and database_name(mapped) == concrete)
    record("r12_concrete_format", current == mapped and physical_target_refusal(current, sentinel, socket_path=owned_proof["socket"], nonce=nonce) is None)
    query_only = mapped + "&application_name={tenant_id}"
    record(
        "r12_old_fixed_and_query_only_rejected",
        physical_target_refusal(mapped, mapped, socket_path=owned_proof["socket"], nonce=nonce) == "physical_target_refused"
        and physical_target_refusal(
            query_only.format(tenant_id=TENANT_ID, org_id=ORG_ID),
            query_only.format(tenant_id=TENANT_ID + "__other_scope", org_id=ORG_ID),
            socket_path=owned_proof["socket"],
            nonce=nonce,
        ) == "physical_target_refused",
    )
    legacy_name = "w23ten" + nonce
    legacy_url = "postgresql://plm_test@localhost/" + legacy_name + "?host=" + owned_proof["socket"] + "&port=5432"
    legacy = dict(owned_proof, names=dict(owned_proof["names"], tenant=legacy_name), databases=dict(databases, tenant=legacy_url, tenant_orm=legacy_url + "&options=-csearch_path%3D" + TENANT_SCHEMA))
    legacy_refused = False
    try:
        owned_tenant_template(legacy["databases"]["tenant_orm"])
    except FixtureRefusal as refusal:
        legacy_refused = refusal.reason == "tenant_template_refused"
    mixed = dict(owned_proof, databases=dict(databases, tenant=databases["tenant"].replace("/" + concrete + "?", "/" + PLANE_PREFIX["tenant"] + "fedcba9876543210?", 1)))
    swapped = dict(
        owned_proof,
        names=dict(owned_proof["names"], tenant=owned_proof["names"]["global"]),
        databases=dict(databases, tenant=databases["global"], tenant_orm=databases["global"] + "&options=-csearch_path%3D" + TENANT_SCHEMA),
    )
    templated_orm = databases["tenant_orm"].replace("/" + concrete + "?", "/w23ten{tenant_id}" + nonce + "?", 1)
    templated = dict(owned_proof, databases=dict(databases, tenant_orm=templated_orm))
    record("r12_legacy_mixed_swap_template_refused", legacy_refused and owned_socket_refusal(legacy) == "owned_socket_refused" and owned_socket_refusal(mixed) == "owned_socket_refused" and owned_socket_refusal(swapped) == "owned_socket_refused" and "{tenant_id}" in templated_orm and owned_socket_refusal(templated) == "owned_socket_refused")
    record(
        "r12_route_witness",
        business_route_refusal(concrete, TENANT_SCHEMA, tenant_name=concrete) is None
        and business_route_refusal(legacy_name, TENANT_SCHEMA, tenant_name=concrete) == "business_route_refused"
        and business_route_refusal(concrete, "public", tenant_name=concrete) == "business_route_refused"
        and seed_source.index("upgrade_schema(") < seed_source.index("_observe_business_route(") < seed_source.index("_seed_business(")
        and "SELECT current_database(), current_schema()" in inspect.getsource(_observe_business_route)
        and "session.close()" in inspect.getsource(_observe_business_route),
    )
    lexical_foreign = "postgresql://plm_test@localhost/w23metaabc?host=/tmp/other/s&port=5432"
    prefix_only = dict(owned_proof)
    prefix_only["names"] = dict(owned_proof["names"])
    prefix_only["names"]["meta"] = "w23meta"
    record(
        "lexical_prefix_is_not_ownership",
        owned_plane_refusal(lexical_foreign) is None and owned_socket_refusal(prefix_only) == "owned_socket_refused",
    )
    second_host = owned_proof["databases"]["meta"] + "&host=/tmp/other"
    record("second_host_refused", parse_owned_dsn(second_host) == "dsn_refused")
    record("sqlite_dsn_refused", parse_owned_dsn("sqlite:///owned.db") == "sqlite_fallback_refused")
    foreign_socket = dict(owned_proof)
    foreign_socket["socket"] = "/tmp/other/s"
    record("foreign_socket_refused", owned_socket_refusal(foreign_socket) == "owned_socket_refused")
    symlink_marker = dict(owned_proof)
    symlink_marker["marker_is_symlink"] = True
    symlink_marker["marker_is_regular_file"] = False
    record("symlink_marker_refused", owned_socket_refusal(symlink_marker) == "owned_socket_refused")
    symlink_root = dict(owned_proof)
    symlink_root["root_is_symlink"] = True
    record("symlink_root_refused", owned_socket_refusal(symlink_root) == "owned_socket_refused")
    symlink_socket = dict(owned_proof)
    symlink_socket["socket_is_symlink"] = True
    record("symlink_socket_refused", owned_socket_refusal(symlink_socket) == "owned_socket_refused")
    root_realpath = dict(owned_proof)
    root_realpath["root_realpath"] = owned_proof["root"] + "-other"
    record("root_realpath_refused", owned_socket_refusal(root_realpath) == "owned_socket_refused")
    record("pinned_executable_missing", pinned_executable("/tmp/plm-w23-no-such-python") is None)
    record("pinned_executable_relative", pinned_executable("python") is None)
    mismatched_marker = dict(owned_proof)
    mismatched_marker["marker_body"] = {"nonce": "ffffffffffffffff", "kind": OWNED_SOCKET_KIND}
    record("marker_nonce_refused", owned_socket_refusal(mismatched_marker) == "owned_socket_refused")
    no_search_path = dict(owned_proof)
    no_search_path["databases"] = dict(owned_proof["databases"])
    no_search_path["databases"]["tenant_orm"] = owned_proof["databases"]["tenant"]
    record("tenant_orm_search_path_required", owned_socket_refusal(no_search_path) == "owned_socket_refused")
    record(
        "self_check_does_not_read_marker",
        ("_admit_owned" + "_socket(") not in inspect.getsource(self_check) and ("ls" + "tat") not in inspect.getsource(self_check),
    )
    try:
        seed({"services_admitted": False, "allow_spawn": False})
        record("unadmitted_seed_refused", False)
    except FixtureRefusal as refusal:
        record("unadmitted_seed_refused", refusal.reason == "services_not_admitted")
    driver_records, driver_probe = _driver_control_records(owned_proof)
    for name, ok in driver_records:
        record(name, ok)
    try:
        assert_admitted({
            "services_admitted": True,
            "allow_spawn": True,
            "commit": E3_PLANNING_COMMIT,
            "tree": "/tmp/does-not-exist",
            "python": sys.executable,
        })
        record("e3_refused_before_tree", False)
    except FixtureRefusal as refusal:
        record("e3_refused_before_tree", refusal.reason == "e3_planning_ref_refused")
    record("no_argv_executor", "argv_refusal" not in globals())
    failed = [item["name"] for item in checks if item["ok"] is not True]
    return {
        "status": "NOT_RUN" if not failed else "RED",
        "runtime": "NOT_RUN",
        "services_started": False,
        "http_executed": False,
        "profile_result": "NOT_RUN" if not failed else "RED",
        "failed_checks": failed,
        "checks": checks,
        "driver_probe": driver_probe,
        "gap_codes": [item["code"] for item in static_family_gaps()],
    }


def _emit(payload: dict, code: int) -> None:
    payload.setdefault("services_started", False)
    payload.setdefault("http_executed", False)
    payload.setdefault("profile_result", payload.get("status"))
    sys.stdout.write(json.dumps(payload, sort_keys=True) + "\n")
    raise SystemExit(code)


def _remove_created(path: str) -> None:
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
        return
    if os.path.isdir(path):
        import shutil
        shutil.rmtree(path)


def _fs_context(nonce: str, root: str) -> dict:
    proof = _sample_owned_proof(nonce)
    return {
        "owned_nonce": nonce,
        "owned_root": root,
        "owned_socket": root + "/s",
        "owned_marker": root + "/" + OWNED_SOCKET_MARKER,
        "names": proof["names"],
        "databases": proof["databases"],
        "secret_path": proof["secret_path"],
        "owned_path": proof["owned_path"],
        "receipt_path": proof["receipt_path"],
    }


def _write_marker(directory: str, nonce: str) -> None:
    Path(directory + "/" + OWNED_SOCKET_MARKER).write_text(
        json.dumps({"nonce": nonce, "kind": OWNED_SOCKET_KIND}),
        encoding="utf-8",
    )


def filesystem_owned_socket_check() -> dict:
    """Filesystem-only admission pair. No database import and no service start."""
    created: list[str] = []
    failed: list[str] = []

    def claim_dir(path: str) -> bool:
        if os.path.lexists(path):
            return False
        os.mkdir(path)
        created.append(path)
        return True

    try:
        nonce = secrets.token_hex(8)
        root = OWNED_SOCKET_PREFIX + nonce
        if not claim_dir(root) or not claim_dir(root + "/s"):
            failed.append("filesystem_positive")
        else:
            _write_marker(root, nonce)
            try:
                _admit_owned_socket(_fs_context(nonce, root))
            except FixtureRefusal:
                failed.append("filesystem_positive")
        link_nonce = secrets.token_hex(8)
        target = "/tmp/plm-w23-fs-target-" + link_nonce
        link_root = OWNED_SOCKET_PREFIX + link_nonce
        if not claim_dir(target) or not claim_dir(target + "/s"):
            failed.append("symlink_root_setup")
        else:
            _write_marker(target, link_nonce)
            if os.path.lexists(link_root):
                failed.append("symlink_root_setup")
            else:
                os.symlink(target, link_root)
                created.append(link_root)
                try:
                    _admit_owned_socket(_fs_context(link_nonce, link_root))
                    failed.append("symlink_root_admitted")
                except FixtureRefusal as refusal:
                    if refusal.reason != "owned_socket_refused":
                        failed.append("symlink_root_reason")
        socket_nonce = secrets.token_hex(8)
        socket_root = OWNED_SOCKET_PREFIX + socket_nonce
        socket_target = "/tmp/plm-w23-fs-socket-" + socket_nonce
        if not claim_dir(socket_root) or not claim_dir(socket_target):
            failed.append("symlink_socket_setup")
        elif os.path.lexists(socket_root + "/s"):
            failed.append("symlink_socket_setup")
        else:
            os.symlink(socket_target, socket_root + "/s")
            _write_marker(socket_root, socket_nonce)
            try:
                _admit_owned_socket(_fs_context(socket_nonce, socket_root))
                failed.append("symlink_socket_admitted")
            except FixtureRefusal as refusal:
                if refusal.reason != "owned_socket_refused":
                    failed.append("symlink_socket_reason")
    finally:
        for path in reversed(created):
            if os.path.lexists(path):
                _remove_created(path)
    clean = not failed
    return {
        "status": "NOT_RUN" if clean else "RED",
        "runtime": "NOT_RUN",
        "services_started": False,
        "http_executed": False,
        "profile_result": "NOT_RUN" if clean else "RED",
        "label": "filesystem-only",
        "database": False,
        "failed_checks": failed,
    }


def pinned_python_check(path: str) -> dict:
    """Admit one explicit interpreter path. Do not execute it and do not start a service."""
    failed: list[str] = []
    admitted = pinned_executable(path)
    if admitted != path or not os.path.islink(path):
        failed.append("venv_logical_path")
    else:
        resolved = os.path.realpath(path)
        if not os.path.isfile(resolved) or not os.access(resolved, os.X_OK):
            failed.append("venv_target")
    missing = "/tmp/plm-w23-missing-python-" + secrets.token_hex(8)
    if pinned_executable(missing) is not None:
        failed.append("missing_not_refused")
    dangling = "/tmp/plm-w23-dangling-python-" + secrets.token_hex(8)
    if os.path.lexists(dangling):
        failed.append("dangling_setup")
    else:
        os.symlink(missing, dangling)
        try:
            if pinned_executable(dangling) is not None:
                failed.append("dangling_not_refused")
        finally:
            if os.path.islink(dangling):
                os.remove(dangling)
    clean = not failed
    return {
        "status": "NOT_RUN" if clean else "RED",
        "runtime": "NOT_RUN",
        "services_started": False,
        "http_executed": False,
        "profile_result": "NOT_RUN" if clean else "RED",
        "label": "pinned-executable-file-only",
        "logical_path_kept": admitted == path,
        "executed": False,
        "failed_checks": failed,
    }


def main(argv: list[str]) -> None:
    if not argv or argv[0] in {"-h", "--help"}:
        sys.stdout.write(
            "usage: native_fixture.py [--help|self-check|fs-admission-check|pinned-python-check --path <file>|seed]\n"
            "self-check is private and starts nothing.\n"
            "fs-admission-check is filesystem-only. It admits one real owned root and refuses a symlink root and a symlink socket. It starts nothing.\n"
            "pinned-python-check admits one explicit executable path and refuses a missing path and a dangling link. It does not execute that path and starts nothing.\n"
            "seed without an admitted context file is NOT_RUN and starts nothing.\n"
            "schema mode is alembic-upgrade-head on alembic.ini, alembic.identity.ini, and alembic_tenant.ini.\n"
            "admitted seed proves the owned root, socket, and marker, then three empty postgres planes.\n"
            "After migrations the existing business session reads current_database and current_schema, then closes.\n"
            "admitted seed then inserts fixture rows.\n"
            "Owned records stay postgresql://. Native SQLAlchemy, Alembic, and ORM use the one map to postgresql+psycopg.\n"
            "The Meta pg URL stays postgresql://. No other driver is selected.\n"
            "admitted seed imports one signed fixture license through LicenseImportService.\n"
            "self-check does not write that row and does not call import_license.\n"
            "metadata.create_all is not acceptance.\n"
            "These commands are not an HTTP pass.\n"
        )
        raise SystemExit(0)
    if argv[0] == "self-check":
        payload = self_check()
        _emit(payload, 0 if not payload["failed_checks"] else 1)
    if argv[0] == "fs-admission-check":
        payload = filesystem_owned_socket_check()
        _emit(payload, 0 if not payload["failed_checks"] else 1)
    if argv[0] == "pinned-python-check":
        if argv[1:] != ["--path", argv[2]] if len(argv) == 3 else True:
            _emit({"status": "NOT_RUN", "runtime": "NOT_RUN", "reason": "pinned_path_required", "http_executed": False, "services_started": False}, 2)
        payload = pinned_python_check(argv[2])
        _emit(payload, 0 if not payload["failed_checks"] else 1)
    if argv[0] != "seed":
        _emit({"status": "NOT_RUN", "reason": "unknown_command"}, 2)
    if len(argv) == 1:
        try:
            seed({"services_admitted": False, "allow_spawn": False})
        except FixtureRefusal as refusal:
            _emit({"status": "NOT_RUN", "reason": refusal.reason, "runtime": "NOT_RUN"}, 2)
    if argv[1:] != ["--context", argv[2]] if len(argv) == 3 else True:
        _emit({"status": "NOT_RUN", "reason": "seed_context_required"}, 2)
    context_path = argv[2]
    if not context_path.startswith("/") or os.path.islink(context_path):
        _emit({"status": "NOT_RUN", "reason": "seed_context_refused"}, 2)
    try:
        context = json.loads(Path(context_path).read_text(encoding="utf-8"))
        public = seed(context)
    except FixtureRefusal as refusal:
        _emit({"status": "RED", "runtime": "RED", "reason": refusal.reason, "profile_result": "RED"}, 1)
    _emit(public, 0)


if __name__ == "__main__":
    main(sys.argv[1:])
