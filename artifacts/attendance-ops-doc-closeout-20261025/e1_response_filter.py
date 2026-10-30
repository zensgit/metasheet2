#!/usr/bin/env python3
"""Values-free E1 evidence filter. Reads body, HTTP status and transport exit from stdin."""
import json
import math
import sys

CODES = {
    'container_login_disabled', 'invalid_auth_code', 'UNAUTHORIZED',
    'grant_required', 'grant_disabled', 'local_user_disabled', 'identity_ambiguous',
    'grant_state_unavailable', 'identity_key_unavailable', 'RECOVERY_AUTHORITY_BUSY',
    'unlinked_enabled_local_user', 'unlinked_local_user',
    'auto_provision_alias_conflict', 'auto_provision_corp_required', 'auto_provision_email_conflict', 'directory_managed_identity', 'identity_already_bound', 'identity_mismatch',
}
DISABLED = {'success': False, 'error': 'DingTalk container login is not enabled',
            'code': 'container_login_disabled'}


def summarize(raw, mode):
    body, status, transport = {}, None, None
    try:
        payload, status_text, transport_text = raw.rsplit('\n', 2)
        status = int(status_text) if len(status_text) == 3 and status_text.isdigit() else None
        if status is not None and not 100 <= status <= 599:
            status = None
        transport = int(transport_text) if transport_text.isdigit() else None
        parsed = json.loads(payload)
        if isinstance(parsed, dict):
            body = parsed
    except (ValueError, TypeError):
        pass
    error = body.get('error')
    nested = error if isinstance(error, dict) else {}
    code = body.get('code', nested.get('code'))
    safe_code = code if isinstance(code, str) and code in CODES else 'UNRECOGNIZED' if code is not None else None
    details = nested.get('details')
    retryable = details.get('retryable') if isinstance(details, dict) else None
    retryable = retryable if isinstance(retryable, bool) else None
    retry_after = body.get('retryAfter')
    if isinstance(retry_after, bool) or not isinstance(retry_after, (int, float)) or not 0 <= retry_after <= 86400 or not math.isfinite(retry_after):
        retry_after = None
    data = body.get('data')
    data = data if isinstance(data, dict) else {}
    user = data.get('user')
    user = user if isinstance(user, dict) else {}
    if mode == 'default-off':
        match = transport == 0 and status == 404 and body.get('success') is False and body == DISABLED
        key = 'default_off_contract_match'
    elif mode == 'login':
        match = (transport == 0 and status == 200 and body.get('success') is True
                 and set(body) == {'success', 'data'}
                 and set(data) == {'mode', 'user', 'token', 'features'} and data.get('mode') == 'login'
                 and set(user) == {'id', 'email', 'name', 'role', 'permissions'}
                 and isinstance(user.get('permissions'), list)
                 and isinstance(data.get('token'), str) and bool(data.get('token'))
                 and isinstance(data.get('features'), dict))
        key = 'login_envelope_match'
    else:
        raise ValueError('E1_FILTER_MODE_INVALID')
    return {'http_status': status, 'transport_exit': transport, 'code': safe_code,
            'retryable': retryable, 'retry_after_seconds': retry_after, key: bool(match)}


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode not in {'default-off', 'login'}:
        print(json.dumps({'filter_error': 'E1_FILTER_MODE_INVALID'}))
        raise SystemExit(2)
    result = summarize(sys.stdin.read(), mode)
    print(json.dumps(result))
    raise SystemExit(0 if result['default_off_contract_match' if mode == 'default-off' else 'login_envelope_match'] else 1)
