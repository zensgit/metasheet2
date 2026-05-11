# DingTalk Screenshot Archive Development

## Summary

Added a small ops helper to package DingTalk mobile/manual screenshots into a redaction-safe archive. The helper is intentionally narrow: it copies screenshot image files into stable names, writes `manifest.json` and `README.md`, and records size/hash metadata without exposing token-like values in labels.

## Scope

- New CLI: `scripts/ops/dingtalk-screenshot-archive.mjs`
- New tests: `scripts/ops/dingtalk-screenshot-archive.test.mjs`
- Output shape:
  - `manifest.json`
  - `README.md`
  - `screenshots/screenshot-NNN.<ext>`

## Design

The archive tool is evidence packaging, not evidence interpretation. It does not OCR or inspect screenshot pixels, so screenshots remain restricted artifacts. The generated metadata is safe to include in closeout packets because source labels are redacted and copied files are renamed.

Supported image extensions are `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.heic`, and `.heif`. Directory inputs are scanned recursively, non-image files are ignored with warnings, and empty archives fail by default unless `--allow-empty` is passed.

## Redaction Rules

The manifest and README redact:

- DingTalk robot URLs and `access_token=...`
- `publicToken=...`
- DingTalk signature query values such as `sign` and `timestamp`
- DingTalk client/state secrets
- `Bearer ...`
- `SEC...`
- JWT-looking values

## Usage

```bash
node scripts/ops/dingtalk-screenshot-archive.mjs \
  --input /path/to/dingtalk-screenshots \
  --output-dir artifacts/dingtalk-screenshot-archive/live-acceptance-20260511
```

Use `--input` repeatedly when evidence is split across folders:

```bash
node scripts/ops/dingtalk-screenshot-archive.mjs \
  --input /path/to/mobile-form-screenshots \
  --input /path/to/group-message-screenshots \
  --output-dir artifacts/dingtalk-screenshot-archive/live-acceptance-20260511
```

## Operational Notes

- Keep raw archive directories access-restricted because screenshot pixels can contain personal or operational data.
- Commit only redacted manifests or docs when they contain no sensitive content.
- Prefer linking the archive manifest from final closeout verification rather than pasting screenshot content into Git.
