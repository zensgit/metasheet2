# DingTalk P4 Evidence Secret Assignment Spaces Design

Date: 2026-04-30

## Goal

Prevent manual evidence records and text artifacts from accepting DingTalk secret assignments that include spaces around the equals sign.

## Change

- Align `dingtalk-p4-evidence-record` secret scanning with the strict evidence compiler's assignment shape.
- Detect these forms in summaries, notes, blocked reasons, admin fields, artifact refs, and text artifacts:
  - `client_secret=value`
  - `client_secret = value`
  - `DINGTALK_CLIENT_SECRET = value`
  - `DINGTALK_STATE_SECRET = value`
- Keep placeholder-safe values allowed for docs and templates, including `<redacted>`, `replace-me`, environment references, and empty assignments.
- Extend redaction to preserve the assignment prefix while replacing the value with `<redacted>`.

## Operator Impact

If an operator accidentally pastes a DingTalk app secret into a manual evidence summary or artifact, the recorder fails before writing `workspace/evidence.json`. The error names the offending pattern without echoing the raw secret value.

