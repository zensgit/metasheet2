# #6603 password-policy integration verification

## Source and scope

- Reviewed main: `a8ab73bee80a5ac5a8f7fca11d581d25e7cce198`.
- Original PR head: `211ce5120c87e5a7f91cb2068b40b268191aae31`.
- Verified code commit: `98de0ae53cb637619440b803272c7814c11054ca`.
- Verified source tree: `057b1cec9e787cde5feb557a35eae5418025b921`.
- The merge preserves the original password-policy slice and current main. It does not include the department-head or organization-workspace features from #6589/#6592.
- No additional password-policy runtime fix was needed. Typed temporary passwords still fail policy before hashing, writes or session revocation; generated passwords retain their existing path.

## Local verification

Node 20.20.2 and pinned pnpm 10.16.1; isolated offline frozen-lockfile dependencies. No inherited database or service credentials were supplied.

| Check | Result |
| --- | --- |
| Admin/reset/password/login backend suites, 3 files | 229 passed |
| Latest-main shutdown/webhook/capability suites, 3 files | 80 passed |
| Admin/forced-change and latest-main webhook web specs, 6 files | 275 passed |
| Plugin inventory and delivery-store contracts | 24 passed |
| Local-stub lifecycle canary contract | 249 passed |
| `pnpm run validate:all` | passed |
| Clean tracked tree and whitespace | passed |

Evidence is retained privately in the task's publication verification directory; raw logs are not published. Grok 4.7 performed the earlier local integration, and Codex independently reviewed and revalidated this isolated PR slice against the newer main.

## Remaining gate

Owner authorized commit, push and actual GitHub CI on 2026-11-06. This document records pre-publication local checks, not a claim of CI success. The documentation-only follow-up preserves the verified code tree. Keep the PR Draft; no merge, deployment, production access, real CI-variable change or branch-protection change is authorized.
