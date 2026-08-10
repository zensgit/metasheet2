'use strict'

// #4556 W4C-0 follow-up — owner ruling on the report-sync job control-plane writes (#4835 lane):
// "四处 report-sync job 写入按 migrations-derived 域和 exact-site 方式纳管为 operational
// control plane，不删除、不作宽泛债务豁免。"
//
// Derives the `plugin_attendance_*` table domain MECHANICALLY from migration files, instead of a
// hand-kept list. `isAttendanceOwnedCandidate` in collector.cjs only recognises the `attendance_`
// prefix and a short named shared-table set — `plugin_attendance_*` tables are invisible to it by
// construction (see collector.cjs's own header; this module does NOT change that function or its
// callers — widening it would change what `provePinnedBaselineObligation` regenerates from the
// pinned e0defbe26 ref and red a baseline-reproducibility leg this task must not touch).
//
// Migration locations are discovered the same way collector.cjs finds runtime roots
// (`discoverRuntimeRoots` — workspace/package manifests, not a hand-picked path), narrowed to any
// directory literally named `migrations` under those roots. Two CREATE TABLE forms are
// recognised:
//   - kysely schema builder:  db.schema.createTable('name')  /  .createTable("name")
//   - raw SQL (template or plain string): CREATE TABLE [IF NOT EXISTS] "name" / name
//
// What this derivation MISSES — stated, not silently assumed away (this is the finding the
// owning repo cares about most for a domain derivation, not the count itself):
//   - a table created OUTSIDE any migration file: a runtime installer step, a DBA hand-run
//     script, an ORM sync-on-boot path. This derivation only reads migration source text.
//   - a table whose full name is assembled at migration-RUN time, e.g.
//     `` sql`CREATE TABLE ${dynamicName}` `` where `dynamicName` is not a literal in the
//     migration file itself. No migration in this repo does that for `plugin_attendance_*`
//     today (verified by scan), but the derivation cannot see through it if one did.
//   - a CREATE VIEW (kysely `.createView(...)` or raw `CREATE VIEW`) — a view is not a table and
//     this derivation does not enumerate views at all.
//   - a table later renamed via `.renameTable(oldName, newName)` (or raw `ALTER TABLE ... RENAME
//     TO`): the derivation records the name AS CREATED, not the name as of the newest migration.
//     A rename leaves the OLD name in the domain and the NEW name absent, unless the new name is
//     independently created by its own CREATE TABLE (it never is for a rename).
//   - a table later DROPPED: the derivation does not subtract dropped tables, so the domain can
//     be over-inclusive. That is the SAFE direction (nothing can write to a dropped table), so it
//     is left as-is rather than "fixed" by tracking DROP TABLE too.
//   - execution reality: this is a TEXTUAL derivation (what a migration file's source SAYS it
//     creates), not a trace of what actually ran against any given database. It does not
//     distinguish a migration that is excluded from a CI run (MIGRATION_EXCLUDE) or converted to
//     a no-op history marker (SUPERSEDED_LEGACY_SQL_MIGRATIONS in migration-provider.ts) from one
//     that executes today — an excluded/no-op migration's CREATE TABLE text still contributes a
//     name here.
//   - the legacy raw-SQL migration directory (`packages/core-backend/migrations`, numbered .sql
//     files superseded by the modern `src/db/migrations` timestamp stream) is scanned too and, as
//     of this derivation, contributes zero `plugin_attendance_*` names — but a future addition
//     there would be picked up, which is the intended mechanical behaviour, not an oversight.

const path = require('path')
const { discoverRuntimeRoots, maskCommentsForDmlScan } = require('./collector.cjs')

