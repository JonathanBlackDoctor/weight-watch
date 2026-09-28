import { formatTime, nextCue, readVolume } from './timer.js';

const AUDIO_VERSION = 'long-beep-1';
const CACHE = 'weight-watch-v7';
const assetURL = (path) => `./assets/${path}?v=${AUDIO_VERSION}`;

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const preview = $('preview');
let ready = false;
let loading = false;
let wantsPlay = false;
let pendingPlay = false;
let stalled = false;
let trackURL;
let sampleURL;
let operation = 0;
let preparing;
let assetURLs = [];
let audioContext;
let timerGain;
let previewGain;
let limiter;

function ensureAudioBoost() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();

    const timerSource = audioContext.createMediaElementSource(audio);
    const previewSource = audioContext.createMediaElementSource(preview);
    timerGain = audioContext.createGain();
    previewGain = audioContext.createGain();
    limiter = audioContext.createDynamicsCompressor();

    // Stronger boost for both the 30-second buzzer and spoken minute cues.
    // The limiter catches peaks so the extra level is loud without harsh clipping.
    timerGain.gain.value = 4.0;
    previewGain.gain.value = 4.0;
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    timerSource.connect(timerGain).connect(limiter).connect(audioContext.destination);
    previewSource.connect(previewGain).connect(limiter);
  }
  if (audioContext.state === 'suspended') return audioContext.resume();
}

async function playStartCue() {
  await ensureAudioBoost();
  if (!audioContext) return;

  const now = audioContext.currentTime;
  const cueGain = audioContext.createGain();
  cueGain.gain.setValueAtTime(0.0001, now);
  cueGain.gain.exponentialRampToValueAtTime(1.0, now + 0.015);
  cueGain.gain.setValueAtTime(1.0, now + 0.42);
  cueGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  cueGain.connect(limiter);

  const first = audioContext.createOscillator();
  first.type = 'sine';
  first.frequency.value = 880;
  first.connect(cueGain);
  first.start(now);
  first.stop(now + 0.22);

  const second = audioContext.createOscillator();
  second.type = 'sine';
  second.frequency.value = 1175;
  second.connect(cueGain);
  second.start(now + 0.26);
  second.stop(now + 0.55);
}

async function loadAudio() {
  const response = await fetch(assetURL('audio.json'));
  if (!response.ok) throw new Error('audio manifest');
  const manifest = await response.json();
  assetURLs = [assetURL('audio.json'), ...Object.values(manifest.tracks).flatMap((track) => track.parts.map((part) => assetURL(part)))];
  return Promise.all(['timer', 'preview'].map(async (name) => {
    const track = manifest.tracks[name];
    const parts = await Promise.all(track.parts.map(async (part) => {
      const result = await fetch(assetURL(part));
      if (!result.ok) throw new Error('audio download');
      const decoded = atob((await result.text()).trim());
      return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    }));
    const blob = new Blob(parts, { type: manifest.mime });
    if (blob.size !== track.bytes) throw new Error('audio size');
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const checksum = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    if (checksum !== track.sha256) throw new Error('audio integrity');
    return blob;
  }));
}

function message(text, error = false) {
  $('feedback').textContent = text;
  $('feedback').classList.toggle('error', error);
}
function render() {
  const running = ready && !audio.paused && !audio.ended;
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('nextCue').textContent = nextCue(audio.currentTime);
  $('progressRing').style.strokeDashoffset = String(879.646 * (1 - (audio.currentTime % 60) / 60));
  $('status').textContent = loading ? '소리 준비 중' : !ready ? '소리를 불러올 수 없음' : stalled ? '재생 연결 확인 중' : audio.ended ? '운동 완료' : running ? '운동 중' : audio.currentTime > 0 ? '일시정지' : '준비 완료';
  $('statusDot').classList.toggle('running', running && !stalled);
  $('toggleLabel').textContent = loading ? '소리 준비 중…' : pendingPlay ? '시작하는 중…' : running ? '일시정지' : audio.ended ? '다시 시작' : audio.currentTime > 0 ? '계속하기' : '운동 시작';
  $('toggleIcon').textContent = running ? 'Ⅱ' : '▶';
  $('toggle').classList.toggle('active', running);
  $('toggle').disabled = !ready || pendingPlay;
  $('reset').disabled = !ready;
  $('soundTest').disabled = !ready || running || pendingPlay;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = running ? 'playing' : 'paused';
}

