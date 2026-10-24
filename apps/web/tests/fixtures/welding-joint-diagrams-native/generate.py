"""Synthetic, non-square decoder fixtures; no customer or professional drawing."""
import hashlib, json
from pathlib import Path
from PIL import Image
import PIL

ROOT = Path(__file__).resolve().parent
COLORS = [(240, 30, 30), (30, 220, 40), (30, 50, 240), (240, 220, 30)]
image = Image.new('RGB', (96, 64))
for box, color in zip([(0, 0, 48, 32), (48, 0, 96, 32), (0, 32, 48, 64), (48, 32, 96, 64)], COLORS):
    image.paste(color, box)
rows = []
for format, orientation in [('png', 1), ('webp', 1)] + [('jpeg', value) for value in range(1, 9)]:
    name = f'corners-exif-{orientation}.jpg' if format == 'jpeg' else f'corners.{format}'
    path = ROOT / name
    options = {'lossless': True} if format == 'webp' else {}
    if format == 'jpeg':
        exif = Image.Exif(); exif[274] = orientation
        options = {'quality': 95, 'subsampling': 0, 'exif': exif}
    with path.open('xb') as target: image.save(target, format=format.upper(), **options)
    data = path.read_bytes()
    rows.append({'name': name, 'format': format, 'mime_type': f'image/{format}', 'exif_orientation': orientation,
                 'encoded_width': 96, 'encoded_height': 64, 'display_width': 64 if orientation >= 5 else 96,
                 'display_height': 96 if orientation >= 5 else 64, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
with (ROOT / 'manifest.json').open('x') as target:
    json.dump({'schema': 'metasheet.synthetic_joint_diagrams/1', 'pillow': PIL.__version__, 'fixtures': rows}, target, indent=2)
    target.write('\n')
