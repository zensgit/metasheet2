from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import sys


class Handler(BaseHTTPRequestHandler):
  def do_POST(self):
    length = int(self.headers.get('Content-Length', '0'))
    raw = self.rfile.read(length)
    body = raw.decode('utf-8', errors='replace')
    try:
      parsed = json.loads(body)
      line = json.dumps(parsed, ensure_ascii=False)
    except Exception:
      line = body
    sys.stdout.write(line + '\n')
    sys.stdout.flush()
    self.send_response(200)
    self.end_headers()
    self.wfile.write(b'ok')

  def do_GET(self):
    self.send_response(200)
    self.end_headers()
    self.wfile.write(b'ok')

  def log_message(self, fmt, *args):
    return


HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
