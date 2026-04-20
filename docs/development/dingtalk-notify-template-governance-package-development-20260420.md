# DingTalk Notify Template Governance Package Development 2026-04-20

## Goal

Package the DingTalk notification authoring governance stack into one `main`-based branch so the product can ship a coherent template-authoring experience instead of relying on a deep stacked PR chain.

## Included Slices

This package replays and bundles the following frontend-only governance work:

1. Message presets
2. Template token assist
3. Message summary preview
4. Template syntax warnings
5. Rendered template examples
6. Rendered example copy actions
7. Unknown placeholder path warnings

## Product Outcome

After this package, both DingTalk actions:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

have authoring support for:

- common scenario presets
- token insertion
- inline summary preview
- rendered example preview
- copy-to-clipboard from rendered examples
- linting for malformed placeholders
- linting for valid-looking but unknown placeholder paths

## Scope

- Frontend only
- No backend/API changes
- No migration changes
- No remote deployment

## Why Package It

The underlying DingTalk notification capability is already in place. The remaining work on this line is primarily authoring quality. Packaging the governance slices into one `main`-based PR shortens review, merge, and deployment time for the final “send DingTalk message and open form” experience.
