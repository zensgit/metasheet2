# Capabilities Policy

## Naming
- Format: `domain:action`
- Lowercase alphanumeric + dashes only.
- One logical permission unit – do not overload (avoid `data:all`).

## Registration
- Call `registerCapability('domain:action')` (future API) only after manifest load.
- Every registered key MUST appear in CAPABILITIES_MATRIX.md in same PR.

## Grouping
- Use domain prefixes for related functionality (e.g. `kanban:*`, `workflow:*`).
- Avoid deep hierarchies (`workflow:run:start` → prefer `workflow:run`).

## Deprecation
- Mark row in matrix as `deprecated`; keep historical reference.
- Do not reuse deprecated keys for new semantics.

## Enforcement Levels
| Level | Behavior | When |
|-------|----------|------|
| log-only | warn if missing | initial rollout |
| soft-fail | block staging if missing | after baseline adoption |
| hard-fail | CI failure | mature / stable phase |

## Security Guidelines
- Never treat capability strings as executable logic (pure labels).
- Capability checks must be centralized (no scattered ad-hoc checks).
- Avoid wildcard grants; explicit listing only.

## Future Enhancements
- Capability → RBAC role mapping generation.
- Matrix auto‑sync to docs site.
- Static analyzer to catch unregistered use.

