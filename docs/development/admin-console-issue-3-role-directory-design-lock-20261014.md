# Admin issue3 — role directory members and Chinese presentation

Owner-authorized part of the five-issue goal. Source baseline: latestmain2fc0527 (product code unchanged fromec8d97), owned candidateb611120d40. Parent freshly searched main: no role-member API/panel or builtin role presentation implementation found. No publication/deployment/customer reads/real CI variable or protection changes.

The supplied screenshot shows member counts in the role catalog and English names/descriptions in its permission mapping. The catalog currently has no stored role-description field; do not add a column or rewrite global seeds.

## Contract

- Selected existing role displays its actual members' names with bounded pagination. Include all persisted members, including inactive accounts; membership is not login eligibility. Names use existing local user records only, with stable fallback when a name is absent. Minimum response identity/display fields; no mobile, password, tokens or extra organization directory data.
- New read uses exactly existing GET `/api/admin/roles` authority: `authenticate` plus exported `ensurePlatformAdmin` (legacy platform claim or live RBC administrator). Global platform administrators may inspect members across organizations. Ordinary/delegated users remain refused, even if they hold generic `roles:read`. Guard/query failures must be caught; unavailable storage is not a healthy empty roster.
- Parametrize role id and bounded page/pageSize; reuse existing pagination conventions. A single consistent query/snapshot supplies existence, total and ordered page, including total on an empty/out-of-range page. Missing role is404; healthy zero-member role differs from failed/unread data. No mutation, new feature flag, migration or external provider fetch.
- Role/page switches clear the previous list and bind replies, errors and loading state to the initiating role/page generation (includingA→B→A). Refresh failure shows unavailable, not “no members”. Keep role CRUD, permission reconciliation and version tokens intact.
- Present first-party builtin role names and the role page's builtin permission names/descriptions in Chinese. Stable role/permission IDs and custom labels/descriptions remain unchanged. Whitelist verified first-party defaults/aliases; unknown and prototype-like ids fall back safely. Do not translate arbitrary user text or silently save translated default names. Permissions-only save must preserve the original stored name; an explicit name edit remains possible. No database role-description column, global seed rename or broad i18n framework.

## Proof and deliverables

Focused mounted UI and backend tests plus existing role-save/search neighbors; shared guard positive/negative cases, real two-organization synthetic API/DB pagination and empty/missing/unavailable cases; controlled delayed UI response/read-failure negatives; native browser Chinese presentation/member roster and name-preserving save; mutation guards; OpenAPI build/guard for the new API; new web specs wired into domain guard plus required sorted web chain; validate:all; independent Sol review. Preserve all existing test-chain lines. Development/verification MD, local concern commits and PR material; public branch/PR requires owner approval. Restore all445-table baseline and stop owned test processes after qualification.
