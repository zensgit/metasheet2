# Multitable Pilot Feedback - Day 2-3

## Feedback Metadata

- Date: 2026-03-20
- Reporter: Claude (automated pilot tester)
- Role: Pilot test executor (Team A + B combined)
- Environment: macOS 15 / Node 24.10 / PostgreSQL 16.9 / nginx 1.29.6 / PM2 6.0.14
- Package: metasheet-multitable-onprem-v2.5.0-local-20260320

## Scenario Results Summary

### Scenario 1: 多人编辑与 version conflict

| Test Case | Result | Notes |
|-----------|--------|-------|
| Single user cell write | ✅ PASS | 4 cells written and read back correctly |
| Single user cell overwrite | ✅ PASS | Updated values persisted |
| Second user creation | ✅ PASS | Admin can create users via API |
| Second user login | ✅ PASS | Token issued correctly |
| Second user cell write | ❌ FAIL | "Insufficient permissions" - RBAC blocks non-admin |
| Concurrent same-cell write | ⚠️ CONCERN | Last-write-wins, no conflict detection |
| Data persistence after restart | ✅ PASS | All 2305 cells survive PM2 restart |

**Verdict**: Core editing works for admin users. Multi-user collaboration blocked by RBAC. No conflict detection mechanism exists at API level - this is a **design gap**, not a bug.

### Scenario 2: link / attachment / comments

| Test Case | Result | Notes |
|-----------|--------|-------|
| Create comment on cell | ✅ PASS | Comment created with spreadsheetId + rowId |
| Reply to comment | ✅ PASS | Thread preserved (but parentId extraction fragile) |
| List comments by spreadsheet | ✅ PASS | Filtering works correctly |
| Resolve comment | ✅ PASS | resolved=true persisted |
| File upload (attachment) | ❌ FAIL | "multer not installed" |
| List files | ✅ PASS | Returns empty list (no files uploaded) |
| File download | ⛔ BLOCKED | No files to download |

**Verdict**: Comments fully functional. File upload completely broken - multer dependency missing from package.

### Scenario 3: search / 大表分页

| Test Case | Result | Notes |
|-----------|--------|-------|
| Bulk write 100 rows (300 cells) | ✅ PASS | HTTP 200 |
| Bulk write 1000 rows (2000 cells) | ✅ PASS | 378ms |
| Read 2305 cells | ✅ PASS | 56ms |
| Server-side search | ❌ N/A | No search endpoint exists |
| Server-side pagination | ❌ N/A | No limit/offset support |
| Range query (startRow/endRow) | ❌ FAIL | Params ignored, all cells returned |

**Verdict**: Performance is excellent for current scale. No server-side search or pagination - this is a **missing feature**, acceptable for pilot (<5K rows) but required for production.

### Scenario 4: 安装 / 升级 / 回滚

| Test Case | Result | Notes |
|-----------|--------|-------|
| Snapshot creation | ✅ PASS | ID returned, creation fast |
| Snapshot listing | ❌ FAIL | Returns empty despite snapshots existing |
| Destructive overwrite | ✅ PASS | Cells overwritten as expected |
| Snapshot restore | ❌ FAIL | Reports success but itemsRestored=0, data unchanged |
| PM2 restart (upgrade sim) | ✅ PASS | Online in <3s, health OK |
| Data persistence after restart | ✅ PASS | 2305 cells intact |
| Re-login after restart | ✅ PASS | Token still valid |

**Verdict**: PM2 lifecycle management works well. Snapshot-based rollback is broken - create works but restore doesn't actually restore data. This undermines the upgrade/rollback story.

## Overall Assessment

### What Works Well
1. **Cell CRUD**: Fast, reliable, data persists across restarts
2. **Comments**: Full lifecycle (create → reply → resolve) works
3. **PM2 management**: Start, restart, save all reliable
4. **Health monitoring**: /health endpoint comprehensive
5. **Auth**: Login, JWT, session management all functional
6. **Performance**: Sub-second for 2000+ cell operations

### What Needs Fixing Before Pilot Can Continue

| Priority | Issue | Impact | Fix Effort |
|----------|-------|--------|------------|
| **P1** | Multer not in package | Attachment testing blocked | 1h - add dependency |
| **P1** | Snapshot restore broken | Rollback story invalid | 4h - debug restore logic |
| **P1** | No conflict detection | Silent data loss risk | 8h - add version/ETag |
| P2 | RBAC: user can't write cells | Multi-user testing blocked | 2h - role permissions |
| P2 | No search API | Frontend-only search | Backlog |
| P2 | No cell pagination | Full load always | Backlog |
| P2 | Snapshot list empty | Can't browse snapshots | 2h - fix query |

### Recommendation

**Pilot status: CONDITIONAL CONTINUE**

- Fix P1 items (multer, snapshot restore) before Day 4
- RBAC fix needed to unblock multi-user Day 4-5 testing
- Conflict detection is a design decision - document current behavior as "last-write-wins" for pilot scope
- Search/pagination are acceptable as-is for pilot (<5K rows)

### Performance Baseline

| Operation | Size | Time | Acceptable |
|-----------|------|------|------------|
| Bulk cell write | 2000 cells | 378ms | ✅ Excellent |
| Full cell read | 2305 cells | 56ms | ✅ Excellent |
| Comment create | 1 comment | <50ms | ✅ |
| PM2 restart to healthy | - | ~3s | ✅ |
| Login | - | <100ms | ✅ |
