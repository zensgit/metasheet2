import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


TARGET_WEBHOOK_URL = os.environ.get('ALERTMANAGER_WEBHOOK_URL', '').strip()


def log_line(payload):
  sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
  sys.stdout.flush()


def summarize_alert(alert):
  labels = alert.get('labels') or {}
  annotations = alert.get('annotations') or {}
  parts = []
  summary = annotations.get('summary')
  if summary:
    parts.append(summary)
  for key in ('alertname', 'severity', 'component', 'feature', 'operation', 'reason', 'result', 'exercise_id', 'probe_id', 'drill_id'):
    value = labels.get(key)
    if value:
      parts.append(f'{key}={value}')
  return ' | '.join(parts) if parts else 'alert'


def format_slack_payload(payload):
  status = str(payload.get('status', 'unknown')).upper()
  alerts = payload.get('alerts') or []
  common_labels = payload.get('commonLabels') or {}
  alertname = common_labels.get('alertname') or (alerts[0].get('labels', {}) if alerts else {}).get('alertname', 'Alert')
  lines = [f'[{status}] {alertname} ({len(alerts)} alert{"s" if len(alerts) != 1 else ""})']
  for alert in alerts[:5]:
    lines.append(f'- {summarize_alert(alert)}')
  if len(alerts) > 5:
    lines.append(f'- ... {len(alerts) - 5} more')
  return {'text': '\n'.join(lines)}


def forward_payload(path, parsed, raw):
  if not TARGET_WEBHOOK_URL or path != '/notify':
    return 200, b'ok'

  parsed_target = urlparse(TARGET_WEBHOOK_URL)
  is_slack = parsed_target.netloc.endswith('hooks.slack.com')
  if is_slack:
    body = json.dumps(format_slack_payload(parsed)).encode('utf-8')
  else:
    body = raw

  request = Request(
    TARGET_WEBHOOK_URL,
    data=body,
    headers={'Content-Type': 'application/json'},
    method='POST',
  )
  try:
    with urlopen(request, timeout=10) as response:
      response_body = response.read() or b'ok'
      return response.status, response_body
  except HTTPError as error:
    return error.code, error.read() or str(error).encode('utf-8', errors='replace')
  except URLError as error:
    return 502, str(error).encode('utf-8', errors='replace')


class Handler(BaseHTTPRequestHandler):
  def do_POST(self):
    length = int(self.headers.get('Content-Length', '0'))
    raw = self.rfile.read(length)
    body = raw.decode('utf-8', errors='replace')
    parsed = {}
    try:
      parsed = json.loads(body)
      line = parsed
    except Exception:
      line = {'raw': body}

    log_line({
      'path': self.path,
      'forwardConfigured': bool(TARGET_WEBHOOK_URL),
      'payload': line,
    })

    if self.path == '/exercise':
      self.send_response(200)
      self.end_headers()
      self.wfile.write(b'ok')
      return

    status_code, response_body = forward_payload(self.path, parsed, raw)
    self.send_response(status_code)
    self.end_headers()
    self.wfile.write(response_body)

  def do_GET(self):
    self.send_response(200)
    self.end_headers()
    self.wfile.write(b'ok')

  def log_message(self, fmt, *args):
    return


HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
