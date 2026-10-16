"""Fixed local full-app PID1 bootstrap. It never accepts an arbitrary entry.

Node 20 lacks execve. Python enables only this private loopback and replaces
PID1 with the CLI-selected Node 20 ELF after dropping all capability sets.
"""
import hashlib
import json
import os
import re
import subprocess
import sys


def require(value):
    if not value:
        raise RuntimeError('PLM_FULL_APP_NAMESPACE_BOOT_REJECTED')


def plain(target, directory=False):
    require(os.path.isabs(target) and os.path.realpath(target) == target and not os.path.islink(target))
    require(os.path.isdir(target) if directory else os.path.isfile(target) and os.stat(target).st_nlink == 1)


require(len(sys.argv) == 4)
root, nonce, owner_sha = sys.argv[1:]
plain(root, True)
require(os.path.realpath(__file__) == os.path.join(root, 'scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py'))
require(re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', nonce) is not None)
require(re.fullmatch(r'[a-f0-9]{64}', owner_sha) is not None)
directory = os.path.join(root, 'tmp', 'stock-preparation-plm-full-app-namespace-' + nonce)
plain(os.path.join(root, 'tmp'), True)
plain(directory, True)
owner_path = os.path.join(directory, 'owner.json')
plain(owner_path)
require(0 < os.stat(owner_path).st_size <= 16384)
with open(owner_path, 'rb') as handle:
    owner_bytes = handle.read(16385)
require(hashlib.sha256(owner_bytes).hexdigest() == owner_sha)
owner = json.loads(owner_bytes)
require(owner['owner'] == 'PLM_FULL_APP_NAMESPACE' and owner['repoRoot'] == root and owner['nonce'] == nonce)
require(os.getpid() == 1 and os.getuid() == owner['uid'] and os.getuid() > 0 and os.getgid() > 0)
require(re.fullmatch(r'net:\[[1-9][0-9]*\]', owner['parentNamespace']) is not None)
require(os.readlink('/proc/self/ns/net') != owner['parentNamespace'])
node = owner['node']
plain(node)
with open(node, 'rb') as handle:
    executable = handle.read()
require(executable[:4] == b'\x7fELF' and hashlib.sha256(executable).hexdigest() == owner['nodeSha256'])
entry = os.path.join(root, 'scripts/ops/lib/stock-preparation-plm-namespace.mjs')
paths = ['scripts/ops/run-stock-preparation-plm-full-app.mjs',
         'scripts/ops/lib/stock-preparation-plm-namespace-scope.cjs',
         'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs',
         'scripts/ops/lib/stock-preparation-plm-namespace.mjs',
         'scripts/ops/lib/stock-preparation-plm-namespace-bootstrap.py',
         'scripts/ops/lib/stock-preparation-yida-browser-candidate.cjs']
require([row['path'] for row in owner['sources']] == paths)
for row in owner['sources']:
    target = os.path.join(root, row['path'])
    plain(target)
    with open(target, 'rb') as handle:
        require(hashlib.sha256(handle.read()).hexdigest() == row['sha256'])
links = json.loads(subprocess.check_output(['/usr/sbin/ip', '-json', 'link', 'show']))
require(len(links) == 1 and links[0]['ifname'] == 'lo' and links[0]['link_type'] == 'loopback')
require('LOOPBACK' in links[0]['flags'])
subprocess.check_call(['/usr/sbin/ip', 'link', 'set', 'dev', 'lo', 'up'])
# PID1 exit destroys this PID tree; no persistent namespace FD or bind mount.
os.execve('/usr/bin/setpriv', ['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
          '--ambient-caps=-all', node, entry, '--namespace-init', root, nonce, owner_sha], dict(os.environ))
