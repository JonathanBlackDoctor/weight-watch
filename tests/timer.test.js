import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, nextCue, readVolume } from '../timer.js';

test('time boundaries and the 120 minute limit', () => {
  for (const [time, text] of [[-1,'00:00'],[0,'00:00'],[59.9,'00:59'],[60,'01:00'],[3599,'59:59'],[3600,'60:00'],[7200,'120:00'],[7210,'120:00']]) assert.equal(formatTime(time), text);
});
test('one cue per half minute, voice replaces the beep at each minute', () => {
  assert.equal(nextCue(0), '30초 후 짧은 알림음');
  assert.equal(nextCue(29.8), '1초 후 짧은 알림음');
  assert.equal(nextCue(30), '30초 후 “1분”');
  assert.equal(nextCue(59.8), '1초 후 “1분”');
  assert.equal(nextCue(60), '30초 후 짧은 알림음');
  assert.equal(nextCue(7199), '1초 후 “120분”');
  assert.equal(nextCue(7200), '120분 안내 · 수고하셨습니다');
});
test('volume tolerates missing, corrupt and out of range local preferences', () => {
  for (const [input, expected] of [[null,70],['',70],['oops',70],['0',0],['120',100],['-5',0],['35',35]]) assert.equal(readVolume(input),expected);
});
