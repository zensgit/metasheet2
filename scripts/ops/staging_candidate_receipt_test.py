import ast
import hashlib
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
import unittest
from unittest.mock import Mock
from staging_candidate_receipt import read_receipt

WRITER = pathlib.Path(__file__).with_name('staging-candidate-result.cjs').resolve()
NODE = os.environ.get('NODE_BINARY', 'node')


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        root = pathlib.Path.cwd() / 'artifacts' / 'receipt-protocol-tests'
        root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=root)
        self.root = pathlib.Path(self.tmp.name)
        self.file = self.root / 'result.json'
        self.nonce = secrets.token_hex(16)

    def tearDown(self):
        self.tmp.cleanup()

    def produce(self, value=None, noise=False):
        value = value or {'payload': 'x' * (1024 * 1024), 'unicode': '\u6771\u4eac' * 10000}
        inp = self.root / 'input.json'
        inp.write_text(json.dumps(value, ensure_ascii=False))
        env = dict(os.environ, QA_RESULT_PATH=str(self.file), QA_RESULT_NONCE=self.nonce,
                   QA_RESULT_UID=str(os.getuid()), QA_RESULT_GID=str(os.getgid()))
        code = "const fs=require('fs');" + ("console.log('\\u6771'.repeat(2*1024*1024));" if noise else '')
        code += "require(process.argv[1]).writeReceipt(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));process.exit(0)"
        p = subprocess.run([NODE, '-e', code, str(WRITER), str(inp)], env=env, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 0)
        if not noise:
            self.assertLess(len(p.stdout), 256)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        return value

    def node_accepts(self):
        p = subprocess.run([NODE, '-e', "require(process.argv[1]).readReceipt(process.argv[2],process.argv[3])",
                            str(WRITER), str(self.file), self.nonce], capture_output=True, timeout=20)
        return p.returncode == 0

    def reject(self):
        with self.assertRaises((ValueError, OSError)):
            read_receipt(self.file, self.nonce)
        self.assertFalse(self.node_accepts())

    def test_megabyte_unicode_complete_in_both_readers(self):
        value = self.produce()
        self.assertGreater(self.file.stat().st_size, 1024 * 1024)
        self.assertEqual(read_receipt(self.file, self.nonce), value)
        self.assertTrue(self.node_accepts())

    def test_stdout_truncation_does_not_carry_the_receipt(self):
        value = self.produce(noise=True)
        self.assertEqual(read_receipt(self.file, self.nonce), value)
        self.assertTrue(self.node_accepts())

    def test_truncated_file_rejected(self):
        self.produce()
        self.file.write_bytes(self.file.read_bytes()[:65536])
        self.reject()

    def test_same_length_corruption_rejected(self):
        self.produce()
        data = self.file.read_bytes().replace(b'xxxxx', b'yyyyy', 1)
        self.file.write_bytes(data)
        self.reject()

    def test_missing_completion_rejected(self):
        self.produce()
        pathlib.Path(str(self.file) + '.meta').unlink()
        self.reject()

    def test_missing_payload_rejected(self):
        self.produce()
        self.file.unlink()
        self.reject()

    def test_stale_nonce_rejected(self):
        self.produce()
        self.nonce = secrets.token_hex(16)
        self.reject()

    def test_truncated_metadata_rejected(self):
        self.produce()
        pathlib.Path(str(self.file) + '.meta').write_text('{"version":1')
        self.reject()

    def task_with_output(self, stdout, decode):
        tree = ast.parse(WRITER.with_name('staging-handover-rehearsal.py').read_text())
        task = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'task')
        remove = Mock()
        namespace = {'counter':0,'SCOPE':'synthetic','PRIVATE':self.root,
                     'create':Mock(),'environment':Mock(return_value=self.root/'env'),
                     'docker':Mock(return_value=subprocess.CompletedProcess([],0,stdout,b'')),
                     'inspect':Mock(return_value={'State':{'ExitCode':0}}),'remove':remove}
        exec(compile(ast.Module(body=[task], type_ignores=[]), '<task-test>', 'exec'), namespace)
        try:
            return namespace['task']('image','database',[],decode=decode)
        finally:
            remove.assert_called_once()

    def test_task_ignores_incomplete_unicode_stdout_for_file_receipts(self):
        value = self.produce(noise=True)
        output, code = self.task_with_output(b'log\xe6', decode=False)
        self.assertEqual(code, 0)
        self.assertEqual(output, b'log\xe6')
        self.assertEqual(read_receipt(self.file, self.nonce), value)

    def test_task_keeps_nonreceipt_text_strict(self):
        with self.assertRaises(UnicodeDecodeError):
            self.task_with_output(b'log\xe6', decode=True)

    def test_matching_hash_does_not_accept_truncated_json_or_invalid_utf8(self):
        self.produce()
        for data in [b'{"partial":', b'\xff']:
            self.file.write_bytes(data)
            meta = {'version':1,'state':'complete','nonce':self.nonce,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
            pathlib.Path(str(self.file) + '.meta').write_text(json.dumps(meta))
            self.reject()


if __name__ == '__main__':
    unittest.main()
