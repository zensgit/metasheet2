# MetaSheet — Next Phase Backlog (Post-RC 202605)

Prioritized list of work items following the 8-week Feishu gap closure sprint.

| # | Item | Priority | Effort | Dependencies | Description |
|---|------|----------|--------|-------------|-------------|
| 1 | Real-time collaborative editing (CRDT/OT) | P0 | XL | WebSocket infra, conflict resolution design | Enable multiple users to edit the same cell simultaneously with operational transform or CRDT-based merging. Foundation for true multi-user spreadsheet experience. |
| 2 | Complex automation DAG designer | P1 | L | Automation v1 (done), frontend graph library | Replace linear action chains with a visual directed acyclic graph editor. Support branching (if/else), parallel paths, and loop constructs. |
| 3 | Template marketplace | P1 | L | Sheet CRUD (done), packaging format design | Allow users to publish and install pre-built sheet templates (e.g., CRM, Project Tracker, HR Onboarding) with bundled fields, validations, automations, and charts. |
| 4 | Advanced BI / analytics | P1 | XL | Charts v1 (done), data warehouse connector | Pivot tables, cross-sheet joins, calculated measures, and drill-down capabilities. Potentially backed by a columnar query engine for large datasets. |
| 5 | Mobile-optimized views | P2 | L | Responsive CSS framework, touch gesture library | Card-based record view, swipe actions, and offline-capable PWA shell for field workers. |
| 6 | Batch import/export improvements | P2 | M | Existing CSV import, streaming parser | Support Excel (.xlsx), large-file streaming (100k+ rows), column mapping wizard, duplicate detection, and scheduled auto-import from cloud storage. |
| 7 | Audit log UI | P2 | M | Audit log backend (done) | Searchable timeline of all mutations (record edits, permission changes, automation runs) with user filtering, date ranges, and diff viewer. |
| 8 | Custom field types (plugin-based) | P2 | L | Plugin system v1 (done), field type registry | Allow third-party developers to register new field types (e.g., barcode, GPS coordinate, color picker) via the plugin API. |
| 9 | Row-level permission UI improvements | P3 | S | Record permissions backend (done) | Visual rule builder for row-level access: "Users in group X can only see records where Assignee = themselves." Currently backend-only. |
| 10 | Multi-language support (i18n) | P3 | M | Vue i18n setup, translation pipeline | Full internationalization: UI strings, validation messages, email templates, and date/number formatting for zh-CN, en-US, ja-JP at minimum. |

## Priority Definitions

| Level | Meaning |
|-------|---------|
| P0 | Must-have for next milestone — blocks key use cases |
| P1 | High value — planned for next quarter |
| P2 | Important — scheduled after P0/P1 completion |
| P3 | Nice-to-have — backlog, pick up when capacity allows |

## Effort Estimates

| Size | Rough Duration (1 engineer) |
|------|----------------------------|
| S | 1-2 days |
| M | 3-5 days |
| L | 1-3 weeks |
| XL | 4-8 weeks |

## Sequencing Notes

- Items 1 and 4 are the largest and most impactful; consider running them in
  parallel with dedicated sub-teams.
- Item 2 (DAG designer) builds on the automation engine from Week 6; the
  backend can be extended incrementally.
- Item 3 (templates) is mostly a packaging/distribution concern and has minimal
  backend risk.
- Items 7 and 9 are backend-complete and need only frontend work.
- Item 10 (i18n) should be started early in the quarter to avoid accumulating
  hard-coded strings.
