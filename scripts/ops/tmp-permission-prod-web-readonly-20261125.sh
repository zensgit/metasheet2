#!/usr/bin/env bash
set -euo pipefail

port=$(docker inspect --type container --format '{{range (index .NetworkSettings.Ports "80/tcp")}}{{if or (eq .HostIp "0.0.0.0") (eq .HostIp "127.0.0.1")}}{{println .HostPort}}{{end}}{{end}}' metasheet-web 2>/dev/null)
[[ "$port" =~ ^[0-9]{1,5}$ && "$port" -gt 0 && "$port" -le 65535 ]] || { echo 'Web IPv4 loopback binding could not be identified'; exit 1; }

python3 - "$port" <<'PY'
import http.client
import json
import re
import sys

port = int(sys.argv[1])

def request_json(path):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        conn.request('GET', path)
        response = conn.getresponse()
        raw = response.read(1048577)
        if len(raw) > 1048576:
            return response.status, {}
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeError):
            return response.status, {}
        return response.status, data if isinstance(data, dict) else {}
    except (OSError, http.client.HTTPException):
        return None, {}
    finally:
        conn.close()

def commit_from(data):
    value = data.get('commit')
    return value if isinstance(value, str) and re.fullmatch('[0-9a-f]{40}', value) else None

proxy_http, proxy = request_json('/api/health')
web_http, web = request_json('/build-info.json')
proxy_build = proxy.get('build')
proxy_commit = commit_from(proxy_build) if isinstance(proxy_build, dict) else None
web_commit = commit_from(web)
web_healthy = (proxy_http == 200 and proxy.get('ok') is True and proxy.get('status') == 'ok'
               and web_http == 200 and web_commit is not None and proxy_commit == web_commit)
print(json.dumps({'proxyHttp': proxy_http, 'webHttp': web_http, 'webHealthy': web_healthy,
                  'webCommit': web_commit, 'proxyBackendCommit': proxy_commit}, separators=(',', ':')))
sys.exit(0 if web_healthy else 1)
PY
