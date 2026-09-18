import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const assets = new URL('../assets/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('audio.json', assets), 'utf8'));
test('published audio segments reassemble to the verified Opus tracks', () => {
  for (const track of Object.values(manifest.tracks)) {
    const data = Buffer.concat(track.parts.map((part) => Buffer.from(readFileSync(new URL(part, assets), 'utf8'), 'base64')));
    assert.equal(data.length, track.bytes);
    assert.equal(data.subarray(0,4).toString(), 'OggS');
    assert.equal(createHash('sha256').update(data).digest('hex'), track.sha256);
  }
});
test('audio schedule contains every half-minute cue once for two hours', () => {
  const { events, duration } = JSON.parse(readFileSync(new URL('timeline.json', assets), 'utf8'));
  assert.equal(duration, 7204);
  assert.equal(events.length, 240);
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    assert.equal(event.at, (i + 1) * 30);
    assert.equal(event.type, event.at % 60 ? 'beep' : 'voice');
    if (event.type === 'voice') assert.equal(event.minute, event.at / 60);
  }
});
