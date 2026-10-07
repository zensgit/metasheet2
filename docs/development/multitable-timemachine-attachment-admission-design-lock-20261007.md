# Time Machine G1 attachment metadata admission

Status: bounded source-writer closure fix. Baseline `027c0111592a49863ccd053b5f32e8fe7a72bac0`,
prerequisite Draft #6228. Parent D-H2/D-I0 remains authoritative. This is G1 from the frozen
source inventory; G2 cross-sheet reset and G3 retention remain OPEN.

## Required result

The actual POST /attachments route must stop adding attachment metadata while a committed archive
writer block owns its sheet. Existing authentication, permission, liveness, attachment field and
record-target rules remain. Preserve exact existing archive-source-protection selection: both
MULTITABLE_RECOVERY_ARCHIVE_ENABLED and MULTITABLE_ENABLE_WRITER_FENCE are literal true. Every
unselected/flag-OFF path retains the old storage method, SQL, response shape and error behavior,
without new transactions, fence reads or post-upload authorization calls. No new env flag.

Keep provider upload outside every owned DB transaction and fence. The existing storeAttachment
helper still performs upload, metadata INSERT and its existing best-effort cleanup on DB refusal.
A sibling admission module supplies the active path's metadata query/transaction. A short owned
READ COMMITTED transaction takes the canonical fence before business reads, checks the actual
transaction isolation, revalidates current authorized live sheet/target state using the same
server-authenticated principal and existing permission/type/row rules, refuses every durable writer
block including expired archiving, then performs the exact legacy metadata INSERT and commits.
No key/generation/pin/record mutation or owner bypass is granted to an ordinary upload.

A claim that arrives while upload is in flight must win metadata admission. A metadata writer that
wins the fence must commit first and enter the next claim's complete pin set. A bare preflight block
read, autocommit fence, or RR transaction is insufficient. Do not hold a provider call in the fence.
Unknown configuration/schema cannot silently permit the active protected insert. Preserve the
canonical normalized legacy flag and its compatibility semantics globally; no global guard change.
D7 migration/cold-process qualification remains separate.

Guard/refusal HTTP errors are closed and values-free, reuse the normal 409 writer-block response,
and do not log private sheet/state/locator/user values. Metadata refusal deletes only the just-uploaded
object through the existing helper outside the ended transaction; existing pinned objects remain
untouched. Failed cleanup remains the existing best-effort outcome, not proof that no orphan exists.
Do not build a new cleanup worker, provider adapter, public input port or configurable bypass.

Review-qualified amendment before implementation: an INSERT may have completed and COMMIT may have
reached PostgreSQL while its acknowledgement is lost. Treat rejection after the metadata callback has
completed as commit-uncertain; return a closed values-free failure, never claim successful commit or
retry automatically, and withhold provider deletion of that object. A fresh claim can already pin it.
Only a module-private identity marker may select this exception, never a caller-supplied bypass.
The existing cleanup remains for known callback/rollback refusals. This requires a surgical change
to storeAttachment's catch, without changing any unselected path or adding a worker/provider port.
Actual commit-then-lost-ACK HTTP fault must prove the committed row/object survive and a subsequent
genuine archive claim pins the object; a known rollback still deletes only the just-uploaded object.

New logic belongs in a sibling module. Keep the mega route edit to dependency wiring and error mapping.
No unrelated validation/security/formatting refactor, migration, flag, provider/key operation, nonce,
archive publication, prune or staging action in this slice.

## Gates

| Gate | Required evidence | State |
| --- | --- | --- |
| Real HTTP refusal | Draft and record-bound POST with genuine committed archiving; exact409/body and zero metadata/record/pin changes | OPEN |
| Ordering | Upload completion vs claim in both orders, actual fence wait, writer-winning row in claim pin set | OPEN |
| Revalidation | Sheet/field/record/permission drift after upload but before insert refuses under fence | OPEN |
| IO/cleanup | Upload and exact newly uploaded object cleanup outside transaction; known rollback cleans only new object; true committed/lost-ACK preserves row/object for subsequent genuine pin; cleanup failure remains best effort | OPEN |
| Flag parity | All unselected literal/absent flag combinations exact old query/storage/response behavior | OPEN |
| Refutation/CI | Neutered guards matching real race RED, restored PASS; focused neighbors and whole realDB wiring/fail-not-skip | OPEN |
| Full writer closure | G2/G3 and all source/worker/deleter races | OPEN |
| Complete D-H2/D-L/D7 and owner stages | Object/crypto/finalize/abandonment, lifecycle, exact-SHA ratification, merge/flags/deploy/staging | OPEN |
