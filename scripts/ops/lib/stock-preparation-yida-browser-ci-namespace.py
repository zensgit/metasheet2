"""Private bootstrap for the fixed test-only Node launcher; never accepts commands."""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

phase = 'BOOTSTRAP_ARGUMENTS'


def plain(file, dependency_hardlinks=False):
    value = os.lstat(file)
    assert stat.S_ISREG(value.st_mode) and (value.st_nlink == 1 or dependency_hardlinks)
    assert os.path.realpath(file) == file
    return file


def digest(file, dependency_hardlinks=False):
    result = hashlib.sha256()
    with open(plain(file, dependency_hardlinks), 'rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            result.update(block)
    return result.hexdigest()


def main():
    global phase
    assert len(sys.argv) == 3 and os.getpid() == 1 and os.getuid() > 0
    phase = 'BOOTSTRAP_OWNER'
    owner_path, expected = sys.argv[1:]
    value = os.lstat(plain(owner_path))
    assert stat.S_IMODE(value.st_mode) == 0o600 and value.st_size < 65536 and value.st_uid == os.getuid()
    assert digest(owner_path) == expected
    with open(owner_path, 'rb') as stream:
        owner = json.load(stream)
    helper = os.path.realpath(__file__)
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(helper))))
    phase = 'BOOTSTRAP_PATHS'
    assert owner['root'] == root
    assert owner['runner'] == os.path.join(root, 'scripts/ops/run-stock-preparation-yida-browser-ci.mjs')
    assert owner['native'] == os.path.join(root, 'scripts/ops/lib/stock-preparation-browser-network-isolation.cjs')
    assert owner['preload'] == os.path.join(root, 'scripts/ops/lib/stock-preparation-yida-browser-ci-preload.cjs')
    relative = os.path.relpath(owner_path, os.path.join(root, 'tmp'))
    assert re.fullmatch(r'yida-browser-ci-[a-f0-9-]{36}/owner\.json', relative)
    assert stat.S_IMODE(os.lstat(os.path.dirname(owner_path)).st_mode) == 0o700
    assert owner['hashes'][owner['native']] == 'cf364bfed3960af8e5c387a4c5d7aa882ce1d558c84f937e6b5816ae5927980c'
    pg = os.path.join(root, 'scripts/ops/lib/stock-preparation-plm-owned-pg.mjs')
    assert owner['hashes'][pg] == '37b430df4a9edc093d1f8839aeacd90d376088539e19f4a8916d01d501164677'
    assert owner['protocol'] == 'YIDA_BROWSER_CI_NATIVE_V1'
    assert owner['uid'] == os.getuid() and owner['gid'] == os.getgid()
    assert owner['helper'] == os.path.realpath(__file__)
    phase = 'BOOTSTRAP_NAMESPACE'
    assert os.readlink('/proc/self/ns/net') != owner['parentNetworkNamespace']
    phase = 'BOOTSTRAP_SOURCE_INTEGRITY'
    for file, sha in owner['hashes'].items():
        # The trusted outer launcher resolved this exact CLI; Node readOwner
        # independently rechecks it before any Vitest execution. No source or
        # receipt path receives the PNPM dependency hardlink exception.
        assert digest(file, file == owner['cli']) == sha
    with open(plain(owner['node']), 'rb') as stream:
        assert stream.read(4) == b'\x7fELF'
    phase = 'BOOTSTRAP_LINKS'
    links = json.loads(subprocess.check_output(
        ['/usr/sbin/ip', '-json', 'link', 'show'], env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
        timeout=3))
    assert len(links) == 1 and links[0]['ifname'] == 'lo'
    assert links[0]['link_type'] == 'loopback' and 'LOOPBACK' in links[0]['flags']
    phase = 'BOOTSTRAP_LO_UP'
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'dev', 'lo', 'up'],
                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, check=True, timeout=3,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    phase = 'BOOTSTRAP_EXEC'
    os.execve('/usr/bin/setpriv', ['/usr/bin/setpriv', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all',
              '--ambient-caps=-all', owner['node'], owner['runner'], '--namespace-init',
              owner_path, expected], dict(os.environ))


try:
    if not __debug__:
        raise RuntimeError('assertions required')
    main()
except BaseException:
    # No exception, path, namespace, environment or subprocess output is public.
    phases = {'BOOTSTRAP_ARGUMENTS', 'BOOTSTRAP_OWNER', 'BOOTSTRAP_PATHS',
              'BOOTSTRAP_SOURCE_INTEGRITY', 'BOOTSTRAP_NAMESPACE', 'BOOTSTRAP_LINKS',
              'BOOTSTRAP_LO_UP', 'BOOTSTRAP_EXEC'}
    public_phase = phase if phase in phases else 'UNKNOWN'
    sys.stderr.write('YIDA_BROWSER_CI_BOOTSTRAP_STAGE ' +
                     json.dumps({'stage': public_phase, 'reason': 'BOOTSTRAP_FAILED'}, separators=(',', ':')) + '\n')
    sys.stderr.write('YIDA_BROWSER_CI_BOOTSTRAP_FAILED\n')
    sys.exit(1)
