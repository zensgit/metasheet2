# #6603 password-policy integration verification

## Source and scope

- Reviewed main: `17204e649462104abfdcbce20090620c93aaa65b`.
- Original PR head: `211ce5120c87e5a7f91cb2068b40b268191aae31`.
- Verified code commit: `54b830338cc9b47d2e04f941defe64630df58f65`.
- Verified source tree: `384bb681da5ac0bfd647d67ff47388d3e5265f21`.
- The merge preserves the original password-policy slice and current main. It does not include the department-head or organization-workspace features from #6589/#6592.
- No additional password-policy runtime fix was needed. Typed temporary passwords still fail policy before hashing, writes or session revocation; generated passwords retain their existing path.

## Local verification

Node 20.20.2 and pinned pnpm 10.16.1; isolated offline frozen-lockfile dependencies. No inherited database or service credentials were supplied. New-main native checks used an owned empty synthetic PostgreSQL 16.15 instance and synthetic transport only.

| Check | Result |
| --- | --- |
| Admin/reset/password/login backend suites, 3 files | 229 passed |
| Latest-main shutdown/webhook/capability/budget/encryption suites, 5 files | 132 passed |
| Admin/forced-change and latest-main webhook/owner-send web specs, 7 files | 330 passed |
| Plugin inventory and delivery-store contracts | 24 passed |
| Latest-main send-budget/authority/runtime contracts | 54 passed |
| Local-stub lifecycle canary contract | 249 passed |
| Latest-main approval and owner-send native DB suites, 2 whole files | 125 passed |
| `pnpm run validate:all` | passed |
| Clean tracked tree and whitespace | passed |

Evidence is retained privately in the task's publication verification directory; raw logs are not published. Grok 4.7 performed the earlier local integration, and Codex independently reviewed and revalidated this isolated PR slice against the newer main.

The first pre-push guard stopped because main advanced from `a8ab73bee8` to `17204e6494`; nothing was pushed then. The 21-path new-main delta has no overlap with this slice, merged automatically, and each incoming blob was verified unchanged. All focused checks above were rerun after integration. The native tests ran on macOS with containerized PostgreSQL, not a complete Linux CI runner; actual GitHub CI remains required.

## Remaining gate

Owner authorized commit, push and actual GitHub CI on 2026-11-06. This document records pre-publication local checks, not a claim of CI success. The documentation-only follow-up preserves the verified code tree. Keep the PR Draft; no merge, deployment, production access, real CI-variable change or branch-protection change is authorized.
