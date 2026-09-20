"""Build one timeline: silence, cue at :30, spoken elapsed minute at :00.
Requires numpy and imageio-ffmpeg; regenerate voices with make-voices.ps1 first.
"""
from pathlib import Path
import json
import subprocess
import sys
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools'))
import imageio_ffmpeg
RATE = 16000
SECONDS = 7204
work = ROOT / '작업파일'
assets = ROOT / 'assets'
assets.mkdir(exist_ok=True)
timeline = np.memmap(work / 'timeline.pcm', mode='w+', dtype='<i2', shape=(SECONDS * RATE,))
timeline[:] = 0
events = []
voices = {}
for minute in range(1, 121):
    with wave.open(str(work / 'voices' / f'{minute}.wav'), 'rb') as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (RATE, 1, 2)
        voice = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').copy()
    active = np.flatnonzero(np.abs(voice.astype(np.int32)) > 200)
    assert len(active), f'Empty voice {minute}'
    voice = voice[max(0, active[0] - 80):min(len(voice), active[-1] + 801)]
    assert len(voice) < 4 * RATE
    voice = (voice.astype(np.float64) * (24000 / max(1, np.max(np.abs(voice.astype(np.int32)))))).astype('<i2')
    voices[minute] = voice
    start = minute * 60 * RATE
    timeline[start:start + len(voice)] = voice
    events.append({'at': minute * 60, 'type': 'voice', 'minute': minute, 'samples': len(voice)})
length = int(.7 * RATE)
t = np.arange(length) / RATE
envelope = np.minimum(1, np.arange(length) / (RATE * .008)) * np.minimum(1, np.arange(length)[::-1] / (RATE * .045))
beep = (np.sin(2 * np.pi * 880 * t) * envelope * 10000).astype('<i2')
for second in range(30, 7200, 60):
    timeline[second*RATE:second*RATE + length] = beep
    events.append({'at': second, 'type': 'beep', 'samples': length})
timeline.flush()
ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
def encode(source, destination):
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(RATE), '-ac', '1', '-i', str(source), '-c:a', 'libopus', '-b:a', '16k', '-vbr', 'on', '-application', 'audio', str(destination)], check=True)
encode(work / 'timeline.pcm', assets / 'timer-120.ogg')
preview = np.zeros(RATE * 4, dtype='<i2')
preview[RATE//4:RATE//4+length] = beep
preview[RATE:RATE+len(voices[1])] = voices[1]
preview.tofile(work / 'preview.pcm')
encode(work / 'preview.pcm', assets / 'preview.ogg')
events.sort(key=lambda e: e['at'])
assert len(events) == 240
assert [e['at'] for e in events] == list(range(30, 7201, 30))
assert all(np.any(timeline[e['at']*RATE:e['at']*RATE+e['samples']]) for e in events)
manifest = {'sampleRate': RATE, 'duration': SECONDS, 'voice': 'Microsoft Heami Desktop', 'events': events}
(assets / 'timeline.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'verifiedEvents':len(events), 'duration':SECONDS, 'audioBytes':(assets/'timer-120.ogg').stat().st_size}))
