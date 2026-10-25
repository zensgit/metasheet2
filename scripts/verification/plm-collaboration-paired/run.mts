/**
 * Finite HTTP driver for the W23 paired profile.
 * Without an admission file this process exits NOT_RUN and does not call fetch.
 * It does not construct DataSourceManager, mint tokens, or report a fake HTTP pass.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const E3_PLANNING_COMMIT = "e3f44e5a8816b52f0e30be553c98fff7b344ab25";
const LOCAL_FIELDS = [
  ["collaboration_owner", "person"],
  ["followup_due_at", "dateTime"],
  ["review_note", "longText"],
] as const;
const READINESS_CELLS = [
  "item_id", "ruleset_id", "generated_at", "coverage_status", "resources_count",
  "ok_resources", "error_count", "warning_count", "resources",
];
const FAMILY_KINDS = [
  ["mbom_release", "mbom"],
  ["routing_release", "routing"],
  ["baseline_release", "baseline"],
  ["item_release", "item"],
] as const;
const JOURNAL_WINDOW_MS = 5000;
const JOURNAL_SCOPE = "collaboration_source_post_only";
const READINESS_COLLECTION_NAME = "w23-readiness";
const READINESS_RENAMED_NAME = "w23-readiness-renamed";
const READINESS_RECOVERY_NAME = "w23-readiness-recovery";
const OWNED_SOCKET_PREFIX = "/tmp/plm-managed-consumer-pg-";
const OWNED_SOCKET_MARKER = ".plm-managed-owned";
const OWNED_SOCKET_KIND = "plm-managed-companion-socket";
const RUNTIME_PREFIX = "/tmp/plm-w23-real-http-run-";
const ECO_CELLS = [
  "id", "name", "eco_type", "product_id", "source_version_id", "target_version_id",
  "stage_id", "state", "kanban_state", "priority", "updated_at",
] as const;
const META_ORG_ID = "w23http";
const META_OWNER_EMAIL = "w23-owner@w23http.localhost";
const META_DENIED_EMAIL = "w23-denied@w23http.localhost";
const META_ADMIN_ROLE = "admin";
const META_PERMISSIONS = [
  "data_sources:read",
  "data_sources:write",
  "data_sources:execute",
  "multitable:read",
  "multitable:write",
  "comments:read",
  "comments:write",
] as const;

interface Admission {
  ready: boolean;
  services_admitted: boolean;
  commit: string;
  phase: string;
  metaOrigin: string;
  nativeOrigin: string;
  secretPath: string;
  journalPath: string;
  statePath: string;
  fixtureReceiptPath: string;
  tlsCertificateRejected?: boolean;
  nativePid?: number;
}

interface SecretFile {
  meta?: { identifier: string; password: string };
  native: { tenant_id: string; org_id: string; username: string; password: string };
  denied_meta?: { identifier: string; password: string };
  meta_org_membership?: string;
  meta_seeded?: boolean;
}

interface LicenseProvenance {
  engine?: unknown;
  verifier?: unknown;
  direct_app_license_insert?: unknown;
  tenant_id?: unknown;
  org_id?: unknown;
  app_name?: unknown;
  features?: unknown;
  private_key_persisted?: unknown;
  key_lifetime?: unknown;
  production_issuance?: unknown;
  install_acceptance?: unknown;
}

interface Receipt {
  item_id?: string | null;
  current_version_id?: string | null;
  eco_id?: string | null;
  entitled?: boolean;
  app_license_written?: boolean;
  license_signature_verified?: boolean;
  license_provenance?: LicenseProvenance;
  blocking_gap?: string | null;
  mbom_name?: string;
  mbom_name_delta?: string;
  eco_name?: string;
  eco_name_delta?: string;
  resource_ids?: Record<string, string | null>;
}

interface ResourceIssue {
  code?: unknown;
  rule_id?: unknown;
}

interface ResourceRow {
  kind?: unknown;
  name?: unknown;
  resource_type?: unknown;
  resource_id?: unknown;
  errors?: ResourceIssue[];
  warnings?: ResourceIssue[];
}

interface StepNote {
  id: string;
  method: string;
  path: string;
  status: number;
  code: string | null;
  body_sha256: string;
}

class ProfileError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

const transcript: StepNote[] = [];
const journalNotes: Array<Record<string, unknown>> = [];
let httpExecuted = false;
let nativePid: number | null = null;

function emit(payload: Record<string, unknown>, code: number): never {
  payload.http_executed = httpExecuted;
  payload.transcript = transcript;
  payload.journal = journalNotes;
  payload.journal_scope = JOURNAL_SCOPE;
  if (!("profile_result" in payload)) payload.profile_result = payload.status;
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = /password|token|authorization|secret/i.test(key) ? "redacted" : redact(item);
  }
  return out;
}

function mode600(path: string): void {
  const stat = statSync(path);
  if ((stat.mode & 0o777) !== 0o600) throw new ProfileError("secret_mode_refused");
}

function readJson(path: string): unknown {
  mode600(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

function originOf(value: string, protocol: "http:" | "https:"): URL {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash) {
    throw new ProfileError("origin_refused");
  }
  return url;
}

async function requestRaw(id: string, method: string, url: URL, body: unknown, token: string | null, expect: number | readonly number[], extra?: Record<string, string>): Promise<{ status: number; parsed: unknown }> {
  httpExecuted = true;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  if (extra) Object.assign(headers, extra);
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const code = parsed && typeof parsed === "object" && "error" in parsed
    ? String((parsed as { error?: { code?: string } }).error?.code ?? "")
    : null;
  transcript.push({
    id, method, path: url.pathname + url.search, status: response.status, code: code || null,
    body_sha256: sha(JSON.stringify(redact(body ?? null))),
  });
  const cache = response.headers.get("cache-control");
  if (url.pathname.startsWith("/api/plm-collaboration-snapshots") && cache !== "no-store") {
    throw new ProfileError("cache_control_refused");
  }
  const allowed = typeof expect === "number" ? [expect] : expect;
  if (!allowed.includes(response.status)) throw new ProfileError("status_" + id + "_" + String(response.status));
  return { status: response.status, parsed };
}

async function request(id: string, method: string, url: URL, body: unknown, token: string | null, expect: number | readonly number[], extra?: Record<string, string>): Promise<unknown> {
  const result = await requestRaw(id, method, url, body, token, expect, extra);
  return result.parsed;
}

function dataOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || (payload as { ok?: boolean }).ok !== true) {
    throw new ProfileError("envelope_refused");
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") throw new ProfileError("data_missing");
  return data as Record<string, unknown>;
}

function journalLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((line) => line.includes("POST") && line.includes("/plm/collaboration-sources/") && !line.includes("/auth/login"));
}

function journalCount(path: string): number {
  return journalLines(path).length;
}

function sanitizeJournalLine(line: string): { path: string; status: string } {
  const quoted = line.match(/"(?:GET|POST|PUT|PATCH|DELETE) ([^" ?]+)/);
  const status = line.match(/" (\d{3}) /);
  return { path: quoted ? quoted[1] : "unparsed", status: status ? status[1] : "unknown" };
}

function rememberJournal(kind: string, path: string, before: number, after: number, startedAt: number): void {
  const finished = Date.now();
  journalNotes.push({
    scope: JOURNAL_SCOPE,
    excludes: ["auth_login"],
    kind,
    before,
    after,
    window_ms: JOURNAL_WINDOW_MS,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finished).toISOString(),
    elapsed_ms: finished - startedAt,
    native_pid: nativePid,
    source: "uvicorn",
    lines: journalLines(path).slice(-8).map(sanitizeJournalLine),
  });
}

async function journalPositive(path: string, previous: number, kind: string): Promise<number> {
  const started = Date.now();
  const deadline = started + JOURNAL_WINDOW_MS;
  let count = previous;
  while (Date.now() < deadline) {
    count = journalCount(path);
    if (count > previous) {
      rememberJournal(kind, path, previous, count, started);
      return count;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  rememberJournal(kind, path, previous, journalCount(path), started);
  throw new ProfileError("native_journal_missing_positive");
}

async function observeQuiet(path: string, previous: number, during: () => Promise<void>): Promise<void> {
  const started = Date.now();
  let settled = false;
  let actionError: unknown = null;
  const pending = during().then(
    () => { settled = true; },
    (error: unknown) => { settled = true; actionError = error; },
  );
  for (;;) {
    const count = journalCount(path);
    if (count !== previous) {
      rememberJournal("quiet_window_egress", path, previous, count, started);
      throw new ProfileError("native_egress_during_denial");
    }
    if (Date.now() - started >= JOURNAL_WINDOW_MS && settled) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await pending;
  if (actionError) throw actionError;
  if (Date.now() - started < JOURNAL_WINDOW_MS) throw new ProfileError("journal_window_short");
  const after = journalCount(path);
  if (after !== previous) {
    rememberJournal("quiet_window_egress", path, previous, after, started);
    throw new ProfileError("native_egress_during_denial");
  }
  rememberJournal("quiet_window", path, previous, after, started);
}

function requireString(value: unknown, reason: string): string {
  if (typeof value !== "string" || !value) throw new ProfileError(reason);
  return value;
}

function metaPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(24);
  let out = "W23h";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function metaPlaneRefusal(url: string): string | null {
  if (url.toLowerCase().includes("sqlite")) return "sqlite_fallback_refused";
  if (!url.startsWith("postgresql://plm_test@localhost/w23meta")) return "meta_dsn_refused";
  if (!url.includes("host=") || !url.includes("port=5432")) return "meta_dsn_refused";
  return null;
}

function databaseName(url: string): string {
  const path = url.split("@", 2)[1]?.split("/", 2)[1] ?? "";
  return path.split("?", 1)[0] ?? "";
}

function parseOwnedDsn(url: string): string | null {
  if (url.toLowerCase().includes("sqlite")) return "sqlite_fallback_refused";
  if (!url.startsWith("postgresql://plm_test@localhost/")) return "dsn_refused";
  const query = url.split("?", 2)[1] ?? "";
  const parts = query.split("&").filter((part) => part.length > 0);
  const hosts = parts.filter((part) => part.startsWith("host="));
  const ports = parts.filter((part) => part.startsWith("port="));
  if (hosts.length !== 1 || ports.length !== 1 || ports[0] !== "port=5432") return "dsn_refused";
  return null;
}

interface OwnedProof {
  nonce: string;
  root: string;
  socket: string;
  marker: string;
  root_is_symlink: boolean;
  socket_is_symlink: boolean;
  root_realpath: string;
  socket_realpath: string;
  marker_realpath: string;
  marker_is_regular_file: boolean;
  marker_is_symlink: boolean;
  marker_body: { nonce?: unknown; kind?: unknown };
  names: Record<string, string>;
  databases: Record<string, string>;
  secret_path: string;
  owned_path: string;
}

function ownedSocketRefusal(proof: OwnedProof): string | null {
  if (!/^[0-9a-f]{16}$/.test(proof.nonce)) return "owned_socket_refused";
  const root = OWNED_SOCKET_PREFIX + proof.nonce;
  const socket = root + "/s";
  const marker = root + "/" + OWNED_SOCKET_MARKER;
  if (proof.root !== root || proof.socket !== socket || proof.marker !== marker) return "owned_socket_refused";
  if (proof.root_is_symlink || proof.socket_is_symlink || proof.marker_is_symlink || proof.marker_is_regular_file !== true) {
    return "owned_socket_refused";
  }
  if (proof.root_realpath !== root || proof.socket_realpath !== socket || proof.marker_realpath !== marker) {
    return "owned_socket_refused";
  }
  const body = proof.marker_body;
  const bodyKeys = body ? Object.keys(body).sort().join(",") : "";
  if (bodyKeys !== "kind,nonce" || body.nonce !== proof.nonce || body.kind !== OWNED_SOCKET_KIND) return "owned_socket_refused";
  const names = {
    meta: "w23meta" + proof.nonce,
    global: "w23glob" + proof.nonce,
    identity: "w23ident" + proof.nonce,
    tenant: "w23tenw23http" + proof.nonce,
  };
  const nameKeys = Object.keys(proof.names).sort().join(",");
  if (nameKeys !== "global,identity,meta,tenant") return "owned_socket_refused";
  for (const key of Object.keys(names) as Array<keyof typeof names>) {
    if (proof.names[key] !== names[key]) return "owned_socket_refused";
  }
  const query = "host=" + socket + "&port=5432";
  const base = "postgresql://plm_test@localhost/";
  const expected: Record<string, string> = {
    meta: base + names.meta + "?" + query,
    global: base + names.global + "?" + query,
    identity: base + names.identity + "?" + query,
    tenant: base + names.tenant + "?" + query,
    tenant_orm: base + names.tenant + "?" + query + "&options=-csearch_path%3Dyt_t_w23http",
  };
  const databaseKeys = Object.keys(proof.databases).sort().join(",");
  if (databaseKeys !== "global,identity,meta,tenant,tenant_orm") return "owned_socket_refused";
  for (const [role, url] of Object.entries(expected)) {
    if (proof.databases[role] !== url) return "owned_socket_refused";
    const parsed = parseOwnedDsn(url);
    if (parsed) return parsed;
  }
  const runtime = RUNTIME_PREFIX + proof.nonce;
  if (proof.secret_path !== runtime + "/secret.json" || proof.owned_path !== runtime + "/owned-resource.json") {
    return "owned_socket_refused";
  }
  return null;
}

function sampleOwnedProof(nonce = "0123456789abcdef"): OwnedProof {
  const root = OWNED_SOCKET_PREFIX + nonce;
  const socket = root + "/s";
  const names = {
    meta: "w23meta" + nonce,
    global: "w23glob" + nonce,
    identity: "w23ident" + nonce,
    tenant: "w23tenw23http" + nonce,
  };
  const query = "host=" + socket + "&port=5432";
  const base = "postgresql://plm_test@localhost/";
  const runtime = RUNTIME_PREFIX + nonce;
  return {
    nonce,
    root,
    socket,
    marker: root + "/" + OWNED_SOCKET_MARKER,
    root_is_symlink: false,
    socket_is_symlink: false,
    root_realpath: root,
    socket_realpath: socket,
    marker_realpath: root + "/" + OWNED_SOCKET_MARKER,
    marker_is_regular_file: true,
    marker_is_symlink: false,
    marker_body: { nonce, kind: OWNED_SOCKET_KIND },
    names,
    databases: {
      meta: base + names.meta + "?" + query,
      global: base + names.global + "?" + query,
      identity: base + names.identity + "?" + query,
      tenant: base + names.tenant + "?" + query,
      tenant_orm: base + names.tenant + "?" + query + "&options=-csearch_path%3Dyt_t_w23http",
    },
    secret_path: runtime + "/secret.json",
    owned_path: runtime + "/owned-resource.json",
  };
}

function ownedLocationOk(lexical: string, kind: "dir" | "file"): boolean {
  if (!lexical.startsWith("/tmp/")) return false;
  try {
    const info = lstatSync(lexical);
    if (info.isSymbolicLink()) return false;
    if (kind === "dir" && !info.isDirectory()) return false;
    if (kind === "file" && !info.isFile()) return false;
    return realpathSync(lexical) === realpathSync("/tmp") + lexical.slice("/tmp".length);
  } catch {
    return false;
  }
}

function seedMetaPaths(argv: string[]): { secretPath: string; ownedPath: string; nonce: string } | null {
  if (argv.length !== 4 || argv[0] !== "--secret" || argv[2] !== "--owned") return null;
  const secretMatch = /^\/tmp\/plm-w23-real-http-run-([0-9a-f]{16})\/secret\.json$/.exec(argv[1] ?? "");
  const ownedMatch = /^\/tmp\/plm-w23-real-http-run-([0-9a-f]{16})\/owned-resource\.json$/.exec(argv[3] ?? "");
  if (!secretMatch || !ownedMatch || secretMatch[1] !== ownedMatch[1]) return null;
  return { secretPath: argv[1], ownedPath: argv[3], nonce: secretMatch[1] };
}

function writeSecret(path: string, value: SecretFile): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  mode600(path);
}

async function ensureMetaActors(_origin: URL, _secretPath: string, secret: SecretFile): Promise<SecretFile> {
  if (secret.meta_seeded !== true || !secret.meta || !secret.denied_meta) {
    throw new ProfileError("meta_fixture_not_seeded");
  }
  if (secret.meta_org_membership !== "user_orgs_row") throw new ProfileError("meta_org_membership_missing");
  return secret;
}

async function loginMeta(origin: URL, identifier: string, password: string): Promise<string> {
  const payload = await request("meta-login", "POST", new URL("/api/auth/login", origin), { identifier, password }, null, 200);
  const data = dataOf({ ok: (payload as { success?: boolean }).success === true, data: (payload as { data?: unknown }).data });
  const token = requireString(data.token, "meta_token_missing");
  const body = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof body.sid !== "string" || body.sid.trim().length < 8) throw new ProfileError("meta_sid_missing");
  return token;
}

async function seedMeta(argv: string[]): Promise<void> {
  const paths = seedMetaPaths(argv);
  if (!paths) {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "meta_secret_refused" }, 2);
  }
  const secretPath = paths.secretPath;
  let ownedRaw: unknown;
  try {
    ownedRaw = readJson(paths.ownedPath);
  } catch {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "owned_socket_refused" }, 2);
  }
  const owned = ownedRaw as Record<string, unknown>;
  const root = typeof owned.root === "string" ? owned.root : "";
  const socket = typeof owned.socket === "string" ? owned.socket : "";
  const marker = typeof owned.marker === "string" ? owned.marker : "";
  if (!ownedLocationOk(root, "dir") || !ownedLocationOk(socket, "dir") || !ownedLocationOk(marker, "file")) {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "owned_socket_refused" }, 2);
  }
  let markerBody: { nonce?: unknown; kind?: unknown };
  try {
    markerBody = JSON.parse(readFileSync(marker, "utf8")) as { nonce?: unknown; kind?: unknown };
  } catch {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "owned_socket_refused" }, 2);
  }
  const names = owned.names;
  const databases = owned.databases;
  if (!names || typeof names !== "object" || Array.isArray(names) || !databases || typeof databases !== "object" || Array.isArray(databases)) {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "owned_socket_refused" }, 2);
  }
  const ownedRefusal = ownedSocketRefusal({
    nonce: paths.nonce,
    root,
    socket,
    marker,
    root_is_symlink: false,
    socket_is_symlink: false,
    root_realpath: root,
    socket_realpath: socket,
    marker_realpath: marker,
    marker_is_regular_file: true,
    marker_is_symlink: false,
    marker_body: markerBody,
    names: names as Record<string, string>,
    databases: databases as Record<string, string>,
    secret_path: paths.secretPath,
    owned_path: paths.ownedPath,
  });
  if (ownedRefusal) emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: ownedRefusal }, 2);
  const configured = process.env.DATABASE_URL || "";
  if (configured !== (databases as Record<string, string>).meta) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_dsn_refused" }, 1);
  }
  const expectedName = databaseName(configured);
  try {
  const { query } = await import("../../../packages/core-backend/src/db/pg.ts");
  const seen = await query<{ name: string }>("SELECT current_database() AS name");
  const current = String(seen.rows[0]?.name || "");
  if (current !== expectedName || !current.startsWith("w23meta")) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_plane_mismatch" }, 1);
  }
  const users = await query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  const memberships = await query<{ n: number }>("SELECT count(*)::int AS n FROM user_orgs");
  if (Number(users.rows[0]?.n) !== 0 || Number(memberships.rows[0]?.n) !== 0) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_fixture_not_empty" }, 1);
  }
  const { authService } = await import("../../../packages/core-backend/src/auth/AuthService.ts");
  const { assignUserRoles } = await import("../../../packages/core-backend/src/rbac/role-assignment.ts");
  const ownerPassword = metaPassword();
  const deniedPassword = metaPassword();
  const owner = await authService.register(META_OWNER_EMAIL, ownerPassword, "W23 Owner");
  const denied = await authService.register(META_DENIED_EMAIL, deniedPassword, "W23 Denied");
  if (!owner?.id || !denied?.id) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_register_failed" }, 1);
  }
  const promoted = await query(
    "UPDATE users SET role = 'admin', is_admin = TRUE WHERE id = $1 RETURNING id, role, is_admin",
    [owner.id],
  );
  const promotedRow = promoted.rows[0] as { role?: string; is_admin?: boolean } | undefined;
  if (promotedRow?.role !== "admin" || promotedRow.is_admin !== true) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_admin_row_missing" }, 1);
  }
  await query(
    "INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [META_ADMIN_ROLE, "admin"],
  );
  await assignUserRoles({
    userIds: [owner.id],
    roleId: META_ADMIN_ROLE,
    scope: { kind: "platform-admin" },
  });
  const linked = await query(
    "SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2",
    [owner.id, META_ADMIN_ROLE],
  );
  if (linked.rows.length !== 1) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_role_not_linked" }, 1);
  }
  for (const code of META_PERMISSIONS) {
    await query(
      "INSERT INTO permissions (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING",
      [code, code],
    );
    await query(
      "INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [META_ADMIN_ROLE, code],
    );
    await query(
      "INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [owner.id, code],
    );
  }
  await query(
    "INSERT INTO user_orgs (user_id, org_id, is_active, created_at) VALUES ($1, $2, TRUE, NOW())",
    [owner.id, META_ORG_ID],
  );
  const membership = await query(
    "SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2",
    [owner.id, META_ORG_ID],
  );
  if (membership.rows.length !== 1) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_user_orgs_missing" }, 1);
  }
  const deniedOrg = await query("SELECT 1 FROM user_orgs WHERE user_id = $1", [denied.id]);
  if (deniedOrg.rows.length !== 0) {
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "denied_actor_received_org" }, 1);
  }
  const existing = readJson(secretPath) as SecretFile;
  writeSecret(secretPath, {
    ...existing,
    meta: { identifier: META_OWNER_EMAIL, password: ownerPassword },
    denied_meta: { identifier: META_DENIED_EMAIL, password: deniedPassword },
    meta_org_membership: "user_orgs_row",
    meta_seeded: true,
  });
  emit({
    status: "SEEDED",
    runtime: "SEEDED",
    profile_result: "NOT_RUN",
    http_executed: false,
    owner_id: owner.id,
    denied_id: denied.id,
    org_id: META_ORG_ID,
    role_id: META_ADMIN_ROLE,
    permission_codes: META_PERMISSIONS,
    user_orgs: true,
    sid: "issued_by_password_login_not_by_seed",
    acceptance: "fixture_rows_not_business_issuance",
  }, 0);
  } catch (error: unknown) {
    const pgCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    const name = error instanceof Error ? error.name : "Error";
    const reason = pgCode === "42703" ? "meta_admin_column_missing" : "meta_seed_" + name;
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason }, 1);
  }
}

function ownedLicenseProvenance(): LicenseProvenance {
  return {
    engine: "LicenseImportService.import_license",
    verifier: "license_verification.verify_license",
    direct_app_license_insert: false,
    tenant_id: "w23http",
    org_id: "w23org",
    app_name: "plm.collaboration_source_read",
    features: ["collaboration_source_read"],
    private_key_persisted: false,
    key_lifetime: "ephemeral_process_memory",
    production_issuance: "NOT_RUN",
    install_acceptance: "NOT_RUN",
  };
}

function signedImportRefusal(receipt: Receipt | null | undefined): string | null {
  if (!receipt || typeof receipt !== "object") return "license_provenance_missing";
  if (receipt.license_signature_verified !== true) return "license_signature_not_verified";
  const provenance = receipt.license_provenance;
  if (!provenance || typeof provenance !== "object") return "license_provenance_missing";
  if (provenance.engine !== "LicenseImportService.import_license") return "license_import_engine_missing";
  if (provenance.verifier !== "license_verification.verify_license") return "license_verifier_missing";
  if (provenance.direct_app_license_insert !== false) return "direct_app_license_insert_refused";
  if (provenance.tenant_id === provenance.org_id) return "license_scope_collapsed";
  if (provenance.tenant_id !== "w23http" || provenance.org_id !== "w23org") return "license_scope_refused";
  const features = provenance.features;
  if (
    provenance.app_name !== "plm.collaboration_source_read" ||
    !Array.isArray(features) || features.length !== 1 || features[0] !== "collaboration_source_read"
  ) return "license_feature_refused";
  if (provenance.private_key_persisted !== false || provenance.key_lifetime !== "ephemeral_process_memory") {
    return "license_key_lifetime_refused";
  }
  if (provenance.production_issuance !== "NOT_RUN" || provenance.install_acceptance !== "NOT_RUN") {
    return "production_issuance_claim_refused";
  }
  if (receipt.entitled !== true || receipt.app_license_written !== true) return "fixture_not_entitled";
  return null;
}

function sameFrozen(preview: Record<string, string>, binding: Record<string, string>): boolean {
  return preview.data_source_id === binding.data_source_id
    && preview.source_kind === binding.source_kind
    && preview.native_tenant_id === binding.native_tenant_id
    && preview.native_org_id === binding.native_org_id
    && preview.item_id === binding.item_id
    && preview.current_version_id === binding.current_version_id
    && preview.base_id === binding.base_id
    && preview.name === binding.name
    && preview.source_fingerprint === binding.source_fingerprint;
}

function restartVerdict(baseline: string, observed: string): "retained" | "selected_cells_changed" {
  return baseline === observed ? "retained" : "selected_cells_changed";
}

function activeGuard(status: string): "passed_this_guard" | "BINDING_NOT_ACTIVE" {
  return status === "active" ? "passed_this_guard" : "BINDING_NOT_ACTIVE";
}

function legacyRevokeAssertion(cellsSame: boolean, afterVersion: number, savedVersion: number): "retained" | "revoke_mutated_binding" {
  if (!cellsSame || afterVersion !== savedVersion) return "revoke_mutated_binding";
  return "retained";
}

function staleRevokeOracle(status: string, version: number, prior: number, canRefresh: boolean, cellsSame: boolean): "retained" | "revoke_not_stale" {
  if (status === "stale" && version === prior + 1 && canRefresh === false && cellsSame) return "retained";
  return "revoke_not_stale";
}

function selectorShape(key: unknown): "five_string" | "selector_invalid" {
  if (!Array.isArray(key) || key.length !== 5 || key.some((part) => typeof part !== "string")) return "selector_invalid";
  return "five_string";
}

function unknownRulesetShell(row: unknown, canRefresh: unknown): "empty_shell" | "not_shell" {
  return row === null && canRefresh === false ? "empty_shell" : "not_shell";
}

function observedTimeChange(before: string, after: string): "generated_time_changed" | "generated_time_unchanged" {
  return before !== after && before.length > 0 && after.length > 0 ? "generated_time_changed" : "generated_time_unchanged";
}

function casVerdict(before: number, after: number, canRefresh: boolean): "exact_increment" | "cas_not_exact" {
  return after === before + 1 && canRefresh === true ? "exact_increment" : "cas_not_exact";
}

function ecoBusinessVerdict(noop: boolean, version: number, prior: number, beforeHash: string, afterHash: string, canRefresh: boolean): "eco_business_changed" | "eco_business_not_observed" {
  if (!noop && version === prior + 1 && beforeHash !== afterHash && beforeHash.length > 0 && afterHash.length > 0 && canRefresh) {
    return "eco_business_changed";
  }
  return "eco_business_not_observed";
}

function priorAcceptedCas(sent: number, acceptedPrior: number, future: number): "prior_accepted_cas" | "not_prior_cas" {
  if (sent === acceptedPrior && future === acceptedPrior + 1 && sent !== future) return "prior_accepted_cas";
  return "not_prior_cas";
}

interface OwnedCounts {
  bindings: number;
  snapshot_rows: number;
  syncs: number;
  records: number;
  history: number;
  comments: number;
}

const QUIET_DELTA: OwnedCounts = { bindings: 0, snapshot_rows: 0, syncs: 0, records: 0, history: 0, comments: 0 };
const LOCAL_PATCH_DELTA: OwnedCounts = { bindings: 0, snapshot_rows: 0, syncs: 0, records: 0, history: 1, comments: 0 };
const COMMENT_DELTA: OwnedCounts = { bindings: 0, snapshot_rows: 0, syncs: 0, records: 0, history: 0, comments: 1 };
const APPEND_DELTA: OwnedCounts = { bindings: 0, snapshot_rows: 1, syncs: 1, records: 1, history: 0, comments: 0 };
const SOURCE_WRITE_DELTA: OwnedCounts = { bindings: 0, snapshot_rows: 0, syncs: 1, records: 0, history: 1, comments: 0 };
const ECO_CONFIRM_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 1, syncs: 1, records: 1, history: 1, comments: 0 };
const ECO_LOCAL_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 1, syncs: 1, records: 1, history: 2, comments: 0 };
const ECO_COMMENT_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 1, syncs: 1, records: 1, history: 2, comments: 1 };
const ECO_SOURCE_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 1, syncs: 2, records: 1, history: 3, comments: 1 };
const READY_CONFIRM_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 1, syncs: 1, records: 1, history: 1, comments: 0 };
const READY_APPEND_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 2, records: 2, history: 1, comments: 0 };
const READY_LOCAL_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 2, records: 2, history: 2, comments: 0 };
const READY_COMMENT_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 2, records: 2, history: 2, comments: 1 };
const READY_SOURCE_COUNTS: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 3, records: 2, history: 3, comments: 1 };
const OWNED_COUNT_SQL = [
  "SELECT",
  "(SELECT COUNT(*)::int FROM meta_plm_collaboration_bindings WHERE id = $1::uuid) AS bindings,",
  "(SELECT COUNT(*)::int FROM meta_plm_collaboration_rows WHERE binding_id = $1::uuid) AS snapshot_rows,",
  "(SELECT COUNT(*)::int FROM meta_plm_collaboration_syncs WHERE binding_id = $1::uuid) AS syncs,",
  "(SELECT COUNT(*)::int FROM meta_records WHERE sheet_id = $2) AS records,",
  "(SELECT COUNT(*)::int FROM meta_record_revisions WHERE sheet_id = $2 AND record_id = $3) AS history,",
  "(SELECT COUNT(*)::int FROM meta_comments WHERE spreadsheet_id = $2 AND row_id = $3) AS comments",
].join(" ");

function cardinalityVerdict(before: OwnedCounts, after: OwnedCounts, allowed: OwnedCounts): "retained" | "orphan_write" {
  const keys: Array<keyof OwnedCounts> = ["bindings", "snapshot_rows", "syncs", "records", "history", "comments"];
  for (const key of keys) {
    if (after[key] < before[key] || after[key] !== before[key] + allowed[key]) return "orphan_write";
  }
  return "retained";
}

function orphanDespiteIds(idsLookCorrect: boolean, verdict: "retained" | "orphan_write"): "red" | "kept" {
  if (verdict === "orphan_write") return "red";
  return idsLookCorrect ? "kept" : "red";
}

function countNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new ProfileError("cardinality_missing");
  return number;
}

async function readOwnedCounts(bindingId: string, sheetId: string, recordId: string): Promise<OwnedCounts> {
  const configured = process.env.DATABASE_URL || "";
  const ownedUrl = process.env.W23_OWNED_META_URL || "";
  if (!configured || configured !== ownedUrl || parseOwnedDsn(configured) !== null || !databaseName(configured).startsWith("w23meta")) {
    throw new ProfileError("cardinality_dsn_refused");
  }
  const lowered = OWNED_COUNT_SQL.toLowerCase();
  if (!lowered.startsWith("select ") || /\b(insert|update|delete|truncate|drop|alter)\b/.test(lowered)) {
    throw new ProfileError("cardinality_sql_refused");
  }
  const loaded = await import("../../../packages/core-backend/src/db/pg.ts") as { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  const seen = await loaded.query<OwnedCounts>(OWNED_COUNT_SQL, [bindingId, sheetId, recordId]);
  const row = seen.rows[0];
  if (!row) throw new ProfileError("cardinality_missing");
  return {
    bindings: countNumber(row.bindings),
    snapshot_rows: countNumber(row.snapshot_rows),
    syncs: countNumber(row.syncs),
    records: countNumber(row.records),
    history: countNumber(row.history),
    comments: countNumber(row.comments),
  };
}

function requireHealthyCarry(label: string, carried: unknown, healthy: OwnedCounts): OwnedCounts {
  if (!carried || typeof carried !== "object") throw new ProfileError(label + "_corrupted_carried_baseline");
  const row = carried as Record<string, unknown>;
  const parsed: OwnedCounts = {
    bindings: countNumber(row.bindings),
    snapshot_rows: countNumber(row.snapshot_rows),
    syncs: countNumber(row.syncs),
    records: countNumber(row.records),
    history: countNumber(row.history),
    comments: countNumber(row.comments),
  };
  if (cardinalityVerdict(healthy, parsed, QUIET_DELTA) !== "retained") {
    throw new ProfileError(label + "_corrupted_carried_baseline");
  }
  return parsed;
}

function readinessDeltaVerdict(noop: boolean, version: number, prior: number, hashChanged: boolean, timeChanged: boolean, canRefresh: boolean): "readiness_observed_change" | "readiness_change_missing" {
  if (!noop && version === prior + 1 && hashChanged && timeChanged && canRefresh) return "readiness_observed_change";
  return "readiness_change_missing";
}

function tenantRoutingAdmission(): string[] {
  const failed: string[] = [];
  const nonce = sampleOwnedProof().nonce;
  const concrete = "w23tenw23http" + nonce;
  const legacy = sampleOwnedProof();
  const legacyUrl = "postgresql://plm_test@localhost/w23ten" + nonce + "?host=" + legacy.socket + "&port=5432";
  legacy.names = { ...legacy.names, tenant: "w23ten" + nonce };
  legacy.databases = { ...legacy.databases, tenant: legacyUrl, tenant_orm: legacyUrl + "&options=-csearch_path%3Dyt_t_w23http" };
  if (ownedSocketRefusal(legacy) !== "owned_socket_refused") failed.push("r12_legacy_tenant_name");
  const mixed = sampleOwnedProof();
  mixed.databases = {
    ...mixed.databases,
    tenant: mixed.databases.tenant.replace("/" + concrete + "?", "/w23tenw23httpfedcba9876543210?"),
  };
  if (ownedSocketRefusal(mixed) !== "owned_socket_refused") failed.push("r12_mixed_nonce");
  const swapped = sampleOwnedProof();
  swapped.names = { ...swapped.names, tenant: swapped.names.global };
  swapped.databases = {
    ...swapped.databases,
    tenant: swapped.databases.global,
    tenant_orm: swapped.databases.global + "&options=-csearch_path%3Dyt_t_w23http",
  };
  if (ownedSocketRefusal(swapped) !== "owned_socket_refused") failed.push("r12_role_swap");
  const templated = sampleOwnedProof();
  templated.databases = {
    ...templated.databases,
    tenant_orm: templated.databases.tenant_orm.replace("/" + concrete + "?", "/w23ten{tenant_id}" + nonce + "?"),
  };
  if (!templated.databases.tenant_orm.includes("{tenant_id}") || ownedSocketRefusal(templated) !== "owned_socket_refused") {
    failed.push("r12_template_in_descriptor");
  }
  return failed;
}

function metaSelfCheck(): void {
  const failed: string[] = [];
  for (const name of tenantRoutingAdmission()) failed.push(name);
  if (metaPlaneRefusal("sqlite:///meta.db") !== "sqlite_fallback_refused") failed.push("sqlite");
  if (metaPlaneRefusal("postgresql://plm_test@localhost/metasheet") !== "meta_dsn_refused") failed.push("foreign_name");
  const lexical = "postgresql://plm_test@localhost/w23metaabc?host=/tmp/sock&port=5432";
  if (metaPlaneRefusal(lexical) !== null || databaseName(lexical) !== "w23metaabc") failed.push("lexical_shape");
  const ownedProof = sampleOwnedProof();
  if (ownedSocketRefusal(ownedProof) !== null) failed.push("owned_socket_exact");
  const prefixOnly = sampleOwnedProof();
  prefixOnly.names = { ...prefixOnly.names, meta: "w23meta" };
  if (ownedSocketRefusal(prefixOnly) !== "owned_socket_refused") failed.push("prefix_only_name");
  if (parseOwnedDsn(ownedProof.databases.meta + "&host=/tmp/other") !== "dsn_refused") failed.push("second_host");
  const foreignSocket = sampleOwnedProof();
  foreignSocket.socket = "/tmp/other/s";
  if (ownedSocketRefusal(foreignSocket) !== "owned_socket_refused") failed.push("foreign_socket");
  const symlinkMarker = sampleOwnedProof();
  symlinkMarker.marker_is_symlink = true;
  symlinkMarker.marker_is_regular_file = false;
  if (ownedSocketRefusal(symlinkMarker) !== "owned_socket_refused") failed.push("symlink_marker");
  if (seedMetaPaths([]) !== null || seedMetaPaths(["--secret", "/tmp/not-owned/secret.json"]) !== null) failed.push("bad_secret");
  const prefixSecret = "/tmp/plm-w23-real-http-run-" + ownedProof.nonce + "/secret.json";
  if (seedMetaPaths(["--secret", prefixSecret]) !== null) failed.push("secret_without_owned");
  if (seedMetaPaths(["--secret", prefixSecret, "--owned", ownedProof.owned_path])?.nonce !== ownedProof.nonce) {
    failed.push("owned_secret_pair");
  }
  if (META_PERMISSIONS.length !== 7) failed.push("permission_count");
  const frozen = {
    data_source_id: "ds", source_kind: "readiness", native_tenant_id: "w23http", native_org_id: "w23org",
    item_id: "item", current_version_id: "version", base_id: "base", source_fingerprint: "finger",
  };
  frozen.name = READINESS_COLLECTION_NAME;
  if (sameFrozen(frozen, frozen) !== true) failed.push("O1.equal_frozen_name.positive");
  if (sameFrozen(frozen, { ...frozen, name: READINESS_RENAMED_NAME }) !== false) failed.push("O1.renamed_target.negative");
  const historicalSecond = "w23-readiness-" + "second";
  if (sameFrozen(frozen, { ...frozen, name: historicalSecond }) !== false) failed.push("O1.R3_second_preview_name.negative");
  if (sameFrozen(frozen, { ...frozen, item_id: "other-item" }) !== false) failed.push("O1.other_frozen_coordinate.negative");
  const prewrite = { item_id: "item", ruleset_id: "default", generated_at: "t0" };
  const postwrite = { ...prewrite, collaboration_owner: "owner", followup_due_at: "due", review_note: "note" };
  const mutatedLocal = { ...postwrite, review_note: "changed" };
  const preHash = cellDigest({ cells: prewrite });
  const postHash = cellDigest({ cells: postwrite });
  const mutatedHash = cellDigest({ cells: mutatedLocal });
  if (restartVerdict(preHash, preHash) !== "retained") failed.push("O2.unchanged_prewrite.positive");
  if (restartVerdict(preHash, postHash) !== "selected_cells_changed") failed.push("O2.R3_prewrite_baseline_after_locals.negative");
  if (restartVerdict(postHash, postHash) !== "retained") failed.push("O2.coherent_postwrite_baseline.positive");
  if (restartVerdict(postHash, mutatedHash) !== "selected_cells_changed") failed.push("O2.changed_local_against_postwrite.negative");
  const dropped = { ...postwrite } as Record<string, string>;
  delete dropped.collaboration_owner;
  delete dropped.followup_due_at;
  delete dropped.review_note;
  if (cellDigest({ cells: dropped }) !== preHash) failed.push("O2.drop_locals_mutant");
  if (restartVerdict(postHash, preHash) !== "selected_cells_changed") failed.push("O2.prewrite_not_accepted");
  if (activeGuard("active") !== "passed_this_guard") failed.push("O3.active_guard.positive");
  if (activeGuard("stale") !== "BINDING_NOT_ACTIVE") failed.push("O3.stale_guard.negative");
  if (activeGuard("disabled") !== "BINDING_NOT_ACTIVE") failed.push("O3.disabled_guard.negative");
  if (legacyRevokeAssertion(true, 3, 3) !== "retained") failed.push("O3.R3_same_version_assertion.control");
  if (legacyRevokeAssertion(true, 4, 3) !== "revoke_mutated_binding") failed.push("O3.R3_assertion_given_SQL_declared_version_plus_one.negative");
  if (staleRevokeOracle("stale", 4, 3, false, true) !== "retained") failed.push("O3.stale_oracle.positive");
  if (staleRevokeOracle("active", 3, 3, true, true) !== "revoke_not_stale") failed.push("O3.still_active_same_version.negative");
  const driverSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const collectionUses = driverSource.split("name: READINESS_" + "COLLECTION_NAME").length - 1;
  if (collectionUses !== 2) failed.push("O1.one_collection_name");
  if (driverSource.includes("w23-readiness-" + "default") || driverSource.includes("w23-readiness-" + "second")) {
    failed.push("O1.split_names_present");
  }
  if (JOURNAL_SCOPE !== "collaboration_source_post_only" || JOURNAL_WINDOW_MS !== 5000) failed.push("O6.journal_scope");
  const commentA = [{ id: "c1", content: "note", targetId: "r1", containerId: "s1" }];
  const commentB = [{ id: "c1", content: "other", targetId: "r1", containerId: "s1" }];
  if (commentDigest(commentA) === commentDigest(commentB)) failed.push("O6.comment_content");
  const historyA = [{ id: "h1", recordId: "r1", version: 1, action: "update", source: "api", changedFieldIds: ["f"], patch: { f: "a" } }];
  const historyB = [{ id: "h1", recordId: "r1", version: 1, action: "update", source: "api", changedFieldIds: ["f"], patch: { f: "b" } }];
  if (historyDigest(historyA) === historyDigest(historyB)) failed.push("O6.history_patch");
  const defaultKey = ["ds", "w23http", "w23org", "item", "default"];
  const readinessKey = ["ds", "w23http", "w23org", "item", "readiness"];
  if (selectorShape(defaultKey) !== "five_string" || selectorShape(readinessKey) !== "five_string") failed.push("O5.five_key");
  if (JSON.stringify(defaultKey) === JSON.stringify(readinessKey)) failed.push("O5.distinct_five_keys");
  if (selectorShape(defaultKey.slice(0, 4)) !== "selector_invalid") failed.push("O5.four_key");
  const nonString = [...defaultKey.slice(0, 4), 1];
  if (selectorShape(nonString) !== "selector_invalid") failed.push("O5.non_string");
  const foreignItem = [...defaultKey];
  foreignItem[3] = foreignItem[3] + "-foreign";
  if (foreignItem[3] === defaultKey[3]) failed.push("O5.foreign_item");
  const unknown = [...defaultKey];
  unknown[4] = "w23-unknown-ruleset";
  if (selectorShape(unknown) !== "five_string" || unknownRulesetShell(null, false) !== "empty_shell") failed.push("O5.unknown_ruleset");
  if (unknownRulesetShell({}, false) !== "not_shell") failed.push("O5.unknown_ruleset_row");
  if (observedTimeChange("2026-10-24T00:00:00.000Z", "2026-10-24T00:00:00.000Z") !== "generated_time_unchanged") {
    failed.push("O6.same_generated_time");
  }
  if (observedTimeChange("2026-10-24T00:00:00.000Z", "2026-10-24T00:00:01.000Z") !== "generated_time_changed") {
    failed.push("O6.observed_generated_time");
  }
  if (casVerdict(2, 3, true) !== "exact_increment" || casVerdict(2, 4, true) !== "cas_not_exact") failed.push("O6.exact_cas");
  if (capturedVersion(null) !== null || capturedVersion("ver-1") !== "ver-1") failed.push("A1.identity");
  let missingVersion = false;
  try { capturedVersion(undefined); } catch { missingVersion = true; }
  if (!missingVersion) failed.push("A1.missing_not_null");
  if (sameVersionAnchor(null, null) !== true || sameVersionAnchor("ver-1", "ver-1") !== true) failed.push("A1.equal");
  if (sameVersionAnchor(null, "null") !== false || sameVersionAnchor("ver-1", "ver-2") !== false) failed.push("A1.negative");
  if (
    driverSource.includes("String(" + "null)")
    || /String\(version\)/.test(driverSource)
    || /String\(state\.version\)/.test(driverSource)
  ) failed.push("A1.stringified_anchor");
  const quietBase: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 3, records: 4, history: 5, comments: 6 };
  const quietSame: OwnedCounts = { bindings: 1, snapshot_rows: 2, syncs: 3, records: 4, history: 5, comments: 6 };
  if (cardinalityVerdict(quietBase, quietSame, QUIET_DELTA) !== "retained") failed.push("A2.quiet");
  if (cardinalityVerdict(quietBase, { ...quietSame, syncs: 4 }, QUIET_DELTA) !== "orphan_write") failed.push("A2.extra_sync");
  if (cardinalityVerdict(quietBase, { ...quietSame, records: 5 }, QUIET_DELTA) !== "orphan_write") failed.push("A2.extra_record");
  if (cardinalityVerdict(quietBase, { ...quietSame, syncs: 4, history: 6 }, SOURCE_WRITE_DELTA) !== "retained") failed.push("A2.source_write");
  if (cardinalityVerdict(quietBase, { ...quietSame, syncs: 5, history: 6 }, SOURCE_WRITE_DELTA) !== "orphan_write") failed.push("A2.orphan_on_write");
  if (cardinalityVerdict(quietBase, { ...quietSame, history: 4 }, QUIET_DELTA) !== "orphan_write") failed.push("A2.decrease");
  if (orphanDespiteIds(true, "orphan_write") !== "red") failed.push("A2.ids_do_not_excuse_orphan");
  const healthyVectors = [
    ECO_CONFIRM_COUNTS, ECO_LOCAL_COUNTS, ECO_COMMENT_COUNTS, ECO_SOURCE_COUNTS,
    READY_CONFIRM_COUNTS, READY_APPEND_COUNTS, READY_LOCAL_COUNTS, READY_COMMENT_COUNTS, READY_SOURCE_COUNTS,
  ];
  if (healthyVectors.some((vector) => cardinalityVerdict(vector, vector, QUIET_DELTA) !== "retained")) failed.push("A3.healthy_vectors");
  const ecoExtraSync = { ...ECO_CONFIRM_COUNTS, syncs: 2 };
  const extraSyncVerdict = cardinalityVerdict(ECO_CONFIRM_COUNTS, ecoExtraSync, QUIET_DELTA);
  if (extraSyncVerdict !== "orphan_write" || orphanDespiteIds(true, extraSyncVerdict) !== "red") failed.push("A3.first_confirm_extra_sync");
  if (cardinalityVerdict(READY_CONFIRM_COUNTS, READY_APPEND_COUNTS, APPEND_DELTA) !== "retained") failed.push("A3.readiness_append");
  const appendOrphan = { ...READY_APPEND_COUNTS, records: 3 };
  const appendOrphanVerdict = cardinalityVerdict(READY_APPEND_COUNTS, appendOrphan, QUIET_DELTA);
  if (appendOrphanVerdict !== "orphan_write" || orphanDespiteIds(true, appendOrphanVerdict) !== "red") failed.push("A3.append_orphan_record");
  const wrongRows = { ...READY_APPEND_COUNTS, snapshot_rows: 3 };
  const missedRows = { ...READY_APPEND_COUNTS, snapshot_rows: 1 };
  const wrongRowsVerdict = cardinalityVerdict(READY_APPEND_COUNTS, wrongRows, QUIET_DELTA);
  const missedRowsVerdict = cardinalityVerdict(READY_APPEND_COUNTS, missedRows, QUIET_DELTA);
  if (wrongRowsVerdict !== "orphan_write" || missedRowsVerdict !== "orphan_write" || orphanDespiteIds(true, wrongRowsVerdict) !== "red") {
    failed.push("A3.wrong_snapshot_rows");
  }
  if (cardinalityVerdict(ECO_CONFIRM_COUNTS, ECO_LOCAL_COUNTS, LOCAL_PATCH_DELTA) !== "retained") failed.push("A3.eco_local_history_only");
  if (cardinalityVerdict(ECO_CONFIRM_COUNTS, { ...ECO_LOCAL_COUNTS, syncs: 2 }, LOCAL_PATCH_DELTA) !== "orphan_write") failed.push("A3.eco_local_extra_sync");
  if (cardinalityVerdict(ECO_LOCAL_COUNTS, ECO_LOCAL_COUNTS, COMMENT_DELTA) !== "orphan_write") failed.push("A3.eco_comment_vacuous");
  if (cardinalityVerdict(ECO_LOCAL_COUNTS, ECO_COMMENT_COUNTS, COMMENT_DELTA) !== "retained") failed.push("A3.eco_comment_only");
  if (cardinalityVerdict(READY_APPEND_COUNTS, READY_LOCAL_COUNTS, LOCAL_PATCH_DELTA) !== "retained") failed.push("A3.readiness_local_history_only");
  if (cardinalityVerdict(READY_LOCAL_COUNTS, READY_COMMENT_COUNTS, COMMENT_DELTA) !== "retained") failed.push("A3.readiness_comment_only");
  if (cardinalityVerdict(ECO_COMMENT_COUNTS, ECO_SOURCE_COUNTS, SOURCE_WRITE_DELTA) !== "retained") failed.push("A3.eco_source_after_locals");
  if (cardinalityVerdict(READY_COMMENT_COUNTS, READY_SOURCE_COUNTS, SOURCE_WRITE_DELTA) !== "retained") failed.push("A3.readiness_source");
  if (cardinalityVerdict(READY_SOURCE_COUNTS, READY_SOURCE_COUNTS, QUIET_DELTA) !== "retained") failed.push("A3.replay_quiet");
  const replayExtra = cardinalityVerdict(READY_SOURCE_COUNTS, { ...READY_SOURCE_COUNTS, syncs: 4 }, QUIET_DELTA);
  if (replayExtra !== "orphan_write" || orphanDespiteIds(true, replayExtra) !== "red") failed.push("A3.replay_extra_sync");
  const corruptCarry = { ...ECO_COMMENT_COUNTS, syncs: 2 };
  if (cardinalityVerdict(corruptCarry, corruptCarry, QUIET_DELTA) !== "retained") failed.push("A3.corrupt_self_quiet");
  let corruptRejected = false;
  try { requireHealthyCarry("pure", corruptCarry, ECO_COMMENT_COUNTS); } catch { corruptRejected = true; }
  if (!corruptRejected || orphanDespiteIds(true, "orphan_write") !== "red") failed.push("A3.corrupted_carried_baseline");
  let healthyCarried = false;
  try { healthyCarried = cardinalityVerdict(requireHealthyCarry("pure", ECO_COMMENT_COUNTS, ECO_COMMENT_COUNTS), ECO_COMMENT_COUNTS, QUIET_DELTA) === "retained"; } catch { healthyCarried = false; }
  if (!healthyCarried) failed.push("A3.healthy_carried");
  const ecoLocalIds = { collaboration_owner: "owner", followup_due_at: "due", review_note: "note" };
  let vacuousLocals = false;
  try { assertLocals({ owner: null, due: null, note: null }, ecoLocalIds, "user", "2026-10-24T00:00:00.000Z", "w23 owned eco note"); } catch { vacuousLocals = true; }
  if (!vacuousLocals) failed.push("A3.vacuous_eco_locals");
  let populatedLocals = true;
  try {
    assertLocals(
      { owner: ["user"], due: "2026-10-24T00:00:00.000Z", note: "w23 owned eco note" },
      ecoLocalIds,
      "user",
      "2026-10-24T00:00:00.000Z",
      "w23 owned eco note",
    );
  } catch { populatedLocals = false; }
  if (!populatedLocals) failed.push("A3.populated_eco_locals");
  const ecoSourceCells = Object.fromEntries(ECO_CELLS.map((name) => [name, name === "id" ? "eco" : name]));
  const ecoSnapshotBefore = {
    status: "active", version: 1, canRefresh: true,
    row: { rowKey: ["ds", "tenant", "org", "eco"], recordId: "rec", capturedAt: "t0", businessHash: "source-hash", cells: ecoSourceCells },
  };
  const ecoSnapshotAfter = {
    ...ecoSnapshotBefore,
    row: { ...ecoSnapshotBefore.row, cells: { ...ecoSourceCells, collaboration_owner: ["user"], followup_due_at: "due", review_note: "note" } },
  };
  let ecoLocalSnapshotAccepted = true;
  try { assertEcoLocalSnapshotHeld(ecoSnapshotBefore, ecoSnapshotAfter, "user", "due", "note"); } catch { ecoLocalSnapshotAccepted = false; }
  if (!ecoLocalSnapshotAccepted || cellDigest(ecoSnapshotBefore.row) === cellDigest(ecoSnapshotAfter.row)) failed.push("A4.eco_local_only_projection");
  const ecoSnapshotMutants = [
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, cells: { ...ecoSnapshotAfter.row.cells, name: "mutated" } } },
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, businessHash: "mutated" } },
    { ...ecoSnapshotAfter, version: 2 },
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, capturedAt: "t1" } },
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, rowKey: ["ds", "tenant", "org", "other"] } },
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, recordId: "other" } },
    { ...ecoSnapshotAfter, canRefresh: false },
    { ...ecoSnapshotAfter, status: "stale" },
    { ...ecoSnapshotAfter, row: { ...ecoSnapshotAfter.row, cells: ecoSourceCells } },
  ];
  for (const [index, mutant] of ecoSnapshotMutants.entries()) {
    let refused = false;
    try { assertEcoLocalSnapshotHeld(ecoSnapshotBefore, mutant, "user", "due", "note"); } catch { refused = true; }
    if (!refused) failed.push("A4.eco_snapshot_mutant_" + index);
  }
  const ecoSavedCells = cellDigest(ecoSnapshotAfter.row);
  const ecoReloadedSnapshot = JSON.parse(JSON.stringify(ecoSnapshotAfter)) as typeof ecoSnapshotAfter;
  if (restartVerdict(ecoSavedCells, cellDigest(ecoReloadedSnapshot.row)) !== "retained") failed.push("A4.eco_postlocal_restart");
  if (restartVerdict(ecoSavedCells, cellDigest(ecoSnapshotBefore.row)) !== "selected_cells_changed") failed.push("A4.eco_wiped_locals");
  if (commentDigest([]) === commentDigest([{ id: "c-eco", content: "w23 owned eco note", targetId: "rec", containerId: "sheet" }])) {
    failed.push("A3.eco_comment_digest");
  }
  const ecoHistoryBefore = [{ id: "h1", recordId: "rec", version: 1, action: "create", source: "plm", changedFieldIds: [], patch: {} }];
  const ecoHistoryAfter = ecoHistoryBefore.concat([{ id: "h2", recordId: "rec", version: 2, action: "update", source: "api", changedFieldIds: ["note"], patch: { note: "w23 owned eco note" } }]);
  if (historyDigest(ecoHistoryBefore) === historyDigest(ecoHistoryAfter)) failed.push("A3.eco_history_digest");
  if (driverSource.includes(", null, " + "QUIET_DELTA") || driverSource.includes("OwnedCounts | " + "null")) failed.push("A3.null_baseline");
  const countSql = OWNED_COUNT_SQL.toLowerCase();
  if (!countSql.startsWith("select ") || /\b(insert|update|delete|truncate|drop|alter)\b/.test(countSql)) failed.push("A2.sql_not_readonly");
  if (metaSelfCheck.toString().includes("readOwned" + "Counts(")) failed.push("A2.self_check_queried");
  if (ecoBusinessVerdict(false, 4, 3, "old", "new", true) !== "eco_business_changed") failed.push("O7.eco_business");
  if (ecoBusinessVerdict(true, 3, 3, "hash", "hash", true) !== "eco_business_not_observed") failed.push("O7.mbom_only_noop");
  if (priorAcceptedCas(3, 3, 4) !== "prior_accepted_cas") failed.push("O7.prior_cas");
  if (priorAcceptedCas(4, 3, 4) !== "not_prior_cas") failed.push("O7.future_cas");
  if (readinessDeltaVerdict(false, 4, 3, true, true, true) !== "readiness_observed_change") failed.push("O7.readiness_change");
  const ecoSteps = ['"eco-get"', '"eco-reload"', '"eco-noop"', '"eco-stale-cas"', "eco_business_changed", "prior_accepted_cas"];
  if (ecoSteps.some((step) => !driverSource.includes(step))) failed.push("O7.eco_steps_missing");
  const bannedEco = ["ECO" + "Service", "create" + "_eco", "/" + "approve", "/" + "apply", "/" + "notify"];
  if (bannedEco.some((needle) => driverSource.includes(needle))) failed.push("O7.eco_mutation_present");
  const releaseNeedle = "/" + "release";
  const readinessNeedle = "/" + "release-readiness";
  if (driverSource.split(releaseNeedle).length !== driverSource.split(readinessNeedle).length) failed.push("O7.eco_release_present");
  const selfSource = metaSelfCheck.toString();
  if (selfSource.includes("ls" + "tatSync") || selfSource.includes("imp" + "ort(")) failed.push("self_check_touched_runtime");
  if (signedImportRefusal(undefined) !== "license_provenance_missing") failed.push("bare_signature");
  if (signedImportRefusal({ license_signature_verified: false }) !== "license_signature_not_verified") {
    failed.push("false_signature");
  }
  if (signedImportRefusal({
    license_signature_verified: true,
    entitled: true,
    app_license_written: true,
  }) !== "license_provenance_missing") failed.push("true_without_provenance");
  const accepted: Receipt = {
    license_signature_verified: true,
    entitled: true,
    app_license_written: true,
    license_provenance: ownedLicenseProvenance(),
  };
  if (signedImportRefusal(accepted) !== null) failed.push("owned_signed_import");
  const collapsed = ownedLicenseProvenance();
  collapsed.tenant_id = "same";
  collapsed.org_id = "same";
  if (signedImportRefusal({ ...accepted, license_provenance: collapsed }) !== "license_scope_collapsed") {
    failed.push("collapsed_scope");
  }
  const issued = ownedLicenseProvenance();
  issued.production_issuance = "ACCEPTED";
  if (signedImportRefusal({ ...accepted, license_provenance: issued }) !== "production_issuance_claim_refused") {
    failed.push("production_issuance");
  }
  emit({
    seed_meta_writes_native_license: false,
    status: failed.length === 0 ? "NOT_RUN" : "RED",
    runtime: "NOT_RUN",
    profile_result: failed.length === 0 ? "NOT_RUN" : "RED",
    http_executed: false,
    failed_checks: failed,
  }, failed.length === 0 ? 0 : 1);
}

async function loginNative(origin: URL, secret: SecretFile["native"], id = "native-login", expect: number | readonly number[] = 200): Promise<{ token: string | null; userId: string | null; status: number }> {
  const allowed = typeof expect === "number" ? [expect] : expect;
  const result = await requestRaw(id, "POST", new URL("/api/v1/auth/login", origin), {
    tenant_id: secret.tenant_id, org_id: secret.org_id, username: secret.username, password: secret.password,
  }, null, allowed);
  const payload = result.parsed as { access_token?: unknown; user_id?: unknown } | null;
  const token = payload && typeof payload.access_token === "string" ? payload.access_token : null;
  if (allowed.length === 1 && allowed[0] === 200) {
    const normal = requireString(token, "native_token_missing");
    const body = JSON.parse(Buffer.from(normal.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if ("typ" in body || "aud" in body) throw new ProfileError("native_token_not_normal_login");
    return { token: normal, userId: String(payload?.user_id ?? ""), status: result.status };
  }
  if (result.status === 200 || result.status === 409) throw new ProfileError("revoked_login_not_denied");
  return { token: null, userId: null, status: result.status };
}

async function nativeSource(origin: URL, token: string, item: string, kind: "eco-context" | "release-readiness", body: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
  const path = "/api/v1/plm/collaboration-sources/items/" + encodeURIComponent(item) + "/" + kind;
  const payload = await request(id, "POST", new URL(path, origin), body, token, 200) as Record<string, unknown>;
  if (payload.entitled !== true || !payload.source) throw new ProfileError("native_not_entitled_" + id);
  return payload;
}

function stateLoad(path: string): Record<string, unknown> {
  return readJson(path) as Record<string, unknown>;
}

function stateSave(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

function codeOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  const code = (payload as { error?: { code?: unknown } }).error?.code;
  return typeof code === "string" ? code : null;
}

async function expectCode(id: string, method: string, url: URL, body: unknown, token: string, status: number, code: string): Promise<void> {
  const payload = await request(id, method, url, body, token, status);
  if (codeOf(payload) !== code) throw new ProfileError("code_" + id);
}

function snapshotUrl(origin: URL, bindingId: string, rowKey?: string): URL {
  const url = new URL("/api/plm-collaboration-snapshots/" + bindingId, origin);
  if (rowKey !== undefined) url.searchParams.set("rowKey", rowKey);
  return url;
}

async function confirmCreate(origin: URL, token: string, previewId: string, id: string): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const created = dataOf(await request(id, "POST", new URL("/api/plm-collaboration-snapshots/confirm", origin), {
    previewId, requestId, expectedVersion: 0,
  }, token, 200));
  created.requestId = requestId;
  return created;
}

function fieldWalk(context: unknown): { fields: Map<string, { id: string; type: string }>; sourceFieldIds: string[] } {
  const fields = new Map<string, { id: string; type: string }>();
  const sourceFieldIds: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const rec = value as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "";
    const id = typeof rec.id === "string" ? rec.id : "";
    const type = typeof rec.type === "string" ? rec.type : "";
    if (id && LOCAL_FIELDS.some(([local]) => local === name)) fields.set(name, { id, type });
    const property = rec.property;
    if (property && typeof property === "object" && !Array.isArray(property)) {
      const marker = (property as Record<string, unknown>).plmCollaborationSnapshot;
      if (marker && typeof marker === "object" && (marker as { source?: unknown }).source === true && id) sourceFieldIds.push(id);
    }
    if (rec.plmCollaborationSnapshot && typeof rec.plmCollaborationSnapshot === "object") {
      const keys = Object.keys(rec.plmCollaborationSnapshot as Record<string, unknown>).sort();
      if (keys.includes("bindingId") || keys.includes("sourceKind")) {
        if (keys.join(",") !== "bindingId,sourceKind") throw new ProfileError("hint_boundary");
      }
    }
    Object.values(rec).forEach(visit);
  };
  visit(context);
  return { fields, sourceFieldIds };
}

function collaborationFieldContract(fieldsPayload: unknown, sourceKind: "eco" | "readiness"): { fields: Map<string, { id: string; type: string }>; sourceFieldIds: string[] } {
  if (!fieldsPayload || typeof fieldsPayload !== "object" || Array.isArray(fieldsPayload)
    || !Object.prototype.hasOwnProperty.call(fieldsPayload, "data")) throw new ProfileError("field_contract_envelope");
  const data = dataOf(fieldsPayload);
  if (Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, "fields") || !Array.isArray(data.fields)) throw new ProfileError("field_contract_array");
  const sourceNames: readonly string[] = sourceKind === "eco" ? ECO_CELLS : READINESS_CELLS;
  if (data.fields.length !== sourceNames.length + LOCAL_FIELDS.length) throw new ProfileError("field_contract_size");
  const fields = new Map<string, { id: string; type: string }>();
  const sourceFieldIds: string[] = [];
  const ids = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const descriptor of data.fields) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new ProfileError("field_contract_descriptor");
    const rec = descriptor as Record<string, unknown>;
    for (const key of ["id", "name", "type"] as const) {
      if (!Object.prototype.hasOwnProperty.call(rec, key) || typeof rec[key] !== "string" || !(rec[key] as string).trim()) throw new ProfileError("field_contract_identity");
    }
    const id = rec.id as string;
    const name = rec.name as string;
    if (ids.has(id)) throw new ProfileError("field_contract_duplicate_id");
    ids.add(id);
    const property = rec.property;
    if (!property || typeof property !== "object" || Array.isArray(property)) throw new ProfileError("field_contract_property");
    const props = property as Record<string, unknown>;
    const marker = props.plmCollaborationSnapshot as Record<string, unknown> | undefined;
    const local = LOCAL_FIELDS.find(([localName]) => localName === name);
    if (local) {
      if (fields.has(name) || rec.type !== local[1] || props.readOnly === true || props.readonly === true || marker?.source === true) throw new ProfileError("field_contract_local");
      fields.set(name, { id, type: rec.type as string });
    } else {
      if (!sourceNames.includes(name) || sourceKeys.has(name) || rec.type !== "string" || props.readOnly !== true
        || (Object.prototype.hasOwnProperty.call(props, "readonly") && props.readonly !== true)
        || !marker || typeof marker !== "object" || Array.isArray(marker)
        || Object.keys(marker).sort().join(",") !== "key,source" || marker.source !== true || marker.key !== name) throw new ProfileError("field_contract_source");
      sourceKeys.add(name);
      sourceFieldIds.push(id);
    }
  }
  if (fields.size !== LOCAL_FIELDS.length || sourceKeys.size !== sourceNames.length) throw new ProfileError("field_contract_missing");
  return { fields, sourceFieldIds };
}

function recordUrl(origin: URL, recordId: string, sheetId: string): URL {
  const url = new URL("/api/multitable/records/" + recordId, origin);
  url.searchParams.set("sheetId", sheetId);
  return url;
}

function commentListUrl(origin: URL, sheetId: string, recordId: string): URL {
  const url = new URL("/api/comments", origin);
  url.searchParams.set("containerId", sheetId);
  url.searchParams.set("targetId", recordId);
  return url;
}

function historyUrl(origin: URL, sheetId: string, recordId: string): URL {
  return new URL("/api/multitable/sheets/" + sheetId + "/records/" + recordId + "/history", origin);
}

function parseResources(value: unknown): ResourceRow[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new ProfileError("resources_not_array");
  return parsed as ResourceRow[];
}

function ruleIdsOf(resources: ResourceRow[]): string[] {
  const ids: string[] = [];
  for (const resource of resources) {
    for (const issue of [...(resource.errors ?? []), ...(resource.warnings ?? [])]) {
      if (typeof issue.rule_id === "string" && issue.rule_id) ids.push(issue.rule_id);
    }
  }
  return ids;
}

function assertFamilies(resources: ResourceRow[], receipt: Receipt, mbomName: string): string[] {
  const ids = receipt.resource_ids;
  if (!ids) throw new ProfileError("fixture_resource_ids_missing");
  for (const [kind, resourceType] of FAMILY_KINDS) {
    const matches = resources.filter((item) => item.kind === kind);
    if (matches.length !== 1) throw new ProfileError("resource_family_missing_" + kind);
    const resource = matches[0];
    if (resource.resource_type !== resourceType) throw new ProfileError("resource_type_" + kind);
    const expected = ids[kind];
    if (typeof expected !== "string" || !expected || resource.resource_id !== expected) {
      throw new ProfileError("resource_id_" + kind);
    }
    if (kind === "mbom_release" && resource.name !== mbomName) throw new ProfileError("mbom_name_projection");
  }
  return ruleIdsOf(resources);
}

function resourcesFromNative(payload: Record<string, unknown>): ResourceRow[] {
  const readiness = payload.readiness as { resources?: unknown } | undefined;
  if (!readiness) throw new ProfileError("native_resources_missing");
  return parseResources(readiness.resources);
}

function resourcesFromRow(row: Record<string, unknown>): ResourceRow[] {
  assertReadinessCells(row);
  const cells = row.cells as Record<string, unknown>;
  return parseResources(cells.resources);
}

function assertReadinessCells(row: Record<string, unknown>): void {
  const cells = row.cells as Record<string, unknown> | undefined;
  for (const cell of READINESS_CELLS) {
    if (!cells || typeof cells[cell] !== "string") throw new ProfileError("readiness_cell_missing_" + cell);
  }
  if (!cells || cells.coverage_status !== "bounded_not_proven_complete") throw new ProfileError("coverage_status");
}

function assertLocals(data: Record<string, unknown>, ids: Record<string, string>, metaUser: string, due: string, note: string): void {
  const owner = data[ids.collaboration_owner];
  if (!Array.isArray(owner) || owner.length !== 1 || owner[0] !== metaUser) throw new ProfileError("local_owner_not_retained");
  if (data[ids.followup_due_at] !== due) throw new ProfileError("local_due_not_retained");
  if (data[ids.review_note] !== note) throw new ProfileError("local_note_not_retained");
}

function commentDigest(items: unknown): string {
  if (!Array.isArray(items)) throw new ProfileError("comments_missing");
  const rows = items.map((item) => {
    if (!item || typeof item !== "object") return null;
    const row = item as { id?: unknown; content?: unknown; targetId?: unknown; containerId?: unknown };
    return {
      id: row.id ?? null,
      content: row.content ?? null,
      targetId: row.targetId ?? null,
      containerId: row.containerId ?? null,
    };
  });
  return sha(JSON.stringify(rows));
}

function historyDigest(items: unknown): string {
  if (!Array.isArray(items)) throw new ProfileError("history_missing");
  const rows = items.map((item) => {
    if (!item || typeof item !== "object") return null;
    const row = item as {
      id?: unknown; recordId?: unknown; version?: unknown; action?: unknown; source?: unknown;
      changedFieldIds?: unknown; patch?: unknown;
    };
    return {
      id: row.id ?? null,
      recordId: row.recordId ?? null,
      version: row.version ?? null,
      action: row.action ?? null,
      source: row.source ?? null,
      changedFieldIds: row.changedFieldIds ?? null,
      patch: row.patch ?? null,
    };
  });
  return sha(JSON.stringify(rows));
}

function sourceDigest(data: Record<string, unknown>, fieldIds: unknown): string {
  if (!Array.isArray(fieldIds)) throw new ProfileError("source_fields_missing");
  const values: Record<string, unknown> = {};
  for (const id of fieldIds) {
    if (typeof id !== "string" || !id) throw new ProfileError("source_fields_missing");
    values[id] = data[id] ?? null;
  }
  return sha(JSON.stringify(values));
}

function cellDigest(row: unknown): string {
  if (!row || typeof row !== "object") throw new ProfileError("row_missing");
  return sha(JSON.stringify((row as { cells?: unknown }).cells ?? null));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readinessKeyOf(dataSourceId: string, secret: SecretFile["native"], itemId: string, rulesetId: string): string[] {
  return [dataSourceId, secret.tenant_id, secret.org_id, itemId, rulesetId];
}

function ecoKeyOf(dataSourceId: string, secret: SecretFile["native"], ecoId: string): string[] {
  return [dataSourceId, secret.tenant_id, secret.org_id, ecoId];
}

function snapshotMeta(data: Record<string, unknown>): Record<string, unknown> {
  const row = data.row && typeof data.row === "object" ? data.row as Record<string, unknown> : {};
  return {
    status: data.status ?? null,
    version: data.version ?? null,
    canRefresh: data.canRefresh === true,
    capturedAt: row.capturedAt ?? null,
    businessHash: row.businessHash ?? null,
    rowKey: row.rowKey ?? null,
    recordId: row.recordId ?? null,
  };
}

function assertMetaHeld(id: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  if (!sameJson(before, after)) throw new ProfileError(id);
}

function assertEcoLocalSnapshotHeld(before: Record<string, unknown>, after: Record<string, unknown>, metaUser: string, due: string, note: string): void {
  assertMetaHeld("eco_locals_changed_snapshot", snapshotMeta(before), snapshotMeta(after));
  const beforeCells = (before.row as Record<string, unknown>).cells as Record<string, unknown>;
  const afterCells = (after.row as Record<string, unknown>).cells as Record<string, unknown>;
  if (sourceDigest(afterCells, ECO_CELLS) !== sourceDigest(beforeCells, ECO_CELLS)) {
    throw new ProfileError("eco_locals_changed_source_snapshot");
  }
  assertLocals(afterCells, Object.fromEntries(LOCAL_FIELDS.map(([name]) => [name, name])), metaUser, due, note);
}

function generatedAt(row: Record<string, unknown>): string {
  const cells = row.cells as Record<string, unknown> | undefined;
  const value = cells?.generated_at;
  if (typeof value !== "string" || !value) throw new ProfileError("generated_at_missing");
  return value;
}

function capturedVersion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw new ProfileError("version_anchor_invalid");
}

function sameVersionAnchor(actual: unknown, expected: string | null): boolean {
  return actual === expected;
}

function fieldIds(fields: Map<string, { id: string; type: string }>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name] of LOCAL_FIELDS) {
    const field = fields.get(name);
    if (!field) throw new ProfileError("eco_locals_missing");
    ids[name] = field.id;
  }
  return ids;
}

function localValues(data: Record<string, unknown>, ids: Record<string, string>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name] of LOCAL_FIELDS) values[name] = data[ids[name]] ?? null;
  return values;
}

function historyIds(items: unknown): string[] {
  if (!Array.isArray(items)) throw new ProfileError("history_missing");
  return items.map((item) => {
    if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") throw new ProfileError("history_missing");
    return (item as { id: string }).id;
  });
}

function historyRetained(before: string[], after: string[]): boolean {
  const present = new Set(after);
  return before.every((id) => present.has(id));
}

function commentTotal(payload: Record<string, unknown>): number {
  if (typeof payload.total !== "number" || !Number.isInteger(payload.total) || payload.total < 0) {
    throw new ProfileError("comment_total_missing");
  }
  return payload.total;
}

function assertReadinessIdentity(data: Record<string, unknown>, expectedKey: string[], itemId: string, versionId: string | null, rulesetId: string): Record<string, unknown> {
  const anchor = data.anchor as Record<string, unknown> | undefined;
  if (!anchor || anchor.itemId !== itemId || !sameVersionAnchor(anchor.currentVersionId, versionId)) throw new ProfileError("anchor_mismatch");
  if (!data.row || typeof data.row !== "object") throw new ProfileError("selected_row_missing");
  const row = data.row as Record<string, unknown>;
  if (!sameJson(row.rowKey, expectedKey) || expectedKey.length !== 5 || expectedKey.some((part) => typeof part !== "string")) {
    throw new ProfileError("row_key_mismatch");
  }
  const cells = row.cells as Record<string, unknown> | undefined;
  if (!cells || cells.item_id !== itemId || cells.ruleset_id !== rulesetId) throw new ProfileError("ruleset_identity");
  return row;
}

function assertEcoIdentity(data: Record<string, unknown>, expectedKey: string[], ecoId: string): Record<string, unknown> {
  if (!data.row || typeof data.row !== "object") throw new ProfileError("eco_row_missing");
  const row = data.row as Record<string, unknown>;
  if (!sameJson(row.rowKey, expectedKey) || expectedKey.length !== 4) throw new ProfileError("eco_row_key_mismatch");
  const cells = row.cells as Record<string, unknown> | undefined;
  for (const cell of ECO_CELLS) {
    if (!cells || !Object.prototype.hasOwnProperty.call(cells, cell)
      || (typeof cells[cell] !== "string" && !(cell === "target_version_id" && cells[cell] === null))) throw new ProfileError("eco_cell_missing_" + cell);
  }
  if (!cells || cells.id !== ecoId) throw new ProfileError("eco_identity");
  return row;
}

function recordBody(payload: Record<string, unknown>): { version: number; data: Record<string, unknown> } {
  const record = payload.record as { version?: unknown; data?: unknown } | undefined;
  if (!record || typeof record.version !== "number" || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    throw new ProfileError("record_read_missing");
  }
  return { version: record.version, data: record.data as Record<string, unknown> };
}

async function observeOwnedCounts(
  origin: URL,
  token: string,
  label: string,
  bindingId: string,
  sheetId: string,
  recordId: string,
  before: OwnedCounts,
  allowed: OwnedCounts,
): Promise<OwnedCounts> {
  const comments = dataOf(await request(label + "-comments", "GET", commentListUrl(origin, sheetId, recordId), undefined, token, 200));
  const counts = await readOwnedCounts(bindingId, sheetId, recordId);
  if (commentTotal(comments) !== counts.comments) throw new ProfileError("cardinality_api_mismatch");
  if (cardinalityVerdict(before, counts, allowed) !== "retained") throw new ProfileError(label + "_orphan_write");
  return counts;
}

async function runPhase(admission: Admission): Promise<void> {
  const metaOrigin = originOf(admission.metaOrigin, "http:");
  const nativeOrigin = originOf(admission.nativeOrigin, "https:");
  const secret = readJson(admission.secretPath) as SecretFile;
  const receipt = readJson(admission.fixtureReceiptPath) as Receipt;
  if (admission.tlsCertificateRejected !== true) throw new ProfileError("tls_negative_witness_missing");
  if (typeof admission.nativePid !== "number" || admission.nativePid <= 0) throw new ProfileError("native_pid_missing");
  nativePid = admission.nativePid;
  const licenseRefusal = signedImportRefusal(receipt);
  if (licenseRefusal !== null) throw new ProfileError(licenseRefusal);
  const resourceIds = receipt.resource_ids;
  if (!resourceIds || FAMILY_KINDS.some(([kind]) => typeof resourceIds[kind] !== "string" || !resourceIds[kind])) {
    throw new ProfileError("fixture_resource_ids_missing");
  }
  if (!receipt.item_id || !receipt.eco_id || !receipt.mbom_name || !receipt.mbom_name_delta || !receipt.eco_name || !receipt.eco_name_delta) {
    throw new ProfileError("fixture_receipt_incomplete");
  }
  const phase = admission.phase;
  if (phase === "before_restart") {
    const actors = await ensureMetaActors(metaOrigin, admission.secretPath, secret);
    if (!actors.meta || !actors.denied_meta) throw new ProfileError("meta_actor_missing");
    secret.meta = actors.meta;
    secret.denied_meta = actors.denied_meta;
    const native = await loginNative(nativeOrigin, secret.native);
    const metaPayload = await request("meta-login", "POST", new URL("/api/auth/login", metaOrigin), {
      identifier: secret.meta.identifier, password: secret.meta.password,
    }, null, 200) as { success?: boolean; data?: { token?: string; user?: { id?: string } } };
    const metaToken = requireString(metaPayload.data?.token, "meta_token_missing");
    const metaUser = requireString(metaPayload.data?.user?.id, "meta_user_missing");
    if (metaUser === native.userId) throw new ProfileError("identity_not_independent");
    const version = capturedVersion(receipt.current_version_id);
    const nativeToken = requireString(native.token, "native_token_missing");
    await nativeSource(nativeOrigin, nativeToken, receipt.item_id, "eco-context", { eco_id: receipt.eco_id, current_version_id: version }, "native-eco");
    const directRuleIds = new Set<string>();
    for (const ruleset of ["default", "readiness"]) {
      const payload = await nativeSource(nativeOrigin, nativeToken, receipt.item_id, "release-readiness", {
        ruleset_id: ruleset, current_version_id: version,
      }, "native-readiness-" + ruleset);
      for (const ruleId of assertFamilies(resourcesFromNative(payload), receipt, receipt.mbom_name)) directRuleIds.add(ruleId);
    }
    if (directRuleIds.size < 5) throw new ProfileError("diagnostic_rule_ids_lt_5");
    const baseRaw = await requestRaw("meta-base", "POST", new URL("/api/multitable/bases", metaOrigin), {
      name: "w23-owned-base",
    }, metaToken, [201, 403]);
    if (baseRaw.status === 403) throw new ProfileError("meta_permission_grant_requires_admin");
    const createdBase = dataOf(baseRaw.parsed).base as { id?: unknown } | undefined;
    const metaBaseId = requireString(createdBase?.id, "meta_base_missing");
    const dataSourceId = randomUUID();
    const registeredRaw = await requestRaw("register-source", "POST", new URL("/api/data-sources", metaOrigin), {
      id: dataSourceId, name: "w23-owned-" + dataSourceId, type: "plm",
      connection: { url: nativeOrigin.origin },
      options: { apiMode: "yuantus", tenantId: secret.native.tenant_id, orgId: secret.native.org_id, readOnly: true },
      credentials: { username: secret.native.username, password: secret.native.password },
    }, metaToken, [201, 403]);
    if (registeredRaw.status === 403) throw new ProfileError("meta_permission_grant_requires_admin");
    const registered = dataOf(registeredRaw.parsed);
    if (registered.id !== dataSourceId || registered.type !== "plm" || registered.connected !== false) throw new ProfileError("source_registration_contract_refused");
    await expectCode("missing-version", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "eco", dataSourceId, baseId: metaBaseId, itemId: receipt.item_id, ecoId: receipt.eco_id, name: "missing-version",
    }, metaToken, 422, "ECO_REQUEST_INVALID");
    const beforeRelay = journalCount(admission.journalPath);
    const ecoPreview = dataOf(await request("preview-eco", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "eco", dataSourceId, baseId: metaBaseId, itemId: receipt.item_id, currentVersionId: version, ecoId: receipt.eco_id, name: "w23-eco",
    }, metaToken, 200));
    await journalPositive(admission.journalPath, beforeRelay, "positive_meta_relay");
    const eco = await confirmCreate(metaOrigin, metaToken, requireString(ecoPreview.previewId, "preview_missing"), "confirm-eco");
    const expectedEcoKey = ecoKeyOf(dataSourceId, secret.native, receipt.eco_id);
    if (!sameJson(ecoPreview.rowKey, expectedEcoKey)) throw new ProfileError("eco_preview_key");
    const ecoBindingId = requireString(eco.bindingId, "eco_binding_missing");
    const ecoGot = dataOf(await request("eco-get", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    const ecoRow = assertEcoIdentity(ecoGot, expectedEcoKey, receipt.eco_id);
    const ecoSheetId = requireString(ecoGot.sheetId, "eco_sheet_missing");
    const ecoRecordId = requireString(ecoRow.recordId, "eco_record_missing");
    const ecoHistory = dataOf(await request("eco-history-before", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const ecoConfirmCounts = await observeOwnedCounts(metaOrigin, metaToken, "eco-confirm-counts", ecoBindingId, ecoSheetId, ecoRecordId, ECO_CONFIRM_COUNTS, QUIET_DELTA);
    const ecoContext = await request("eco-context-before-local", "GET", new URL("/api/multitable/context?baseId=" + encodeURIComponent(metaBaseId) + "&sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    fieldWalk(ecoContext);
    const ecoFields = await request("eco-fields-before-local", "GET", new URL("/api/multitable/fields?sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    const ecoWalk = collaborationFieldContract(ecoFields, "eco");
    const ecoLocalFields = fieldIds(ecoWalk.fields);
    if (ecoWalk.sourceFieldIds.length === 0) throw new ProfileError("eco_source_field_missing");
    const ecoBeforeLocal = recordBody(dataOf(await request("eco-record-before-local", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    const ecoSourceDigestBefore = sourceDigest(ecoBeforeLocal.data, ecoWalk.sourceFieldIds);
    const ecoDue = "2026-10-24T00:00:00.000Z";
    const ecoNote = "w23 owned eco note";
    const ecoLocalResult = dataOf(await request("eco-locals", "PATCH", new URL("/api/multitable/records/" + ecoRecordId, metaOrigin), {
      sheetId: ecoSheetId,
      expectedVersion: ecoBeforeLocal.version,
      data: {
        [ecoLocalFields.collaboration_owner]: [metaUser],
        [ecoLocalFields.followup_due_at]: ecoDue,
        [ecoLocalFields.review_note]: ecoNote,
      },
    }, metaToken, 200));
    const ecoAfterLocal = recordBody(ecoLocalResult);
    if (ecoAfterLocal.version !== ecoBeforeLocal.version + 1) throw new ProfileError("eco_local_cas");
    assertLocals(ecoAfterLocal.data, ecoLocalFields, metaUser, ecoDue, ecoNote);
    if (sourceDigest(ecoAfterLocal.data, ecoWalk.sourceFieldIds) !== ecoSourceDigestBefore) throw new ProfileError("eco_local_changed_source");
    const ecoHistoryAfterLocal = dataOf(await request("eco-history-after-local", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const ecoHistoryIdsBefore = historyIds(ecoHistory.items);
    const ecoHistoryIdsAfterLocal = historyIds(ecoHistoryAfterLocal.items);
    if (!historyRetained(ecoHistoryIdsBefore, ecoHistoryIdsAfterLocal) || ecoHistoryIdsAfterLocal.length !== ecoHistoryIdsBefore.length + 1) {
      throw new ProfileError("eco_local_history");
    }
    const ecoLocalCounts = await observeOwnedCounts(metaOrigin, metaToken, "eco-local-counts", ecoBindingId, ecoSheetId, ecoRecordId, ECO_LOCAL_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(ecoConfirmCounts, ecoLocalCounts, LOCAL_PATCH_DELTA) !== "retained") throw new ProfileError("eco_local_counts_delta");
    const ecoCommentPayload = dataOf(await request("eco-comment", "POST", new URL("/api/comments", metaOrigin), {
      containerId: ecoSheetId, targetId: ecoRecordId, content: ecoNote,
    }, metaToken, 201));
    const ecoComment = ecoCommentPayload.comment as { id?: unknown; content?: unknown } | undefined;
    if (!ecoComment || typeof ecoComment.id !== "string" || ecoComment.content !== ecoNote) throw new ProfileError("eco_comment_not_stored");
    const ecoListed = dataOf(await request("eco-comments-before-restart", "GET", commentListUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const ecoListedItems = ecoListed.items as Array<{ id?: unknown; content?: unknown }>;
    if (!Array.isArray(ecoListedItems) || !ecoListedItems.some((item) => item.id === ecoComment.id && item.content === ecoNote)) {
      throw new ProfileError("eco_comment_not_listed");
    }
    const ecoAfterComment = recordBody(dataOf(await request("eco-record-after-comment", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    if (ecoAfterComment.version !== ecoAfterLocal.version) throw new ProfileError("eco_comment_changed_record");
    assertLocals(ecoAfterComment.data, ecoLocalFields, metaUser, ecoDue, ecoNote);
    if (sourceDigest(ecoAfterComment.data, ecoWalk.sourceFieldIds) !== ecoSourceDigestBefore) throw new ProfileError("eco_comment_changed_source");
    const ecoHistoryAfterComment = dataOf(await request("eco-history-after-comment", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (historyDigest(ecoHistoryAfterComment.items) !== historyDigest(ecoHistoryAfterLocal.items)) throw new ProfileError("eco_comment_changed_history");
    const ecoHistoryIdsAfterComment = historyIds(ecoHistoryAfterComment.items);
    if (!sameJson(ecoHistoryIdsAfterComment, ecoHistoryIdsAfterLocal)) throw new ProfileError("eco_comment_changed_history");
    const ecoCommentCounts = await observeOwnedCounts(metaOrigin, metaToken, "eco-comment-counts", ecoBindingId, ecoSheetId, ecoRecordId, ECO_COMMENT_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(ecoLocalCounts, ecoCommentCounts, COMMENT_DELTA) !== "retained") throw new ProfileError("eco_comment_counts_delta");
    const ecoAfterLocals = dataOf(await request("eco-after-locals", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    const ecoPostLocalRow = assertEcoIdentity(ecoAfterLocals, expectedEcoKey, receipt.eco_id);
    assertEcoLocalSnapshotHeld(ecoGot, ecoAfterLocals, metaUser, ecoDue, ecoNote);
    const readyPreview = dataOf(await request("preview-readiness-default", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "readiness", dataSourceId, baseId: metaBaseId, itemId: receipt.item_id, currentVersionId: version, rulesetId: "default", name: READINESS_COLLECTION_NAME,
    }, metaToken, 200));
    const expectedDefaultKey = readinessKeyOf(dataSourceId, secret.native, receipt.item_id, "default");
    if (!sameJson(readyPreview.rowKey, expectedDefaultKey)) throw new ProfileError("default_preview_key");
    const readiness = await confirmCreate(metaOrigin, metaToken, requireString(readyPreview.previewId, "preview_missing"), "confirm-readiness");
    const readinessId = requireString(readiness.bindingId, "binding_missing");
    const confirmedSelected = dataOf(await request("select-default-at-confirm", "GET", snapshotUrl(metaOrigin, readinessId, JSON.stringify(expectedDefaultKey)), undefined, metaToken, 200));
    const confirmedRow = assertReadinessIdentity(confirmedSelected, expectedDefaultKey, receipt.item_id, version, "default");
    const confirmedSheetId = requireString(confirmedSelected.sheetId, "sheet_missing");
    const confirmedRecordId = requireString(confirmedRow.recordId, "record_missing");
    const readinessConfirmCounts = await observeOwnedCounts(metaOrigin, metaToken, "readiness-confirm-counts", readinessId, confirmedSheetId, confirmedRecordId, READY_CONFIRM_COUNTS, QUIET_DELTA);
    const secondPreview = dataOf(await request("preview-readiness-second", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "readiness", dataSourceId, baseId: metaBaseId, itemId: receipt.item_id, currentVersionId: version, rulesetId: "readiness", name: READINESS_COLLECTION_NAME,
    }, metaToken, 200));
    const expectedSecondKey = readinessKeyOf(dataSourceId, secret.native, receipt.item_id, "readiness");
    if (!sameJson(secondPreview.rowKey, expectedSecondKey) || sameJson(expectedDefaultKey, expectedSecondKey)) {
      throw new ProfileError("readiness_preview_key");
    }
    const appended = dataOf(await request("append-readiness", "POST", new URL("/api/plm-collaboration-snapshots/confirm", metaOrigin), {
      previewId: secondPreview.previewId, requestId: randomUUID(), expectedVersion: readiness.version, targetBindingId: readiness.bindingId,
    }, metaToken, 200));
    if (appended.bindingId !== readiness.bindingId || appended.sheetId !== readiness.sheetId || appended.viewId !== readiness.viewId) {
      throw new ProfileError("append_target_changed");
    }
    const absent = dataOf(await request("absent-selector", "GET", snapshotUrl(metaOrigin, readinessId), undefined, metaToken, 200));
    if (absent.row !== null || absent.canRefresh !== false) throw new ProfileError("absent_selector_not_shell");
    const selectedKey = JSON.stringify(expectedDefaultKey);
    const selected = dataOf(await request("select-default", "GET", snapshotUrl(metaOrigin, readinessId, selectedKey), undefined, metaToken, 200));
    const selectedRow = assertReadinessIdentity(selected, expectedDefaultKey, receipt.item_id, version, "default");
    const sheetId = requireString(selected.sheetId, "sheet_missing");
    const recordId = requireString(selectedRow.recordId, "record_missing");
    if (sheetId !== confirmedSheetId || recordId !== confirmedRecordId) throw new ProfileError("append_moved_selected_record");
    const readinessAppendCounts = await observeOwnedCounts(metaOrigin, metaToken, "readiness-append-counts", readinessId, sheetId, recordId, READY_APPEND_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(readinessConfirmCounts, readinessAppendCounts, APPEND_DELTA) !== "retained") throw new ProfileError("readiness_append_counts_delta");
    assertFamilies(resourcesFromRow(selectedRow), receipt, receipt.mbom_name);
    const secondKey = JSON.stringify(expectedSecondKey);
    const second = dataOf(await request("select-readiness", "GET", snapshotUrl(metaOrigin, readinessId, secondKey), undefined, metaToken, 200));
    const secondRow = assertReadinessIdentity(second, expectedSecondKey, receipt.item_id, version, "readiness");
    if (second.sheetId !== sheetId || second.viewId !== selected.viewId || second.id !== readinessId) {
      throw new ProfileError("collection_identity_split");
    }
    const secondRecordId = requireString(secondRow.recordId, "second_record_missing");
    if (secondRecordId === recordId) throw new ProfileError("record_ids_not_distinct");
    assertFamilies(resourcesFromRow(secondRow), receipt, receipt.mbom_name);
    const appendedGet = dataOf(await request("after-append-get", "GET", snapshotUrl(metaOrigin, readinessId, selectedKey), undefined, metaToken, 200));
    const versionAfterAppend = Number(appendedGet.version);
    if (!Number.isInteger(versionAfterAppend) || versionAfterAppend !== Number(appended.version)) {
      throw new ProfileError("append_version_unreadable");
    }
    const historyAtAppend = dataOf(await request("history-at-append", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const historyCountAtAppend = (historyAtAppend.items as unknown[]).length;
    const renamedPreview = dataOf(await request("preview-readiness-renamed", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "readiness", dataSourceId, baseId: metaBaseId, itemId: receipt.item_id, currentVersionId: version, rulesetId: "readiness", name: READINESS_RENAMED_NAME,
    }, metaToken, 200));
    await expectCode("renamed-confirm", "POST", new URL("/api/plm-collaboration-snapshots/confirm", metaOrigin), {
      previewId: renamedPreview.previewId, requestId: randomUUID(), expectedVersion: versionAfterAppend, targetBindingId: readinessId,
    }, metaToken, 409, "TARGET_MISMATCH");
    const afterRename = dataOf(await request("after-rename-get", "GET", snapshotUrl(metaOrigin, readinessId, selectedKey), undefined, metaToken, 200));
    const afterRenameSecond = dataOf(await request("after-rename-second", "GET", snapshotUrl(metaOrigin, readinessId, secondKey), undefined, metaToken, 200));
    const historyAfterRename = dataOf(await request("history-after-rename", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (Number(afterRename.version) !== versionAfterAppend || cellDigest(afterRename.row) !== cellDigest(selectedRow) || cellDigest(afterRenameSecond.row) !== cellDigest(secondRow)) {
      throw new ProfileError("renamed_target_mutated");
    }
    if ((historyAfterRename.items as unknown[]).length !== historyCountAtAppend) throw new ProfileError("renamed_target_mutated_history");
    const readinessAfterRenameCounts = await observeOwnedCounts(metaOrigin, metaToken, "readiness-rename-counts", readinessId, sheetId, recordId, READY_APPEND_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(readinessAppendCounts, readinessAfterRenameCounts, QUIET_DELTA) !== "retained") throw new ProfileError("rename_counts_delta");
    const context = await request("context", "GET", new URL("/api/multitable/context?baseId=" + encodeURIComponent(metaBaseId) + "&sheetId=" + encodeURIComponent(sheetId), metaOrigin), undefined, metaToken, 200);
    fieldWalk(context);
    const fields = await request("fields", "GET", new URL("/api/multitable/fields?sheetId=" + encodeURIComponent(sheetId), metaOrigin), undefined, metaToken, 200);
    const walked = collaborationFieldContract(fields, "readiness");
    const localFields: Record<string, string> = {};
    for (const [name, type] of LOCAL_FIELDS) {
      const field = walked.fields.get(name);
      if (!field || field.type !== type) throw new ProfileError("local_field_missing_" + name);
      localFields[name] = field.id;
    }
    if (walked.sourceFieldIds.length === 0) throw new ProfileError("source_field_missing");
    const history = dataOf(await request("history-before", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const items = history.items as Array<{ version?: number }>;
    const recordVersion = items?.[0]?.version;
    if (typeof recordVersion !== "number") throw new ProfileError("record_cas_not_visible");
    const note = "w23 owned diagnostic note";
    const due = "2026-10-24T00:00:00.000Z";
    const localResult = dataOf(await request("locals", "PATCH", new URL("/api/multitable/records/" + recordId, metaOrigin), {
      sheetId,
      expectedVersion: recordVersion,
      data: {
        [localFields.collaboration_owner]: [metaUser],
        [localFields.followup_due_at]: due,
        [localFields.review_note]: note,
      },
    }, metaToken, 200));
    const localRecord = recordBody(localResult);
    assertLocals(localRecord.data, localFields, metaUser, due, note);
    const readinessLocalCounts = await observeOwnedCounts(metaOrigin, metaToken, "readiness-local-counts", readinessId, sheetId, recordId, READY_LOCAL_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(readinessAfterRenameCounts, readinessLocalCounts, LOCAL_PATCH_DELTA) !== "retained") throw new ProfileError("readiness_local_counts_delta");
    const commentPayload = dataOf(await request("comment", "POST", new URL("/api/comments", metaOrigin), {
      containerId: sheetId, targetId: recordId, content: note,
    }, metaToken, 201));
    const comment = commentPayload.comment as { id?: unknown; content?: unknown } | undefined;
    if (!comment || typeof comment.id !== "string" || comment.content !== note) throw new ProfileError("comment_not_stored");
    const listed = dataOf(await request("comments-before-restart", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const listedItems = listed.items as Array<{ id?: unknown; content?: unknown }>;
    if (!Array.isArray(listedItems) || !listedItems.some((item) => item.id === comment.id && item.content === note)) {
      throw new ProfileError("comment_not_listed");
    }
    const historyAfter = dataOf(await request("history-after", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const afterItems = historyAfter.items as unknown[];
    if (!Array.isArray(afterItems) || afterItems.length !== items.length + 1) throw new ProfileError("history_not_appended");
    const readinessCommentCounts = await observeOwnedCounts(metaOrigin, metaToken, "readiness-comment-counts", readinessId, sheetId, recordId, READY_COMMENT_COUNTS, QUIET_DELTA);
    if (cardinalityVerdict(readinessLocalCounts, readinessCommentCounts, COMMENT_DELTA) !== "retained") throw new ProfileError("readiness_comment_counts_delta");
    const postSnapshot = dataOf(await request("postlocal-snapshot", "GET", snapshotUrl(metaOrigin, readinessId, selectedKey), undefined, metaToken, 200));
    const postRow = assertReadinessIdentity(postSnapshot, expectedDefaultKey, receipt.item_id, version, "default");
    const postRecord = recordBody(dataOf(await request("postlocal-record", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    if (postSnapshot.canRefresh !== true) throw new ProfileError("postlocal_cannot_refresh");
    assertLocals(postRecord.data, localFields, metaUser, due, note);
    if (!metaUser || !due || !note) throw new ProfileError("local_empty");
    const postMeta = snapshotMeta(postSnapshot);
    stateSave(admission.statePath, {
      dataSourceId, version, metaUser, metaBaseId, eco, readiness, selectedKey, secondKey, ecoPreview, readyPreview, secondPreview,
      sheetId, recordId, secondRecordId, note, due, commentId: comment.id, historyCount: afterItems.length,
      recordVersion: postRecord.version, localFields, sourceFieldId: walked.sourceFieldIds[0],
      sourceFieldIds: walked.sourceFieldIds,
      resourcesBefore: (postRow.cells as Record<string, unknown>).resources,
      selectedCells: cellDigest(postRow),
      secondCells: cellDigest(secondRow),
      commentDigest: commentDigest(listedItems),
      historyDigest: historyDigest(afterItems),
      sourceDigest: sourceDigest(postRecord.data, walked.sourceFieldIds),
      capturedAt: postMeta.capturedAt,
      businessHash: postMeta.businessHash,
      canRefresh: true,
      ecoBindingId, ecoSheetId, ecoRecordId, ecoKey: expectedEcoKey,
      ecoCells: cellDigest(ecoPostLocalRow),
      ecoCapturedAt: ecoRow.capturedAt ?? null,
      ecoBusinessHash: ecoRow.businessHash ?? null,
      bindingVersion: versionAfterAppend,
      ecoVersion: Number(ecoGot.version),
      ecoDue, ecoNote,
      ecoRecordVersion: ecoAfterComment.version,
      ecoLocalFields,
      ecoCommentId: ecoComment.id,
      ecoCommentDigest: commentDigest(ecoListedItems),
      ecoHistoryDigest: historyDigest(ecoHistoryAfterComment.items),
      ecoHistoryIds: ecoHistoryIdsAfterComment,
      ecoSourceDigest: ecoSourceDigestBefore,
      ecoSourceFieldIds: ecoWalk.sourceFieldIds,
      ecoCounts: ecoCommentCounts,
      readinessCounts: readinessCommentCounts,
      viewId: selected.viewId,
    });
    emit({ status: "CONTINUE", next_phase: "after_restart", runtime: "RUNNING" }, 10);
  }
  const state = stateLoad(admission.statePath);
  if (!secret.meta || !secret.denied_meta) throw new ProfileError("meta_actor_missing");
  const metaToken = await loginMeta(metaOrigin, secret.meta.identifier, secret.meta.password);
  const readiness = state.readiness as Record<string, unknown>;

  function observeCounts(label: string, scopeBinding: string, scopeSheet: string, scopeRecord: string, before: OwnedCounts, allowed: OwnedCounts): Promise<OwnedCounts> {
    return observeOwnedCounts(metaOrigin, metaToken, label, scopeBinding, scopeSheet, scopeRecord, before, allowed);
  }
  const bindingId = requireString(readiness.bindingId, "binding_missing");
  if (phase === "after_restart") {
    const got = dataOf(await request("reload-get", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    if (!got.row || got.id !== bindingId || got.sheetId !== state.sheetId) throw new ProfileError("reload_not_stable");
    const row = got.row as Record<string, unknown>;
    if (row.recordId !== state.recordId) throw new ProfileError("reload_not_stable");
    assertFamilies(resourcesFromRow(row), receipt, String(receipt.mbom_name));
    assertReadinessIdentity(got, JSON.parse(String(state.selectedKey)) as string[], String(receipt.item_id), capturedVersion(state.version), "default");
    if (got.viewId !== state.viewId || got.canRefresh !== true) throw new ProfileError("reload_not_stable");
    if (cellDigest(row) !== state.selectedCells) throw new ProfileError("selected_cells_changed");
    const reloadedMeta = snapshotMeta(got);
    if (reloadedMeta.capturedAt !== state.capturedAt || reloadedMeta.businessHash !== state.businessHash || reloadedMeta.recordId !== state.recordId) {
      throw new ProfileError("reload_metadata_changed");
    }
    if (Number(reloadedMeta.version) !== Number(state.bindingVersion) || reloadedMeta.canRefresh !== true || reloadedMeta.status !== "active") {
      throw new ProfileError("reload_metadata_changed");
    }
    const sheetId = requireString(state.sheetId, "sheet_missing");
    const recordId = requireString(state.recordId, "record_missing");
    const context = await request("context-after-restart", "GET", new URL("/api/multitable/context?baseId=" + encodeURIComponent(String(state.metaBaseId)) + "&sheetId=" + encodeURIComponent(sheetId), metaOrigin), undefined, metaToken, 200);
    fieldWalk(context);
    const fields = await request("fields-after-restart", "GET", new URL("/api/multitable/fields?sheetId=" + encodeURIComponent(sheetId), metaOrigin), undefined, metaToken, 200);
    const walked = collaborationFieldContract(fields, "readiness");
    const localFields = state.localFields as Record<string, string>;
    for (const [name, type] of LOCAL_FIELDS) {
      const field = walked.fields.get(name);
      if (!field || field.type !== type || field.id !== localFields[name]) throw new ProfileError("local_field_not_retained_" + name);
    }
    if (!sameJson([...walked.sourceFieldIds].sort(), [...(state.sourceFieldIds as string[])].sort())) throw new ProfileError("source_field_missing");
    const retained = recordBody(dataOf(await request("record-retained", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    if (retained.version !== state.recordVersion) throw new ProfileError("record_cas_not_retained");
    if (sourceDigest(retained.data, state.sourceFieldIds) !== state.sourceDigest) throw new ProfileError("source_cell_changed");
    assertLocals(retained.data, localFields, String(state.metaUser), String(state.due), String(state.note));
    const comments = dataOf(await request("comments-retained", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const commentItems = comments.items as Array<{ id?: unknown; content?: unknown }>;
    if (!Array.isArray(commentItems) || !commentItems.some((item) => item.id === state.commentId && item.content === state.note)) {
      throw new ProfileError("comment_not_retained");
    }
    if (commentDigest(commentItems) !== state.commentDigest) throw new ProfileError("comment_projection_changed");
    const historyRetained = dataOf(await request("history-retained", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const retainedItems = historyRetained.items as unknown[];
    if (!Array.isArray(retainedItems) || retainedItems.length !== state.historyCount) throw new ProfileError("history_not_retained");
    if (historyDigest(retainedItems) !== state.historyDigest) throw new ProfileError("history_projection_changed");
    const secondReloaded = dataOf(await request("reload-second", "GET", snapshotUrl(metaOrigin, bindingId, String(state.secondKey)), undefined, metaToken, 200));
    assertReadinessIdentity(secondReloaded, JSON.parse(String(state.secondKey)) as string[], String(receipt.item_id), capturedVersion(state.version), "readiness");
    if (secondReloaded.sheetId !== sheetId || secondReloaded.viewId !== state.viewId || cellDigest(secondReloaded.row) !== state.secondCells) {
      throw new ProfileError("second_reload_changed");
    }
    const beforeNoop = snapshotMeta(got);
    const current = Number(got.version);
    const carriedReadiness = requireHealthyCarry("readiness-restart", state.readinessCounts, READY_COMMENT_COUNTS);
    const countsBeforeNoop = await observeCounts("noop-before", bindingId, sheetId, recordId, carriedReadiness, QUIET_DELTA);
    const noop = dataOf(await request("clock-noop", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/refresh", metaOrigin), {
      expectedVersion: current, rowKey: JSON.parse(String(state.selectedKey)),
    }, metaToken, 200));
    if (noop.noop !== true || Number(noop.version) !== current) throw new ProfileError("noop_not_held");
    const afterNoop = dataOf(await request("noop-reread", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    assertMetaHeld("noop_mutated_metadata", beforeNoop, snapshotMeta(afterNoop));
    const recordAfterNoop = recordBody(dataOf(await request("record-after-noop", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    if (recordAfterNoop.version !== retained.version) throw new ProfileError("noop_mutated_record");
    const historyAfterNoop = dataOf(await request("history-after-noop", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (historyDigest(historyAfterNoop.items) !== state.historyDigest) throw new ProfileError("noop_mutated_history");
    const countsAfterNoop = await observeCounts("noop-after", bindingId, sheetId, recordId, countsBeforeNoop, QUIET_DELTA);
    const ecoBindingId = requireString(state.ecoBindingId, "eco_binding_missing");
    const ecoSheetId = requireString(state.ecoSheetId, "eco_sheet_missing");
    const ecoRecordId = requireString(state.ecoRecordId, "eco_record_missing");
    const ecoReloaded = dataOf(await request("eco-reload", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    const ecoRow = assertEcoIdentity(ecoReloaded, state.ecoKey as string[], String(receipt.eco_id));
    if (restartVerdict(state.ecoCells as string, cellDigest(ecoRow)) !== "retained" || ecoRow.capturedAt !== state.ecoCapturedAt || ecoRow.businessHash !== state.ecoBusinessHash) {
      throw new ProfileError("eco_reload_changed");
    }
    if (Number(ecoReloaded.version) !== Number(state.ecoVersion) || ecoReloaded.canRefresh !== true) throw new ProfileError("eco_reload_changed");
    const ecoContextAfter = await request("eco-context-after-restart", "GET", new URL("/api/multitable/context?baseId=" + encodeURIComponent(String(state.metaBaseId)) + "&sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    fieldWalk(ecoContextAfter);
    const ecoFieldsAfter = await request("eco-fields-after-restart", "GET", new URL("/api/multitable/fields?sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    const ecoWalkAfter = collaborationFieldContract(ecoFieldsAfter, "eco");
    if (!sameJson([...ecoWalkAfter.sourceFieldIds].sort(), [...(state.ecoSourceFieldIds as string[])].sort())) throw new ProfileError("eco_source_field_not_retained");
    const ecoLocalFields = fieldIds(ecoWalkAfter.fields);
    const savedEcoFields = state.ecoLocalFields as Record<string, string>;
    for (const [name] of LOCAL_FIELDS) {
      if (ecoLocalFields[name] !== savedEcoFields[name]) throw new ProfileError("eco_local_field_not_retained_" + name);
    }
    const ecoRetained = recordBody(dataOf(await request("eco-record-retained", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    if (ecoRetained.version !== state.ecoRecordVersion) throw new ProfileError("eco_record_cas_not_retained");
    assertLocals(ecoRetained.data, ecoLocalFields, String(state.metaUser), String(state.ecoDue), String(state.ecoNote));
    if (sourceDigest(ecoRetained.data, state.ecoSourceFieldIds) !== state.ecoSourceDigest) throw new ProfileError("eco_source_not_retained");
    const ecoCommentsRetained = dataOf(await request("eco-comments-retained", "GET", commentListUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const ecoCommentItems = ecoCommentsRetained.items as Array<{ id?: unknown; content?: unknown }>;
    if (!Array.isArray(ecoCommentItems) || !ecoCommentItems.some((item) => item.id === state.ecoCommentId && item.content === state.ecoNote)) {
      throw new ProfileError("eco_comment_not_retained");
    }
    if (commentDigest(ecoCommentItems) !== state.ecoCommentDigest) throw new ProfileError("eco_comment_projection_changed");
    const ecoHistoryRetained = dataOf(await request("eco-history-retained", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (historyDigest(ecoHistoryRetained.items) !== state.ecoHistoryDigest) throw new ProfileError("eco_history_not_retained");
    if (!sameJson(historyIds(ecoHistoryRetained.items), state.ecoHistoryIds)) throw new ProfileError("eco_history_not_retained");
    const carriedEco = requireHealthyCarry("eco-restart", state.ecoCounts, ECO_COMMENT_COUNTS);
    const ecoCountsBeforeNoop = await observeCounts("eco-noop-before", ecoBindingId, ecoSheetId, ecoRecordId, carriedEco, QUIET_DELTA);
    const ecoNoop = dataOf(await request("eco-noop", "POST", new URL("/api/plm-collaboration-snapshots/" + ecoBindingId + "/refresh", metaOrigin), {
      expectedVersion: Number(state.ecoVersion), rowKey: state.ecoKey,
    }, metaToken, 200));
    if (ecoNoop.noop !== true || Number(ecoNoop.version) !== Number(state.ecoVersion)) throw new ProfileError("eco_noop_not_held");
    const ecoAfterNoop = dataOf(await request("eco-noop-reread", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    if (restartVerdict(state.ecoCells as string, cellDigest(ecoAfterNoop.row)) !== "retained" || Number(ecoAfterNoop.version) !== Number(state.ecoVersion)) {
      throw new ProfileError("eco_noop_mutated");
    }
    const ecoRecordAfterNoop = recordBody(dataOf(await request("eco-record-after-noop", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    if (ecoRecordAfterNoop.version !== ecoRetained.version) throw new ProfileError("eco_noop_mutated_record");
    assertLocals(ecoRecordAfterNoop.data, ecoLocalFields, String(state.metaUser), String(state.ecoDue), String(state.ecoNote));
    const ecoHistoryAfterNoop = dataOf(await request("eco-history-after-noop", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (historyDigest(ecoHistoryAfterNoop.items) !== state.ecoHistoryDigest) throw new ProfileError("eco_noop_mutated_history");
    const ecoCommentsAfterNoop = dataOf(await request("eco-comments-after-noop", "GET", commentListUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (commentDigest(ecoCommentsAfterNoop.items) !== state.ecoCommentDigest) throw new ProfileError("eco_noop_mutated_comments");
    const ecoCountsAfterNoop = await observeCounts("eco-noop-after", ecoBindingId, ecoSheetId, ecoRecordId, ecoCountsBeforeNoop, QUIET_DELTA);
    const countsBeforeRefusal = await observeCounts("refusal-before", bindingId, sheetId, recordId, countsAfterNoop, QUIET_DELTA);
    const sourcePatch = await request("source-patch", "PATCH", new URL("/api/multitable/records/" + recordId, metaOrigin), {
      sheetId, expectedVersion: retained.version, data: { [String(state.sourceFieldId)]: "mutated" },
    }, metaToken, [400, 403]);
    if (codeOf(sourcePatch) !== "FIELD_READONLY" && codeOf(sourcePatch) !== "VALIDATION_ERROR" && codeOf(sourcePatch) !== "FORBIDDEN") {
      throw new ProfileError("source_patch_not_refused");
    }
    const afterRefusal = recordBody(dataOf(await request("record-after-refusal", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    if (afterRefusal.version !== retained.version) throw new ProfileError("source_patch_changed_record");
    if (sourceDigest(afterRefusal.data, state.sourceFieldIds) !== state.sourceDigest) throw new ProfileError("source_cell_changed");
    assertLocals(afterRefusal.data, localFields, String(state.metaUser), String(state.due), String(state.note));
    const historyUnchanged = dataOf(await request("history-after-refusal", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const unchangedItems = historyUnchanged.items as unknown[];
    if (!Array.isArray(unchangedItems) || unchangedItems.length !== state.historyCount) throw new ProfileError("source_patch_changed_history");
    if (historyDigest(unchangedItems) !== state.historyDigest) throw new ProfileError("source_patch_changed_history");
    const selectedAfter = dataOf(await request("selected-after-refusal", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const secondAfter = dataOf(await request("second-after-refusal", "GET", snapshotUrl(metaOrigin, bindingId, String(state.secondKey)), undefined, metaToken, 200));
    if (cellDigest(selectedAfter.row) !== state.selectedCells || cellDigest(secondAfter.row) !== state.secondCells) {
      throw new ProfileError("refusal_changed_row");
    }
    const refusedMeta = snapshotMeta(selectedAfter);
    if (refusedMeta.capturedAt !== state.capturedAt || refusedMeta.businessHash !== state.businessHash || refusedMeta.canRefresh !== true) {
      throw new ProfileError("refusal_changed_metadata");
    }
    const commentsAfterRefusal = dataOf(await request("comments-after-refusal", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (commentDigest(commentsAfterRefusal.items) !== state.commentDigest) throw new ProfileError("refusal_changed_comments");
    await observeCounts("refusal-after", bindingId, sheetId, recordId, countsBeforeRefusal, QUIET_DELTA);
    emit({ status: "CONTINUE", next_phase: "after_delta", runtime: "RUNNING" }, 10);
  }
  if (phase === "after_delta") {
    const sheetId = requireString(state.sheetId, "sheet_missing");
    const recordId = requireString(state.recordId, "record_missing");
    const localFields = state.localFields as Record<string, string>;
    const ecoBindingId = requireString(state.ecoBindingId, "eco_binding_missing");
    const ecoSheetId = requireString(state.ecoSheetId, "eco_sheet_missing");
    const ecoRecordId = requireString(state.ecoRecordId, "eco_record_missing");
    const ecoBefore = dataOf(await request("eco-before-delta", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    const ecoBeforeRow = assertEcoIdentity(ecoBefore, state.ecoKey as string[], String(receipt.eco_id));
    const ecoVersion = Number(ecoBefore.version);
    const ecoContext = await request("eco-context-before", "GET", new URL("/api/multitable/context?baseId=" + encodeURIComponent(String(state.metaBaseId)) + "&sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    fieldWalk(ecoContext);
    const ecoFields = await request("eco-fields-before", "GET", new URL("/api/multitable/fields?sheetId=" + encodeURIComponent(ecoSheetId), metaOrigin), undefined, metaToken, 200);
    const ecoWalkBefore = collaborationFieldContract(ecoFields, "eco");
    if (!sameJson([...ecoWalkBefore.sourceFieldIds].sort(), [...(state.ecoSourceFieldIds as string[])].sort())) throw new ProfileError("eco_source_field_not_retained");
    const ecoLocalIds = fieldIds(ecoWalkBefore.fields);
    const ecoRecordBefore = recordBody(dataOf(await request("eco-record-before", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    const ecoLocalsBefore = localValues(ecoRecordBefore.data, ecoLocalIds);
    const ecoHistoryBefore = dataOf(await request("eco-history-before-delta", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const ecoPriorHistory = historyIds(ecoHistoryBefore.items);
    const ecoCommentsBefore = dataOf(await request("eco-comments-before-delta", "GET", commentListUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const savedEcoFields = state.ecoLocalFields as Record<string, string>;
    for (const [name] of LOCAL_FIELDS) {
      if (ecoLocalIds[name] !== savedEcoFields[name]) throw new ProfileError("eco_local_field_not_retained_" + name);
    }
    assertLocals(ecoRecordBefore.data, ecoLocalIds, String(state.metaUser), String(state.ecoDue), String(state.ecoNote));
    if (ecoRecordBefore.version !== state.ecoRecordVersion) throw new ProfileError("eco_record_cas_not_retained");
    if (sourceDigest(ecoRecordBefore.data, state.ecoSourceFieldIds) !== state.ecoSourceDigest) throw new ProfileError("eco_source_not_retained");
    if (commentDigest(ecoCommentsBefore.items) !== state.ecoCommentDigest) throw new ProfileError("eco_comment_projection_changed");
    if (historyDigest(ecoHistoryBefore.items) !== state.ecoHistoryDigest || !sameJson(ecoPriorHistory, state.ecoHistoryIds)) {
      throw new ProfileError("eco_history_not_retained");
    }
    const carriedEco = requireHealthyCarry("eco-delta", state.ecoCounts, ECO_COMMENT_COUNTS);
    const ecoCountsBefore = await observeCounts("eco-delta-before", ecoBindingId, ecoSheetId, ecoRecordId, carriedEco, QUIET_DELTA);
    const ecoCellsBefore = ecoBeforeRow.cells as Record<string, unknown>;
    if (ecoCellsBefore.name !== receipt.eco_name) throw new ProfileError("eco_business_not_observed");
    const ecoRefresh = dataOf(await request("eco-delta-refresh", "POST", new URL("/api/plm-collaboration-snapshots/" + ecoBindingId + "/refresh", metaOrigin), {
      expectedVersion: ecoVersion, rowKey: state.ecoKey,
    }, metaToken, 200));
    const ecoAfterDelta = dataOf(await request("eco-after-delta", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    const ecoAfterRow = ecoAfterDelta.row as Record<string, unknown>;
    const ecoCellsAfter = ecoAfterRow.cells as Record<string, unknown>;
    if (
      ecoBusinessVerdict(
        ecoRefresh.noop === true,
        Number(ecoRefresh.version),
        ecoVersion,
        String(ecoBeforeRow.businessHash ?? ""),
        String(ecoAfterRow.businessHash ?? ""),
        ecoAfterDelta.canRefresh === true,
      ) !== "eco_business_changed"
      || Number(ecoAfterDelta.version) !== ecoVersion + 1
      || ecoCellsAfter.name !== receipt.eco_name_delta
      || ecoAfterRow.recordId !== ecoRecordId
    ) throw new ProfileError("eco_business_not_observed");
    const ecoRecordAfter = recordBody(dataOf(await request("eco-record-after", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    if (ecoRecordAfter.version !== ecoRecordBefore.version + 1) throw new ProfileError("eco_record_version");
    if (!sameJson(localValues(ecoRecordAfter.data, ecoLocalIds), ecoLocalsBefore)) throw new ProfileError("eco_locals_changed");
    const ecoHistoryAfter = dataOf(await request("eco-history-after-delta", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (!historyRetained(ecoPriorHistory, historyIds(ecoHistoryAfter.items))) throw new ProfileError("eco_history_dropped");
    const ecoCommentsAfter = dataOf(await request("eco-comments-after-delta", "GET", commentListUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    if (commentDigest(ecoCommentsAfter.items) !== commentDigest(ecoCommentsBefore.items)) throw new ProfileError("eco_comments_changed");
    const ecoCountsAfter = await observeCounts("eco-delta-after", ecoBindingId, ecoSheetId, ecoRecordId, ecoCountsBefore, SOURCE_WRITE_DELTA);
    if (cardinalityVerdict(ECO_SOURCE_COUNTS, ecoCountsAfter, QUIET_DELTA) !== "retained") throw new ProfileError("eco_source_counts");
    const priorCas = ecoVersion;
    if (priorAcceptedCas(priorCas, ecoVersion, ecoVersion + 1) !== "prior_accepted_cas") throw new ProfileError("eco_prior_cas");
    await expectCode("eco-stale-cas", "POST", new URL("/api/plm-collaboration-snapshots/" + ecoBindingId + "/refresh", metaOrigin), {
      expectedVersion: priorCas, rowKey: state.ecoKey,
    }, metaToken, 409, "VERSION_CONFLICT");
    const ecoAfterStale = dataOf(await request("eco-after-stale", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    if (
      cellDigest(ecoAfterStale.row) !== cellDigest(ecoAfterRow)
      || Number(ecoAfterStale.version) !== ecoVersion + 1
      || ecoAfterStale.canRefresh !== true
      || (ecoAfterStale.row as Record<string, unknown>).businessHash !== ecoAfterRow.businessHash
    ) throw new ProfileError("eco_stale_cas_mutated");
    const ecoRecordAfterStale = recordBody(dataOf(await request("eco-record-after-stale", "GET", recordUrl(metaOrigin, ecoRecordId, ecoSheetId), undefined, metaToken, 200)));
    if (ecoRecordAfterStale.version !== ecoRecordAfter.version || !sameJson(localValues(ecoRecordAfterStale.data, ecoLocalIds), ecoLocalsBefore)) {
      throw new ProfileError("eco_stale_cas_mutated");
    }
    const ecoCountsAfterStale = await observeCounts("eco-stale-after", ecoBindingId, ecoSheetId, ecoRecordId, ecoCountsAfter, QUIET_DELTA);
    const beforeRelay = journalCount(admission.journalPath);
    const current = dataOf(await request("changed-get", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const version = Number(current.version);
    const currentRow = current.row as Record<string, unknown>;
    const beforeCaptured = currentRow.capturedAt;
    const beforeHash = currentRow.businessHash;
    const beforeGenerated = generatedAt(currentRow);
    const carriedReadiness = requireHealthyCarry("readiness-delta", state.readinessCounts, READY_COMMENT_COUNTS);
    const countsBeforeReadiness = await observeCounts("readiness-before", bindingId, sheetId, recordId, carriedReadiness, QUIET_DELTA);
    const refreshed = dataOf(await request("business-refresh", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/refresh", metaOrigin), {
      expectedVersion: version, rowKey: JSON.parse(String(state.selectedKey)),
    }, metaToken, 200));
    await journalPositive(admission.journalPath, beforeRelay, "positive_meta_delta");
    if (refreshed.noop !== false || Number(refreshed.version) !== version + 1) throw new ProfileError("business_change_not_visible");
    const after = dataOf(await request("changed-reread", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const afterRow = after.row as Record<string, unknown>;
    if (after.canRefresh !== true || Number(after.version) !== version + 1) throw new ProfileError("business_change_not_visible");
    if (
      afterRow.capturedAt === beforeCaptured || afterRow.businessHash === beforeHash || generatedAt(afterRow) === beforeGenerated
      || observedTimeChange(String(beforeCaptured), String(afterRow.capturedAt)) !== "generated_time_changed"
    ) throw new ProfileError("generated_time_not_observed");
    const afterResources = String((afterRow.cells as Record<string, unknown>).resources ?? "");
    if (afterResources === String(state.resourcesBefore)) throw new ProfileError("business_material_unchanged");
    assertFamilies(resourcesFromRow(afterRow), receipt, String(receipt.mbom_name_delta));
    const second = dataOf(await request("second-after-delta", "GET", snapshotUrl(metaOrigin, bindingId, String(state.secondKey)), undefined, metaToken, 200));
    if (cellDigest(second.row) !== state.secondCells) throw new ProfileError("nonselected_row_changed");
    const record = recordBody(dataOf(await request("record-after-delta", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    assertLocals(record.data, localFields, String(state.metaUser), String(state.due), String(state.note));
    const comments = dataOf(await request("comments-after-delta", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (commentDigest(comments.items) !== state.commentDigest) throw new ProfileError("comment_ids_changed");
    const countsAfterReadiness = await observeCounts("readiness-after", bindingId, sheetId, recordId, countsBeforeReadiness, SOURCE_WRITE_DELTA);
    if (cardinalityVerdict(READY_SOURCE_COUNTS, countsAfterReadiness, QUIET_DELTA) !== "retained") throw new ProfileError("readiness_source_counts");
    await expectCode("stale-cas", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/refresh", metaOrigin), {
      expectedVersion: version, rowKey: JSON.parse(String(state.selectedKey)),
    }, metaToken, 409, "VERSION_CONFLICT");
    const afterStale = dataOf(await request("after-stale", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    if (
      cellDigest(afterStale.row) !== cellDigest(afterRow) || Number(afterStale.version) !== Number(refreshed.version)
      || (afterStale.row as Record<string, unknown>).capturedAt !== afterRow.capturedAt
      || (afterStale.row as Record<string, unknown>).businessHash !== afterRow.businessHash
    ) {
      throw new ProfileError("stale_cas_mutated");
    }
    const countsAfterStale = await observeCounts("readiness-stale", bindingId, sheetId, recordId, countsAfterReadiness, QUIET_DELTA);
    const eco = state.eco as Record<string, unknown>;
    const replayReadinessBefore = await observeCounts("replay-readiness-before", bindingId, sheetId, recordId, countsAfterStale, QUIET_DELTA);
    const replayEcoBefore = await observeCounts("replay-eco-before", ecoBindingId, ecoSheetId, ecoRecordId, ecoCountsAfterStale, QUIET_DELTA);
    const historyBeforeReplay = dataOf(await request("history-before-replay", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const ecoHistoryBeforeReplay = dataOf(await request("eco-history-before-replay", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const recordBeforeReplay = recordBody(dataOf(await request("record-before-replay", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    const replay = dataOf(await request("exact-retry", "POST", new URL("/api/plm-collaboration-snapshots/confirm", metaOrigin), {
      previewId: eco.previewId ?? (state.ecoPreview as Record<string, unknown>).previewId,
      requestId: eco.requestId, expectedVersion: 0,
    }, metaToken, 200));
    if (replay.replayed !== true || replay.bindingId !== eco.bindingId) throw new ProfileError("retry_not_exact");
    const history = dataOf(await request("history-after-delta", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    const ecoHistoryAfterReplay = dataOf(await request("eco-history-after-replay", "GET", historyUrl(metaOrigin, ecoSheetId, ecoRecordId), undefined, metaToken, 200));
    const recordAfterReplay = recordBody(dataOf(await request("record-after-replay", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    const ecoAfterReplay = dataOf(await request("eco-after-replay", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    if (historyDigest(history.items) !== historyDigest(historyBeforeReplay.items) || historyDigest(ecoHistoryAfterReplay.items) !== historyDigest(ecoHistoryBeforeReplay.items)) {
      throw new ProfileError("replay_added_history");
    }
    if (recordAfterReplay.version !== recordBeforeReplay.version || (ecoAfterReplay.row as Record<string, unknown>).recordId !== ecoRecordId) {
      throw new ProfileError("replay_added_row");
    }
    const readinessCounts = await observeCounts("replay-readiness-after", bindingId, sheetId, recordId, replayReadinessBefore, QUIET_DELTA);
    const ecoCounts = await observeCounts("replay-eco-after", ecoBindingId, ecoSheetId, ecoRecordId, replayEcoBefore, QUIET_DELTA);
    const frozen = await loginNative(nativeOrigin, secret.native, "native-login-freeze", 200);
    stateSave(admission.statePath, {
      ...state,
      ecoVersion: Number(ecoAfterDelta.version),
      ecoCells: cellDigest(ecoAfterRow),
      ecoCapturedAt: ecoAfterRow.capturedAt ?? null,
      ecoBusinessHash: ecoAfterRow.businessHash ?? null,
      nativeToken: requireString(frozen.token, "native_token_missing"),
      selectedCellsAfter: cellDigest(afterRow),
      bindingVersionAfter: refreshed.version,
      sourceDigestAfter: sourceDigest(record.data, state.sourceFieldIds),
      historyDigestAfter: historyDigest(history.items),
      ecoRecordVersion: ecoRecordAfter.version,
      ecoHistoryDigest: historyDigest(ecoHistoryAfterReplay.items),
      ecoHistoryIds: historyIds(ecoHistoryAfterReplay.items),
      ecoSourceDigest: sourceDigest(ecoRecordAfter.data, state.ecoSourceFieldIds),
      ecoCounts,
      readinessCounts,
    });
    emit({ status: "CONTINUE", next_phase: "after_revoke", runtime: "RUNNING" }, 10);
  }
  if (phase === "after_revoke") {
    const revoked = await loginNative(nativeOrigin, secret.native, "native-login-revoked", 403);
    if (revoked.status !== 403) throw new ProfileError("revoked_login_not_denied");
    const frozen = requireString(state.nativeToken, "frozen_native_token_missing");
    const probe = await requestRaw("frozen-token-readiness", "POST", new URL("/api/v1/plm/collaboration-sources/items/" + encodeURIComponent(String(receipt.item_id)) + "/release-readiness", nativeOrigin), {
      ruleset_id: "readiness", current_version_id: receipt.current_version_id,
    }, frozen, [401, 403]);
    if (probe.status === 200 || probe.status === 409) throw new ProfileError("frozen_token_not_denied");
    const current = dataOf(await request("revoke-get", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const quietBase = journalCount(admission.journalPath);
    await observeQuiet(admission.journalPath, quietBase, async () => {
      await expectCode("revoke-refresh", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/refresh", metaOrigin), {
        expectedVersion: current.version, rowKey: JSON.parse(String(state.selectedKey)),
      }, metaToken, 401, "READINESS_SOURCE_LOGIN_REJECTED");
    });
    const after = dataOf(await request("revoke-reread", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const second = dataOf(await request("revoke-second", "GET", snapshotUrl(metaOrigin, bindingId, String(state.secondKey)), undefined, metaToken, 200));
    const cellsSame = cellDigest(after.row) === state.selectedCellsAfter;
    const prior = Number(state.bindingVersionAfter);
    if (staleRevokeOracle(String(after.status), Number(after.version), prior, after.canRefresh === true, cellsSame) !== "retained") {
      throw new ProfileError("revoke_not_stale");
    }
    if (cellDigest(second.row) !== state.secondCells || Number(second.version) !== prior + 1 || second.canRefresh !== false || second.status !== "stale") {
      throw new ProfileError("revoke_mutated_other_row");
    }
    const ecoBindingId = requireString(state.ecoBindingId, "eco_binding_missing");
    const ecoSibling = dataOf(await request("revoke-eco-sibling", "GET", snapshotUrl(metaOrigin, ecoBindingId), undefined, metaToken, 200));
    if (ecoSibling.status !== "active" || Number(ecoSibling.version) !== Number(state.ecoVersion) || ecoSibling.canRefresh !== true) {
      throw new ProfileError("revoke_staled_sibling");
    }
    if (cellDigest(ecoSibling.row) !== state.ecoCells) throw new ProfileError("revoke_mutated_eco_row");
    const sheetId = requireString(state.sheetId, "sheet_missing");
    const recordId = requireString(state.recordId, "record_missing");
    const record = recordBody(dataOf(await request("record-after-revoke", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    if (sourceDigest(record.data, state.sourceFieldIds) !== state.sourceDigestAfter) throw new ProfileError("revoke_mutated_source");
    assertLocals(record.data, state.localFields as Record<string, string>, String(state.metaUser), String(state.due), String(state.note));
    const comments = dataOf(await request("comments-after-revoke", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (commentDigest(comments.items) !== state.commentDigest) throw new ProfileError("revoke_mutated_comments");
    const history = dataOf(await request("history-after-revoke", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (historyDigest(history.items) !== state.historyDigestAfter) throw new ProfileError("revoke_mutated_history");
    stateSave(admission.statePath, { ...state, staleVersion: Number(after.version) });
    emit({ status: "CONTINUE", next_phase: "after_restore", runtime: "RUNNING" }, 10);
  }
  if (phase === "after_restore") {
    const restored = await loginNative(nativeOrigin, secret.native, "native-login-restored", 200);
    const restoredToken = requireString(restored.token, "native_token_missing");
    const restoredRules = new Set<string>();
    for (const ruleset of ["default", "readiness"]) {
      const payload = await nativeSource(nativeOrigin, restoredToken, String(receipt.item_id), "release-readiness", {
        ruleset_id: ruleset, current_version_id: receipt.current_version_id,
      }, "restore-readiness-" + ruleset);
      for (const ruleId of assertFamilies(resourcesFromNative(payload), receipt, String(receipt.mbom_name_delta))) restoredRules.add(ruleId);
    }
    if (restoredRules.size < 5) throw new ProfileError("diagnostic_rule_ids_lt_5");
    const current = dataOf(await request("restore-get", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    if (current.status !== "stale" || Number(current.version) !== Number(state.staleVersion) || current.canRefresh !== false) {
      throw new ProfileError("stale_binding_reactivated");
    }
    if (cellDigest(current.row) !== state.selectedCellsAfter) throw new ProfileError("stale_binding_reactivated");
    const quietBase = journalCount(admission.journalPath);
    await observeQuiet(admission.journalPath, quietBase, async () => {
      await expectCode("stale-refresh", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/refresh", metaOrigin), {
        expectedVersion: current.version, rowKey: JSON.parse(String(state.selectedKey)),
      }, metaToken, 409, "BINDING_NOT_ACTIVE");
    });
    const afterStaleRefresh = dataOf(await request("stale-refresh-reread", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    if (Number(afterStaleRefresh.version) !== Number(state.staleVersion) || cellDigest(afterStaleRefresh.row) !== state.selectedCellsAfter || afterStaleRefresh.status !== "stale") {
      throw new ProfileError("stale_refresh_mutated");
    }
    const beforeRelay = journalCount(admission.journalPath);
    const recoveryPreview = dataOf(await request("preview-readiness-recovery", "POST", new URL("/api/plm-collaboration-snapshots/preview", metaOrigin), {
      sourceKind: "readiness", dataSourceId: state.dataSourceId, baseId: state.metaBaseId, itemId: receipt.item_id, currentVersionId: state.version, rulesetId: "default", name: READINESS_RECOVERY_NAME,
    }, metaToken, 200));
    await journalPositive(admission.journalPath, beforeRelay, "positive_meta_relay_restored");
    const recovery = await confirmCreate(metaOrigin, metaToken, requireString(recoveryPreview.previewId, "preview_missing"), "confirm-recovery");
    if (recovery.bindingId === bindingId) throw new ProfileError("recovery_reused_stale_binding");
    const recoveryKey = JSON.stringify(readinessKeyOf(String(state.dataSourceId), secret.native, String(receipt.item_id), "default"));
    const recoveryGot = dataOf(await request("recovery-get", "GET", snapshotUrl(metaOrigin, requireString(recovery.bindingId, "recovery_binding_missing"), recoveryKey), undefined, metaToken, 200));
    if (recoveryGot.status !== "active" || recoveryGot.canRefresh !== true || recoveryGot.id === bindingId) {
      throw new ProfileError("recovery_not_active");
    }
    const denied = await loginMeta(metaOrigin, secret.denied_meta.identifier, secret.denied_meta.password);
    const foreign = JSON.parse(String(state.selectedKey)) as string[];
    foreign[3] = foreign[3] + "-foreign";
    const deniedBase = journalCount(admission.journalPath);
    await observeQuiet(admission.journalPath, deniedBase, async () => {
      await request("denied-matching", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, denied, 403);
      await request("denied-foreign", "GET", snapshotUrl(metaOrigin, bindingId, JSON.stringify(foreign)), undefined, denied, 403);
    });
    await expectCode("granted-foreign-item", "GET", snapshotUrl(metaOrigin, bindingId, JSON.stringify(foreign)), undefined, metaToken, 409, "ROW_KEY_MISMATCH");
    const unknown = JSON.parse(String(state.selectedKey)) as string[];
    unknown[4] = "w23-unknown-ruleset";
    const unknownGot = dataOf(await request("unknown-ruleset", "GET", snapshotUrl(metaOrigin, bindingId, JSON.stringify(unknown)), undefined, metaToken, 200));
    if (unknownRulesetShell(unknownGot.row, unknownGot.canRefresh) !== "empty_shell") throw new ProfileError("unknown_ruleset_not_shell");
    await expectCode("four-key", "GET", snapshotUrl(metaOrigin, bindingId, JSON.stringify(foreign.slice(0, 4))), undefined, metaToken, 422, "ECO_REQUEST_INVALID");
    const nonString = JSON.parse(String(state.selectedKey)) as unknown[];
    nonString[4] = 1;
    await expectCode("non-string-selector", "GET", snapshotUrl(metaOrigin, bindingId, JSON.stringify(nonString)), undefined, metaToken, 422, "ECO_REQUEST_INVALID");
    const repeated = snapshotUrl(metaOrigin, bindingId, String(state.selectedKey));
    repeated.searchParams.append("rowKey", String(state.selectedKey));
    await expectCode("repeated-selector", "GET", repeated, undefined, metaToken, 422, "ECO_REQUEST_INVALID");
    const disableSheetId = requireString(state.sheetId, "sheet_missing");
    const disableRecordId = requireString(state.recordId, "record_missing");
    const carriedDisable = requireHealthyCarry("disable", state.readinessCounts, READY_SOURCE_COUNTS);
    const countsBeforeDisable = await observeCounts("disable-before", bindingId, disableSheetId, disableRecordId, carriedDisable, QUIET_DELTA);
    const latest = dataOf(await request("disable-get", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const disabled = dataOf(await request("disable", "POST", new URL("/api/plm-collaboration-snapshots/" + bindingId + "/disable", metaOrigin), {
      expectedVersion: latest.version,
    }, metaToken, 200));
    const disablePrior = Number(latest.version);
    if (disabled.status !== "disabled" || Number(disabled.version) !== disablePrior + 1) throw new ProfileError("disable_not_local");
    const still = dataOf(await request("disable-reread", "GET", snapshotUrl(metaOrigin, bindingId, String(state.selectedKey)), undefined, metaToken, 200));
    const stillRow = still.row as Record<string, unknown> | null;
    if (!stillRow || stillRow.recordId !== state.recordId || still.status !== "disabled" || still.canRefresh !== false) {
      throw new ProfileError("disable_deleted_row");
    }
    if (Number(still.version) !== disablePrior + 1 || stillRow.capturedAt !== (latest.row as Record<string, unknown>).capturedAt || stillRow.businessHash !== (latest.row as Record<string, unknown>).businessHash) {
      throw new ProfileError("disable_changed_metadata");
    }
    if (!sameJson(stillRow.rowKey, (latest.row as Record<string, unknown>).rowKey)) throw new ProfileError("disable_changed_metadata");
    const sheetId = requireString(state.sheetId, "sheet_missing");
    const recordId = requireString(state.recordId, "record_missing");
    const record = recordBody(dataOf(await request("record-after-disable", "GET", recordUrl(metaOrigin, recordId, sheetId), undefined, metaToken, 200)));
    assertLocals(record.data, state.localFields as Record<string, string>, String(state.metaUser), String(state.due), String(state.note));
    const comments = dataOf(await request("comments-after-disable", "GET", commentListUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (commentDigest(comments.items) !== state.commentDigest) throw new ProfileError("disable_mutated_comments");
    if (sourceDigest(record.data, state.sourceFieldIds) !== state.sourceDigestAfter) throw new ProfileError("disable_mutated_source");
    const historyAfterDisable = dataOf(await request("history-after-disable", "GET", historyUrl(metaOrigin, sheetId, recordId), undefined, metaToken, 200));
    if (historyDigest(historyAfterDisable.items) !== state.historyDigestAfter) throw new ProfileError("disable_mutated_history");
    await observeCounts("disable-after", bindingId, disableSheetId, disableRecordId, countsBeforeDisable, QUIET_DELTA);
    await request("smoke-malformed-cookie", "GET", snapshotUrl(metaOrigin, bindingId), undefined, null, 401, { cookie: "session=owned-shape" });
    const header = Buffer.from("{}").toString("base64url");
    const typed = Buffer.from(JSON.stringify({ typ: "typed" })).toString("base64url");
    await request("smoke-malformed-typed-bearer", "GET", snapshotUrl(metaOrigin, bindingId), undefined, header + "." + typed + ".c2ln", 401);
    emit({
      status: "GREEN",
      runtime: "GREEN",
      profile_result: "GREEN",
      credential_negative: "malformed_credential_smoke",
    }, 0);
  }
  throw new ProfileError("phase_refused");
}

function main(): void {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: node --experimental-strip-types run.mts [--help|self-check|seed-meta --secret <path> --owned <path>|<admission.json>]\n" +
      "self-check and a missing admission are NOT_RUN and do not call fetch.\n" +
      "seed-meta requires the exact run secret and owned-resource paths. A missing pair exits NOT_RUN before any database import.\n" +
      "An owned secret proves the socket marker, current_database, then AuthService.register and fixture rows. It does not mint a JWT.\n" +
      "seed-meta does not write the Native license and does not call import_license.\n" +
      "The HTTP phase requires a verified owned-fixture signed import receipt. A bare true signature flag is refused.\n" +
      "Explicit null currentVersionId stays null. Cardinality SQL is read-only and self-check does not execute it.\n" +
      "Confirm, append, local PATCH, and comment require finite absolute owned counts before those counts are carried. A null count baseline is refused.\n" +
      "self-check is not an HTTP pass.\n",
    );
    process.exit(0);
  }
  if (arg === "self-check") {
    metaSelfCheck();
    return;
  }
  if (arg === "seed-meta") {
    seedMeta(process.argv.slice(3)).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : "Error";
      emit({ status: "RED", runtime: "RED", profile_result: "RED", reason: "meta_seed_" + name }, 1);
    });
    return;
  }
  if (!arg) emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "admission_file_required" }, 2);
  let admission: Admission;
  try {
    admission = JSON.parse(readFileSync(arg, "utf8")) as Admission;
  } catch {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "admission_unreadable" }, 2);
  }
  if (
    admission.ready !== true || admission.services_admitted !== true ||
    typeof admission.commit !== "string" || admission.commit.toLowerCase() === E3_PLANNING_COMMIT
  ) {
    emit({ status: "NOT_RUN", runtime: "NOT_RUN", reason: "admission_refused" }, 2);
  }
  runPhase(admission).catch((error: unknown) => {
    const reason = error instanceof ProfileError ? error.reason : "unhandled";
    emit({ status: "RED", runtime: "RED", profile_result: "RED", reason }, 1);
  });
}

main();
