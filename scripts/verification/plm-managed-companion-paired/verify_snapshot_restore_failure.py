"""Real owned child/listener regression for failed restore cleanup; no database started."""
import json,os,signal,socket,subprocess,sys,tempfile
from pathlib import Path
from snapshot_restore import restore_snapshot_pair
if not __debug__:
 raise RuntimeError("Verification requires assertions enabled")
class OwnedFailure(Exception):pass
with tempfile.TemporaryDirectory(prefix='plm-managed-paired-',dir='/tmp') as name:
 root=Path(name);(root/'.plm-managed-paired-owned').write_text(json.dumps({'nonce':root.name.removeprefix('plm-managed-paired-'),'kind':'plm-managed-companion-paired'}))
 listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();ports=[]
 child=subprocess.Popen([sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGSTOP);signal.pause()'])
 assert os.WIFSTOPPED(os.waitpid(child.pid,os.WUNTRACED)[1])
 def failed_pg(*args):raise OwnedFailure('controlled owned dump failure')
 try:
  try:restore_snapshot_pair(child,{}, {},root,root/'native',listener,{}, {},sys.executable,'unused','unused',failed_pg,ports.append)
  except OwnedFailure:
   assert child.returncode == -signal.SIGTERM
   assert len(ports)==1
   try:connected=socket.create_connection(('127.0.0.1',ports[0]),timeout=.1)
   except OSError:pass
   else:
    connected.close();raise AssertionError('restore failure kept an owned listener open')
  else:raise AssertionError('controlled failure was swallowed')
 finally:
  listener.close()
  if child.poll() is None:child.kill();child.wait()
print(json.dumps({'owned_child_stopped':True,'controlled_failure_propagated':True,'owned_listener_closed_on_failure':True}))
