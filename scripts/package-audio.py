"""Encode PCM as Opus and transport as base64 text assets for portable publishing."""
from pathlib import Path
import base64
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools'))
sys.path.insert(0, str(ROOT.parent / '.tools'))
import imageio_ffmpeg
work = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '작업파일'
assets = ROOT / 'assets'
manifest = {'mime': 'audio/ogg', 'tracks': {}}
for name, filename in [('timer', 'timeline'), ('preview', 'preview')]:
    output = work / f'{filename}-portable.ogg'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', str(work / f'{filename}.pcm'), '-c:a', 'libopus', '-b:a', '12k', '-vbr', 'on', '-frame_duration', '60', '-compression_level', '0', str(output)], check=True)
    data = output.read_bytes()
    parts = []
    for index, offset in enumerate(range(0, len(data), 98304)):
        part = f'opus-{name}-{index:03}.b64'
        (assets / part).write_text(base64.b64encode(data[offset:offset+98304]).decode('ascii'), encoding='ascii')
        parts.append(part)
    assert b''.join(base64.b64decode((assets / part).read_text()) for part in parts) == data
    manifest['tracks'][name] = {'parts':parts, 'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest()}
(assets / 'audio.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({name:{'bytes':track['bytes'],'parts':len(track['parts'])} for name,track in manifest['tracks'].items()}))
