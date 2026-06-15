# Multitable rich-text `longText` — design-lock (XSS-safe by construction)

- Status: DESIGN-LOCK (docs-only, no code). Review before impl.
- Date: 2026-06-14
- Scope: add formatted (rich-text) content to the multitable `longText` field — the **first HTML / formatted-content surface** in multitable. The XSS / sanitization model is the heart of this design.
- Branch: `docs/multitable-richtext-longtext-design-20260614`

## 1. Where we are today (code-grounded)

`longText` is **plain text** end to end — there is no formatting, no HTML, no markup anywhere in the path:

- **Type / property** — `field-codecs.ts:25` (union member), `:147` (alias normalize), `:371` (`sanitizeProperty` passes the property object through unchanged for `longText`).
- **Write validation** — `validateLongTextValue` (`field-codecs.ts:510`) only asserts `typeof value === 'string'` and returns the value verbatim. It is the **single validator** invoked from all four record write call sites: `record-service.ts:551`, `record-service.ts:875`, `record-write-service.ts:489`, `record-write-service.ts:643`.
- **Render** — `MetaCellRenderer.vue:7` renders with `{{ displayValue }}` (Vue mustache = HTML-escaped). The cell editor is a `<textarea>` (`MetaCellEditor.vue:57`); the drawer is a `<textarea>` (`MetaRecordDrawer.vue:124`); the form view is plain (`MetaFormView.vue:41`).
- **No `v-html` exists anywhere in `apps/web/src/multitable`** (verified by grep). Multitable has never rendered raw HTML.
- **No HTML sanitizer or rich editor in the repo** — grep for `sanitize` finds only SQL-identifier sanitizing (`*Adapter.ts`) and config secret redaction (`config.ts`); `jsdom@^27` is a **devDependency of `apps/web` only** (vitest), not a backend dependency.
- **Export / search read the value as a string** — `xlsx-service.ts` coerces each cell with `String(value)`; record query/filter treats the field value as text.

Implication: introducing rich text means introducing the **first `v-html` render** in multitable. That — not storage — is the new attack surface.

## 2. The spine: XSS-safe by construction = TWO chokepoints

The invariant is that **no stored value can contain executable content, and no render can re-introduce it.** That requires two load-bearing points, and nothing else in the system touches raw HTML:

1. **Write chokepoint (server, authoritative).** Sanitize *inside* `validateLongTextValue` so all four write call sites are covered by one function — no route, automation, or API token write can bypass it. The stored value is **inert by construction**: a malicious paste or a direct API write is neutralized at the write path before it ever reaches the DB. The client is never trusted.

2. **Render chokepoint (client, defense-in-depth).** Exactly **one** new sanitized rich-render component owns the **only** `v-html` in multitable, and it **re-sanitizes client-side before binding**. Server-sanitize alone is *not* sufficient: the browser's HTML parser can mutate server-clean markup on re-parse (mutation-XSS / mXSS). The render component re-runs an allow-list sanitizer (DOMPurify) on every bind so a parser-introduced breakout is neutralized too.

> "By construction" is earned only if the design names a single `v-html` owner and a single write sanitizer. It does. Editors (textarea → rich editor) emit structured HTML but are never a trust boundary — the server re-sanitizes on write regardless of what the editor produces.

## 3. Storage shape — sanitized HTML on write

**Decision: store sanitized HTML** (constrained allow-list), not markdown, not a structured AST.

- The field is already a `string` column-value; sanitized HTML is the **minimal delta** — same storage, same codec shape, same wire type. The write-path validator is already the single chokepoint, so sanitize-on-write gives the **strongest stored invariant** (every persisted byte is allow-list-clean) for the least new surface.
- **Markdown rejected, explicitly:** markdown is *not* inherently safe — most renderers pass raw inline HTML through (`<script>` survives) and `[x](javascript:…)` links are valid markdown. So a markdown pipeline **still needs an output-HTML sanitizer** — it adds a parser without removing the sanitizer, and stores a format we'd then have to render. It buys nothing for the threat model and costs a dependency + a second representation.

The allow-list (below) is deliberately small; the stored HTML is a constrained subset, not "HTML."

## 4. New type vs flag — `property.rich` flag on `longText`

