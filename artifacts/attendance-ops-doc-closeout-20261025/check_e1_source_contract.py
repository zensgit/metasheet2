#!/usr/bin/env python3
"""Offline E1 documentation snapshot check; stdlib only, no runtime/live claims."""
import hashlib
import json
from pathlib import Path

ARTIFACT = Path(__file__).resolve().parent
ROOT = ARTIFACT.parent.parent
MANIFEST = json.loads((ARTIFACT / 'source-evidence-disposition.json').read_text())


def verify(document, sources):
    failures = []
    try:
        section = document.split(MANIFEST['section_start'], 1)[1].split(
            MANIFEST['section_end'], 1)[0]
    except IndexError:
        return ['doc_section']
    for index, fragment in enumerate(MANIFEST['required_doc_fragments']):
        if fragment not in section:
            failures.append('doc_fragment_%02d' % index)
    for spec in MANIFEST['sources']:
        text = sources[spec['path']]
        try:
            start = text.index(spec['start'])
            end = len(text) if spec['end'] is None else text.index(
                spec['end'], start + len(spec['start']))
            digest = hashlib.sha256(text[start:end].encode()).hexdigest()
        except ValueError:
            digest = None
        if digest != spec['sha256']:
            failures.append('source_' + spec['id'])
    return failures


def main():
    document = (ROOT / MANIFEST['document']).read_text()
    sources = {spec['path']: (ROOT / spec['path']).read_text()
               for spec in MANIFEST['sources']}
    failures = verify(document, sources)
    probes = []
    # Change only in-memory copies. A missing target fails the probe.
    mutations = [
        ('doc_wrong_http_status', None, 'must yield HTTP **404**, exactly',
         'must yield HTTP **401**, exactly', 'doc_fragment_23'),
        ('doc_wrong_route', None, '**`POST /api/auth/login/dingtalk/container`**',
         '**`POST /auth/dingtalk/container`**', 'doc_fragment_00'),
        ('doc_wrong_disabled_code', None, '"code":"container_login_disabled"',
         '"code":"UNAUTHORIZED"', 'doc_fragment_04'),
        ('doc_flat_recovery', None,
         '{"ok":false,"error":{"code":"RECOVERY_AUTHORITY_BUSY","message":"Recovery is stabilizing permissions; retry this change.","details":{"retryable":true}}}',
         '{"success":false,"code":"RECOVERY_AUTHORITY_BUSY"}', 'doc_fragment_07'),
        ('source_wrong_mount', 'packages/core-backend/src/index.ts',
         "this.app.use('/api/auth', authRouter)", "this.app.use('/auth', authRouter)",
         'source_mount'),
        ('source_wrong_status', 'packages/core-backend/src/routes/auth.ts',
         "return res.status(404).json({\n        success: false,\n        error: 'DingTalk container login is not enabled'",
         "return res.status(401).json({\n        success: false,\n        error: 'DingTalk container login is not enabled'", 'source_handler'),
        ('source_wrong_exception', 'packages/core-backend/src/auth/api-path-policy.ts',
         "path: '/api/auth/login/dingtalk/container',\n    kind: 'exact'",
         "path: '/api/auth/login/dingtalk/container',\n    kind: 'prefix'", 'source_policy'),
        ('source_flat_response', 'packages/core-backend/src/util/response.ts',
         'res.status(status).json({ ok: false, error: { code, message, details } })',
         'res.status(status).json({ success: false, code, message, details })',
         'source_response'),
    ]
    for name, path, before, after, expected_failure in mutations:
        original = sources[path] if path else document
        if before not in original:
            detected = False
        elif path:
            mutated = dict(sources)
            mutated[path] = original.replace(before, after, 1)
            detected = expected_failure in verify(document, mutated)
        else:
            detected = expected_failure in verify(document.replace(before, after, 1), sources)
        probes.append({'probe': name, 'detected': detected})
    report = {
        'scope': 'offline source snapshot and documented anchors; not HTTP/TS execution',
        'baseline': MANIFEST['baseline'],
        'source_slices_checked': len(MANIFEST['sources']),
        'doc_fragments_checked': len(MANIFEST['required_doc_fragments']),
        'failures': failures,
        'failure_probes': probes,
        'pass': not failures and all(probe['detected'] for probe in probes),
        'live_smoke': 'not_run',
        'disposition': 'Draft/HOLD; independent review and main validation pending',
    }
    print(json.dumps(report, indent=2))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
