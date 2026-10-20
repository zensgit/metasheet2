# Source-management permission catalog

The installed Native79ab/MetaAF package's actual `GET /api/permissions` returned neither `data_sources:read` nor `data_sources:write`. Existing source routes require these codes, but ordinary administrator grant and role APIs reject identifiers absent from the catalog. A generic RBAC403 therefore cannot establish that the separate Visual platform-admin guard was reached.

Register only the two existing management identifiers. Do not grant them to any user or role, change namespace admission, bypass source ownership or broaden Visual approval. Existing explicit administrator grant and namespace-admission APIs remain the provisioning path. Registration preserves pre-existing wording. Rollback intentionally retains these stable identifiers and any later grants; it cannot cascade-delete administrator decisions or rows that predate the migration. `data_sources:execute` and default-role policy are outside this repair.

Verification uses an owned PostgreSQL schema with the actual migration and cascading permission foreign keys: absent catalog to both entries; repeated up with no grants; pre-existing wording and unrelated rows preserved; explicit role/user grants preserved by down and subsequent up. This narrow migration proof does not establish installed nonadmin HTTP admission or Visual refusal. Those require a newly built fixed-source package and positive owner actions around the negative cases.

The prior installed82 browser, concurrency, unlink and coupled-restore evidence remains bound to MetaAF and Native79ab. It cannot certify this new source. Full goal acceptance and serial Draft publication remain pending; no merge or deployment.