**Decision: a `rich: boolean` flag on the `longText` property** (default `false` = today's plain behavior), *not* a new `richText` field type.

- **Discriminator = blast radius.** The flag localizes the change to: the `longText` branch of `sanitizeProperty` (`field-codecs.ts:371`), `validateLongTextValue` (`:510`), and the `longText` branches of the renderer / editor / drawer / form. A **new field type** would have to be added to ~20 exhaustive `switch`/type-union sites (`MetaFieldManager.vue`, `useMultitableGrid.ts`, `meta-core-labels.ts`, codecs, the openapi spec, the FE `types.ts`, etc.) — far more surface for a tight MVP.
- **Backward-compat (conditional — stated honestly):** existing `longText` fields stay `rich:false` = plain; no migration. The one edge case is **flipping a populated field plain→rich**: old values were stored as *never-sanitized plain text* and would now be reinterpreted as HTML. MVP mitigates by **disallowing the rich toggle on a field that already has data** (simplest; revisit with a sanitize-on-read backfill later). The property change itself runs through `sanitizeProperty`, which validates the flag.

## 5. Sanitizer library + allow-list

- **Server (write): `sanitize-html`** (pure Node, purpose-built for server-side allow-list sanitization, **no DOM needed**). DOMPurify-on-the-server would require pulling heavy `jsdom` into `core-backend` **production** deps (today it is web-devDep only) — avoided.
- **Client (render): `DOMPurify`** in the single rich-render component, re-sanitizing before `v-html` bind (mXSS defense).
- Adding either dep **must update root `pnpm-lock.yaml` in the same change** (CI `--frozen-lockfile`).

**Allow-list (identical config server + client):**

| Allowed tags | Allowed attrs | Stripped (always) |
|---|---|---|
| `b strong i em u s` (inline marks) | `href` on `<a>` **only** | `script style iframe object embed form svg` (drop with contents) |
| `a` (links) | — protocol allow-list: `http https mailto`; force `rel="noopener noreferrer"`, `target="_blank"` | `on*` event-handler attrs (all) |
| `ul ol li` (lists) | | `style` `class` `id` attrs |
| `h1 h2 h3` (headings) | | `src`, `data-*`, any non-listed attr |
| `p br blockquote code pre` | | any non-listed tag (unwrap text) |

Invariant: anything not on this list is removed. No inline styles, no CSS, no classes, no scripts, no event handlers, no embedded/foreign content.

## 6. MVP slice scope (first reviewable PR after this lock)

In:
1. `rich` flag on `longText` property (validated in `sanitizeProperty`; toggle disabled on populated fields — §4).
2. **Write-path sanitizer** wired into `validateLongTextValue` (`sanitize-html`, the §5 allow-list) — covers all 4 call sites.
3. **One FE rich-render component** = the sole `v-html` owner, re-sanitizing with DOMPurify (§2.2); used by renderer / drawer / form when `rich`.
4. Minimal rich **editor** (bold/italic/underline/strike, links, lists, headings) replacing the `<textarea>` when `rich`.
5. Codec / wire **round-trip** + the **plain-text projection** (§7) for export & search.

Deferred (note, do not build): @-mentions in rich text; inline images / attachments; collaborative rich editing (Yjs); per-field format restrictions (e.g. "links only"); markdown import/paste; tables in rich text.

## 7. Interactions (one rule each)

- **Masking (§2a.3):** a rich value is still a record-`data` field value → it is masked by the existing record-data masking in `query-service.ts` exactly like any other field. No special-casing.
- **Plain-text projection — unify export + search.** Derive **one** `textContent` projection from the sanitized HTML (strip tags → text) and reuse it for both: `xlsx-service.ts` must use it instead of `String(value)` (otherwise it dumps `<p>…` into cells), and record search/filter must match on it (otherwise it matches `<strong>` as if it were content). Single helper, two consumers.
- **Grid vs drawer render:** grid cell shows the plain-text projection (truncated, fast); the drawer / form shows the formatted render via the single sanitized component. Editing happens in the drawer/cell editor.

## 8. Fail-first test matrix (MVP)

**XSS canaries — every one must be neutralized server-side on write** (asserted on the value as persisted, after `validateLongTextValue`):

1. `<script>alert(1)</script>` → stripped.
2. `<img src=x onerror=alert(1)>` → `<img>` not allowed + `onerror` stripped → gone.
3. `<a href="javascript:alert(1)">x</a>` → `href` dropped (protocol not in allow-list), text kept.
4. `<a href="&#106;avascript:alert(1)">x</a>` (**encoded protocol**) → decoded, protocol rejected, `href` dropped.
5. `<p onmouseover="alert(1)">x</p>` → `onmouseover` stripped.
6. `<div style="background:url(javascript:alert(1))">x</div>` (style injection) → `style` attr stripped (and `div` unwrapped).
7. `<iframe src=…>` / `<object>` / `<embed>` / `<form>` → dropped.
8. **mXSS canary** (e.g. `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`) → neutralized **after client re-sanitize** (this canary is *why* §2.2 exists — it ties the matrix back to the spine).

**Benign formatting — must be preserved** through write + render:
9. `<strong>hi</strong> <em>there</em> <a href="https://x.com">link</a><ul><li>a</li></ul>` → all kept (with `rel="noopener noreferrer"` added to the link).

**Round-trip (the drift trap):**
10. A rich value written through the **real** write path (`record-write-service`, not a hand-built fixture) is persisted sanitized and read back sanitized — asserts the field survives the wire (field-by-field copy / projection drop is exactly the bug class our drift-trap rule warns about).

**Toggle edge case:**
11. Enabling `rich` on a field that already has data is rejected by `sanitizeProperty` (§4).

## 9. Decisions (recommended defaults for adoption under delegation)

1. **Storage = sanitized HTML on write** (reject markdown). *Default: adopt.*
2. **`property.rich` flag on `longText`** (not a new `richText` type). *Default: adopt — pick the flag, do not re-litigate.*
3. **Sanitizer = `sanitize-html` server-side (write) + `DOMPurify` client-side (render), shared allow-list of §5.** *Default: adopt.* (Both deps update root `pnpm-lock.yaml` in the same change.)

## 10. Open / non-blocking

- Flag-vs-type is a judgment call; the flag is chosen for blast-radius and is final for the MVP.
- Rich editor library (e.g. a ProseMirror/Tiptap-based component) is an MVP-impl choice, **not** a contract decision — the contract only constrains the *output* (must pass the §5 allow-list on write). Pick at impl time.