const KYSELY_CREATE_TABLE_PATTERN = /\.createTable\(\s*(['"])([a-zA-Z0-9_]+)\1/g
const RAW_SQL_CREATE_TABLE_PATTERN =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/gi

const PLUGIN_ATTENDANCE_TABLE_NAME_PATTERN = /^plugin_attendance_[a-z0-9_]+$/

const SCANNABLE_MIGRATION_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs', '.sql'])
const MIGRATION_WALK_PRUNE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage'])
const MAX_MIGRATION_WALK_DEPTH = 8

// Strips `--` line comments in a PLAIN SQL file. maskCommentsForDmlScan's `--`-inside-template
// masking only fires inside a JS/TS backtick template; a bare `.sql` migration file has no
// backticks at all, so its `code`-mode path would leave `--` comments live. This is a small,
// self-contained complement for that one file type — not a duplicate of anything exported.
function stripPlainSqlLineComments(text) {
  return String(text ?? '').replace(/--[^\n\r]*/g, (m) => ' '.repeat(m.length))
}

function maskForDomainScan(relPath, content) {
  return path.posix.extname(relPath) === '.sql'
    ? stripPlainSqlLineComments(content)
    : maskCommentsForDmlScan(content)
}

// Any directory literally named `migrations` found under a discovered workspace root. Does not
// descend further once inside one (a nested "migrations" dir inside a migrations dir would be
// pathological, not a real case this repo has).
function findMigrationDirs(source, roots) {
  const dirs = []
  function walk(dirRel, depth) {
    if (depth > MAX_MIGRATION_WALK_DEPTH) return
    const base = path.posix.basename(dirRel)
    if (base === 'migrations') {
      dirs.push(dirRel)
      return
    }
    for (const child of source.listDir(dirRel)) {
      if (MIGRATION_WALK_PRUNE_DIRS.has(child)) continue
      walk(dirRel ? `${dirRel}/${child}` : child, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  return [...new Set(dirs)].sort()
}

function tablesCreatedInFile(relPath, content) {
  const masked = maskForDomainScan(relPath, content)
  const names = new Set()
  KYSELY_CREATE_TABLE_PATTERN.lastIndex = 0
  let m
  while ((m = KYSELY_CREATE_TABLE_PATTERN.exec(masked))) names.add(m[2])
  RAW_SQL_CREATE_TABLE_PATTERN.lastIndex = 0
  while ((m = RAW_SQL_CREATE_TABLE_PATTERN.exec(masked))) names.add(m[1])
  return names
}

// Walks every discovered migration directory and returns EVERY table any migration file's source
// text creates (not filtered to plugin_attendance_* yet) plus provenance, so a caller can audit
// the full derivation, not just the narrowed domain.
function deriveAllCreatedTables(source) {
  const roots = discoverRuntimeRoots(source)
  const migrationDirs = findMigrationDirs(source, roots)
  const creatingFiles = new Map() // table -> relPath[]
  const scannedFiles = []
  for (const dir of migrationDirs) {
    for (const relPath of source.listAllFiles(dir)) {
      const ext = path.posix.extname(relPath)
      if (!SCANNABLE_MIGRATION_EXTENSIONS.has(ext)) continue
      const content = source.readFile(relPath)
      if (content == null) continue
      scannedFiles.push(relPath)
      for (const table of tablesCreatedInFile(relPath, content)) {
        if (!creatingFiles.has(table)) creatingFiles.set(table, [])
        creatingFiles.get(table).push(relPath)
      }
    }
  }
  return { creatingFiles, migrationDirs, scannedFiles }
}

// Narrows deriveAllCreatedTables' output to the plugin_attendance_* domain.
function derivePluginAttendanceTableDomain(source) {
  const { creatingFiles, migrationDirs, scannedFiles } = deriveAllCreatedTables(source)
  const domainCreatingFiles = new Map()
  for (const [table, files] of creatingFiles) {
    if (PLUGIN_ATTENDANCE_TABLE_NAME_PATTERN.test(table)) domainCreatingFiles.set(table, files)
  }
  return {
    tables: [...domainCreatingFiles.keys()].sort(),
    creatingFiles: domainCreatingFiles,
    migrationDirs,
    scannedFileCount: scannedFiles.length,
  }
}

module.exports = {
  PLUGIN_ATTENDANCE_TABLE_NAME_PATTERN,
  findMigrationDirs,
  deriveAllCreatedTables,
  derivePluginAttendanceTableDomain,
}
