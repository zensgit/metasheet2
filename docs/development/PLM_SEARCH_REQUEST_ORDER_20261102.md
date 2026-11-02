# PLM overlapping product search request ownership

Exact parent: `975c0c9da9ed9645e699cde48bd2281254d98d68`. Source commit: `68f8ad2cd4fba09d7aa04d116afc661b71c1757e`. Static implementation only; the seven-package master goal remains OPEN.

A normal manual search A may remain pending when a same-component route query change invokes the existing autoload entry for B. Before this change, a later completion of A replaced B rows/total and could publish an old error/auth callback or clear B loading. The disabled manual button does not serialize that route entry.

`usePlmSearchPanel` now captures one instance-local request generation per invocation. The latest started invocation owns success, catch and finally publication. Query arguments, fallback items/total, row actions and latest-error retention of previous rows remain unchanged. The route/reset/unmount and draft-input policies keep their existing behavior.

The original full 3454-byte spec is an exact unchanged prefix. One appended describe defines four finite deferred-service cases: newer success then older success; older success while the newest call remains pending; stale rejection after newest success; and latest failure before older success with previous rows/total and current error/auth retained. Array assertions use deep equality for Vue refs and A/B totals are distinct. These composable cases do not execute the route or a browser.

Static evidence:

- Source 4950B/SHA256 `330f3980c22214d05e7e625f3aca108c8e5a1e0ac6914c6291ca25c2dcf847ca`; 11 added/1 deleted. Removing only the generation guards reconstructs the entire original 4627B exactly.
- Spec 12232B/SHA256 `85000ec06503a1ce9c5106ef48cb62fa66fec528c59bb5e2367f0ba52f0052d6`; original prefix exact, four new definitions.
- Final six-member capsule ZIP SHA256 `b975a1ccbbcf155078199166f62d78cf9bd015adc42c004784a09217a7e28293`/11908B; three readonly inputs exact.
- Root source delta from Grok: NONE. Independent v2 delta review SHA256 `b2568ead671b78074e1827b70c44cecf17b6be176f2e8a83f443e544101ec815`, blockers `[]`; unchanged source review is reused by exact v1/v2 hash. Git diff whitespace check passed.
- Grok requested `4.7/high`; literal CLI observed `Grok 4.7/xhigh`; backend deployment ID UNKNOWN. Author actual model/effort remain UNKNOWN and are separate from Root's footer evidence. V1 test-identity/total and report-profile findings were corrected through the same owned session.
- Session `gbt-5e78-1a19ade20dd-d`/PID26752 reached done/STOP. All six final hashes were rechecked before owned close. Runtime server/parent and other jobs were preserved. Selected TUI snapshots showed ignored 2000ms post-tool-hook timeouts; they are retained observations, not a full-trace/global-idle proof.

All product unit tests, type/import checks, build/install, HTTP/PG, browser/IdP and business acceptance are NOT_RUN for this new source. Parent 6689 exact975 green CI qualifies only that parent. No new push/PR/CI/dispatch occurred. Source and this single closeout document are local commits; later results belong in records/state/PR body. N2 and every HOLD remain retained; Draft-only publication, merge/deployment/production notification/issue-close restrictions remain.