async function prepare() {
  if (loading) return;
  loading = true;
  ready = false;
  $('retry').hidden = true;
  message('안내 음원을 불러오고 있습니다.');
  render();
  try {
    const [track, sample] = await loadAudio();
    if (trackURL) URL.revokeObjectURL(trackURL);
    if (sampleURL) URL.revokeObjectURL(sampleURL);
    trackURL = URL.createObjectURL(track);
    sampleURL = URL.createObjectURL(sample);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('audio decoding')), 15000);
      const onLoaded = () => finish();
      const onError = () => finish(new Error('audio format'));
      const finish = (error) => {
        clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', onLoaded);
        audio.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      audio.addEventListener('loadedmetadata', onLoaded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.src = trackURL;
      audio.load();
    });
    preview.src = sampleURL;
    preview.load();
    await new Promise((resolve, reject) => {
      if (preview.readyState >= 2) return resolve();
      const timeout = setTimeout(() => finish(new Error('preview decoding')), 10000);
      const onReady = () => finish();
      const onError = () => finish(new Error('preview format'));
      const finish = (error) => {
        clearTimeout(timeout);
        preview.removeEventListener('loadeddata', onReady);
        preview.removeEventListener('error', onError);
        error ? reject(error) : resolve();
      };
      preview.addEventListener('loadeddata', onReady, { once: true });
      preview.addEventListener('error', onError, { once: true });
    });
    ready = true;
    message('0.7초 부저음 준비 완료. 소리 미리 듣기로 확인하세요.');
    // The complete track is in memory; no network request or JS alarm is needed during a session.
    $('offlineStatus').textContent = '이번 운동에 필요한 음원 다운로드가 완료되었습니다. 화면 잠금 동작은 기기 설정에 따라 달라질 수 있습니다.';
  } catch {
    message('소리를 준비하지 못했습니다. 인터넷 연결을 확인하고 다시 불러오세요.', true);
    $('retry').hidden = false;
  } finally {
    loading = false;
    render();
  }
}

async function play() {
  if (!ready || pendingPlay) return;
  const token = ++operation;
  pendingPlay = true;
  wantsPlay = true;
  stalled = false;
  preview.pause();
  preview.currentTime = 0;
  if (audio.ended) audio.currentTime = 0;
  render();
  try {
    await ensureAudioBoost();
    const startingFresh = audio.currentTime < 0.1;
    if (startingFresh) await playStartCue();
    await audio.play();
    if (token !== operation) return;
    message('30초마다 짧은 소리, 매분 경과 시간을 알려드려요.');
  } catch {
    if (token !== operation) return;
    wantsPlay = false;
    message('재생이 중단되었습니다. 시작을 다시 눌러 주세요.', true);
  } finally {
    if (token === operation) pendingPlay = false;
    render();
  }
}
function pause() {
  operation++;
  pendingPlay = false;
  wantsPlay = false;
  stalled = false;
  audio.pause();
  message('잠깐 쉬어가세요. 계속하면 멈춘 시간부터 이어집니다.');
  render();
}
$('toggle').addEventListener('click', () => audio.paused ? play() : pause());
$('reset').addEventListener('click', () => {
  pause();
  audio.currentTime = 0;
  preview.pause();
  preview.currentTime = 0;
  message('00:00으로 돌아왔습니다. 준비되면 시작하세요.');
  render();
});
$('soundTest').addEventListener('click', async () => {
  if (!audio.paused || !ready) return;
  preview.pause();
  preview.currentTime = 0;
  try {
    await ensureAudioBoost();
    if (preview.readyState < 2) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('preview timeout')), 5000);
        const onReady = () => finish();
        const onError = () => finish(new Error('preview error'));
        const finish = (error) => {
          clearTimeout(timeout);
          preview.removeEventListener('canplay', onReady);
          preview.removeEventListener('error', onError);
          error ? reject(error) : resolve();
        };
        preview.addEventListener('canplay', onReady, { once: true });
        preview.addEventListener('error', onError, { once: true });
        preview.load();
      });
    }
    await preview.play();
    message('증폭된 안내음을 재생 중입니다.');
  } catch {
    message('미리 듣기를 재생하지 못했습니다. 페이지를 새로고침한 뒤 다시 눌러 주세요.', true);
  }
});
$('retry').addEventListener('click', () => { preparing = prepare(); });
const volumeSlider = $('volume');
const VOLUME_PREF_VERSION = '3';
let savedVolume = null;
let volumePrefVersion = null;
try {
  savedVolume = localStorage.getItem('weight-watch-volume');
  volumePrefVersion = localStorage.getItem('weight-watch-volume-version');
} catch { /* storage can be disabled */ }

