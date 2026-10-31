import hashlib
import json
import pathlib
import re

MAX_BYTES = 16 * 1024 * 1024


def read_receipt(file, nonce):
    file = pathlib.Path(file)
    metadata = pathlib.Path(str(file) + '.meta')
    if any(f.is_symlink() or not f.is_file() for f in [file, metadata]):
        raise ValueError('RESULT_FILE_INVALID')
    if metadata.stat().st_size > 1024:
        raise ValueError('RESULT_METADATA_INVALID')
    try:
        meta = json.loads(metadata.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError):
        raise ValueError('RESULT_METADATA_INVALID') from None
    if (not isinstance(meta, dict) or set(meta) != {'version','state','nonce','bytes','sha256'}
            or type(meta['version']) is not int or meta['version'] != 1
            or meta['state'] != 'complete' or meta['nonce'] != nonce
            or type(meta['bytes']) is not int or not 0 < meta['bytes'] <= MAX_BYTES
            or not isinstance(meta['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', meta['sha256'])):
        raise ValueError('RESULT_METADATA_INVALID')
    if file.stat().st_size != meta['bytes']:
        raise ValueError('RESULT_SIZE_MISMATCH')
    data = file.read_bytes()
    if hashlib.sha256(data).hexdigest() != meta['sha256']:
        raise ValueError('RESULT_HASH_MISMATCH')
    try:
        return json.loads(data.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise ValueError('RESULT_JSON_INVALID') from None
