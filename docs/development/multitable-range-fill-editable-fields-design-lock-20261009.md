# Range copy for editable field types

Date: 2026-10-09. Owner follow-up to PR #6271: support multi-select and people, then extend drag-copy beyond the original six scalar field types. This extends the existing range-fill lock; default-OFF, visible/loaded cells, 1,000 destinations, atomic patch, version/permission checks and no automatic retry remain unchanged.

## Behavior

- Copy mode supports all current editable data field types: string, number, boolean, date, dateTime, select, multiSelect, person, link, attachment, currency, percent, rating, duration, url, email, phone, barcode, qrcode, location and longText. Formula/lookup/rollup, system-generated fields, button actions, unknown types, masked/hidden/mirror/readonly fields remain non-writable.
- Copy replaces the complete destination value, including arrays. Never append selections or guess people from display names. Multi-select values must exist in the destination options. People retain user IDs; the server resolves sheet membership and member-group restrictions and enforces single-person limits. Arrays and objects are captured by value at drag start and request submission, never shared with source cells or other destinations.
- Horizontal copies require the same field type. Links (including legacy link-backed people) additionally require the same referenced sheet and reference kind; copying IDs must never silently retarget a different entity. Target single-item limits still apply. Attachments copy existing attachment references, not upload/recreate files; the existing server attachment authorization and binding rules remain authoritative.
- Clipboard roundtrips for multi-select/people use the existing TSV quoting with JSON arrays inside cells. Empty clipboard cells clear optional array fields to `[]`; required fields reject empty arrays. Commas/newlines inside an option are not separators. Plain names are not automatically resolved to people. Other editable types preserve their canonical value representation; invalid clipboard shapes fail before writing when locally detectable.
- Series remains number/date only. This extension does not add series inference for people, options, text, attachments or links.
- Server validation remains authoritative for field-specific limits, member eligibility, link targets and attachments. Invalid target values reject the entire batch. A successful response must project canonical values and readable person/link/attachment summaries without overwriting a newer revision or another view. No backend API expansion, migrations or weakened authorization.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| E1 | Planner table covers all editable types; read-only/system/button/unknown and incompatible-type negatives; select/member cardinality, required empties, structured TSV and immutable values |
| E2 | Real grid mouse/clipboard tests for multi-select and native people, plus representative structured/linked fields; pending source mutation cannot alter captured values |
| E3 | Writer atomic request, deep capture, server rejection, canonical projection/display, navigation and newer-revision races; original scalar behavior preserved |
| E4 | Real JWT/PostgreSQL planner-to-route tests for multi-select/person and representative extended types; nonmember/group/cardinality/option failures leave values, versions and history unchanged |
| E5 | Existing feature specs remain in both frontend CI lists and the real-DB file remains in its post-migration job; focused + neighboring suites, guard mutation, app type check/build, synthetic browser evidence |
| E6 | Independent code review, development/verification MD and updated Draft PR; report CI separately for the new head, never reuse earlier green checks as new-head evidence |

The user authorized this functional extension. Merge, staging/production deployment and feature enablement are separate release actions.