// Version 3 restores a 70% default while keeping the stronger audio mastering.
volumeSlider.value = volumePrefVersion === VOLUME_PREF_VERSION ? readVolume(savedVolume) : 70;

function setVolume({ persist = true } = {}) {
  const value = readVolume(volumeSlider.value);
  audio.volume = preview.volume = value / 100;
  $('volumeValue').textContent = `${value}%`;
  if (!persist) return;
  try {
    localStorage.setItem('weight-watch-volume', String(value));
    localStorage.setItem('weight-watch-volume-version', VOLUME_PREF_VERSION);
  } catch { /* optional preference */ }
}

// On touch screens, vertical swipes should scroll the page instead of changing
// the slider. A touch adjustment only starts after a clear horizontal drag.
let volumeTouch = null;
volumeSlider.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return;
  volumeTouch = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startValue: volumeSlider.value,
    dragging: false,
    scrolling: false
  };
});
volumeSlider.addEventListener('pointermove', (event) => {
  if (!volumeTouch || event.pointerId !== volumeTouch.pointerId) return;
  const dx = Math.abs(event.clientX - volumeTouch.startX);
  const dy = Math.abs(event.clientY - volumeTouch.startY);
  if (!volumeTouch.dragging && !volumeTouch.scrolling) {
    if (dy >= 8 && dy > dx) volumeTouch.scrolling = true;
    else if (dx >= 10 && dx > dy) volumeTouch.dragging = true;
  }
  if (!volumeTouch.dragging) {
    volumeSlider.value = volumeTouch.startValue;
    setVolume({ persist: false });
  }
});
volumeSlider.addEventListener('input', () => {
  if (volumeTouch && !volumeTouch.dragging) {
    volumeSlider.value = volumeTouch.startValue;
    setVolume({ persist: false });
    return;
  }
  setVolume();
});
function finishVolumeTouch(event) {
  if (!volumeTouch || event.pointerId !== volumeTouch.pointerId) return;
  if (!volumeTouch.dragging) {
    volumeSlider.value = volumeTouch.startValue;
    setVolume({ persist: false });
  }
  volumeTouch = null;
}
volumeSlider.addEventListener('pointerup', finishVolumeTouch);
volumeSlider.addEventListener('pointercancel', finishVolumeTouch);
setVolume();
audio.addEventListener('pause', () => {
  if (wantsPlay && !audio.ended) {
    wantsPlay = false;
    message('다른 앱이나 기기가 재생을 멈췄습니다. 멀티 사운드 설정을 확인하고 계속하기를 누르세요.', true);
    $('guide').open = true;
  }
  stalled = false;
  render();
});
audio.addEventListener('playing', () => { stalled = false; render(); });
audio.addEventListener('waiting', () => { stalled = true; render(); });
audio.addEventListener('ended', () => { wantsPlay = false; message('120분 운동 완료. 수고하셨습니다!'); render(); });
audio.addEventListener('error', () => {
  if (!ready) return;
  ready = false;
  wantsPlay = false;
  message('음원 재생에 문제가 생겼습니다. 다시 불러와 주세요.', true);
  $('retry').hidden = false;
  render();
});
for (const event of ['timeupdate', 'seeked', 'play']) audio.addEventListener(event, render);
document.addEventListener('visibilitychange', render);
window.addEventListener('pageshow', render);
if ('mediaSession' in navigator) {
  // Do not register seek/next/previous or force focus changes in other players.
  for (const [action, handler] of [['play', play], ['pause', pause], ['stop', pause]]) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* optional */ }
  }
}
preparing = prepare();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(async () => {
    await navigator.serviceWorker.ready;
    await preparing;
    if (!ready) return;
    // Prime full responses explicitly even on the first visit before the SW controls this page.
    const cache = await caches.open(CACHE);
    await cache.addAll(assetURLs);
    $('offlineStatus').textContent = '오프라인 준비 완료. 다음에는 인터넷 없이도 이 페이지와 안내 음원을 사용할 수 있습니다.';
  }).catch(() => {
    $('offlineStatus').textContent = '이번 운동의 음원은 준비되었지만 다음 접속에는 인터넷이 필요할 수 있습니다.';
  });
}
