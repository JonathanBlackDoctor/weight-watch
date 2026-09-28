import { adjustTime, formatTime, nextCue, readVolume } from './timer.js';

const AUDIO_VERSION = 'balanced-v9';
const CACHE = 'weight-watch-v9';
const AUDIO_DB = 'weight-watch-audio';
const AUDIO_DB_STORE = 'tracks';
const assetURL = (path) => `./assets/${path}?v=${AUDIO_VERSION}`;

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const preview = $('preview');
let ready = false;
let loading = false;
let wantsPlay = false;
let pendingPlay = false;
let stalled = false;
let autoplayBlocked = false;
let trackURL;
let sampleURL;
let operation = 0;
let preparing;
let assetURLs = [];
let audioContext;
let timerGain;
let previewGain;
let compressor;
let masterGain;
let previewBlob;
let previewBuffer;
let previewSourceNode;
// Push the source into a compressor for perceived loudness, but never boost
// after compression. The old 8x -> compressor -> 5x chain clipped badly.
const PRE_GAIN = 3;
const MASTER_GAIN = 0.95;

function ensureAudioBoost() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();

    const timerSource = audioContext.createMediaElementSource(audio);
    timerGain = audioContext.createGain();
    previewGain = audioContext.createGain();
    compressor = audioContext.createDynamicsCompressor();
    masterGain = audioContext.createGain();

    // Drive both the quieter buzzer and louder speech into the same strong
    // compressor, then restore level afterwards. This narrows their loudness
    // difference while making 70% substantially louder than the old mix.
    timerGain.gain.value = PRE_GAIN;
    previewGain.gain.value = PRE_GAIN * (readVolume($('volume').value) / 100);
    compressor.threshold.value = -12;
    compressor.knee.value = 4;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.12;
    masterGain.gain.value = MASTER_GAIN;

    timerSource.connect(timerGain).connect(compressor);
    previewGain.connect(compressor);
    compressor.connect(masterGain).connect(audioContext.destination);
  }
  if (audioContext.state === 'suspended') return audioContext.resume();
}

async function playStartCue() {
  await ensureAudioBoost();
  if (!audioContext) return;

  const now = audioContext.currentTime;
  const cueGain = audioContext.createGain();
  const level = PRE_GAIN * (readVolume($('volume').value) / 100);
  cueGain.gain.setValueAtTime(0.0001, now);
  cueGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), now + 0.015);
  cueGain.gain.setValueAtTime(Math.max(0.0001, level), now + 0.42);
  cueGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  cueGain.connect(compressor);

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

function openAudioDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return resolve(null);
    const request = indexedDB.open(AUDIO_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUDIO_DB_STORE)) {
        request.result.createObjectStore(AUDIO_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readStoredTrack(name, expectedBytes) {
  const db = await openAudioDB();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(AUDIO_DB_STORE, 'readonly').objectStore(AUDIO_DB_STORE).get(`${AUDIO_VERSION}:${name}`);
    request.onsuccess = () => {
      const blob = request.result;
      resolve(blob instanceof Blob && blob.size === expectedBytes ? blob : null);
    };
    request.onerror = () => resolve(null);
  });
}

async function storeTrack(name, blob) {
  const db = await openAudioDB();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(AUDIO_DB_STORE, 'readwrite');
    tx.objectStore(AUDIO_DB_STORE).put(blob, `${AUDIO_VERSION}:${name}`);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

async function loadTrack(manifest, name) {
  const track = manifest.tracks[name];
  const stored = await readStoredTrack(name, track.bytes);
  if (stored) return stored;

  const parts = await Promise.all(track.parts.map(async (part) => {
    const result = await fetch(assetURL(part));
    if (!result.ok) throw new Error('audio download');
    const decoded = atob((await result.text()).trim());
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }));
  const blob = new Blob(parts, { type: manifest.mime });
  if (blob.size !== track.bytes) throw new Error('audio size');

  // Integrity-check only the first assembly. Later launches use the verified Blob
  // directly from IndexedDB instead of decoding ~3.6 MB of Base64 again.
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const checksum = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (checksum !== track.sha256) throw new Error('audio integrity');
  await storeTrack(name, blob);
  return blob;
}

async function loadAudio() {
  const response = await fetch(assetURL('audio.json'));
  if (!response.ok) throw new Error('audio manifest');
  const manifest = await response.json();
  assetURLs = [assetURL('audio.json'), ...Object.values(manifest.tracks).flatMap((track) => track.parts.map((part) => assetURL(part)))];
  return Promise.all(['timer', 'preview'].map((name) => loadTrack(manifest, name)));
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
  $('rewind5').disabled = !ready || pendingPlay || audio.currentTime <= 0;
  $('forward5').disabled = !ready || pendingPlay || audio.currentTime >= 120 * 60;
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
    previewBlob = sample;
    previewBuffer = null;
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
  if (ready) {
    // Start as soon as the page is ready. Browsers that allow audible autoplay
    // will begin immediately; blocked browsers fall back to the first neutral tap.
    await play({ automatic: true });
  }
}

async function play({ automatic = false } = {}) {
  if (!ready || pendingPlay) return;
  const token = ++operation;
  pendingPlay = true;
  wantsPlay = true;
  stalled = false;
  preview.pause();
  preview.currentTime = 0;
  if (previewSourceNode) {
    try { previewSourceNode.stop(); } catch { /* already stopped */ }
    previewSourceNode = null;
  }
  if (audio.ended) audio.currentTime = 0;
  render();
  try {
    await ensureAudioBoost();
    const startingFresh = audio.currentTime < 0.1;
    if (startingFresh) await playStartCue();
    await audio.play();
    if (token !== operation) return;
    autoplayBlocked = false;
    message('30초마다 짧은 소리, 매분 경과 시간을 알려드려요.');
  } catch {
    if (token !== operation) return;
    wantsPlay = false;
    if (automatic) {
      autoplayBlocked = true;
      message('브라우저가 자동 소리 재생을 막았습니다. 화면 빈 곳을 한 번 터치하면 바로 시작합니다.', true);
    } else {
      message('재생이 중단되었습니다. 시작을 다시 눌러 주세요.', true);
    }
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

async function resumeBlockedAutoplay(event) {
  if (!autoplayBlocked || !ready || pendingPlay || !audio.paused) return;
  const interactive = event.target?.closest?.('button,input,summary,a');
  if (interactive) return;
  await play();
}
document.addEventListener('pointerdown', resumeBlockedAutoplay);
document.addEventListener('keydown', (event) => {
  if (autoplayBlocked && (event.key === 'Enter' || event.key === ' ')) play();
});
$('reset').addEventListener('click', () => {
  pause();
  audio.currentTime = 0;
  preview.pause();
  preview.currentTime = 0;
  if (previewSourceNode) {
    try { previewSourceNode.stop(); } catch { /* already stopped */ }
    previewSourceNode = null;
  }
  message('00:00으로 돌아왔습니다. 준비되면 시작하세요.');
  render();
});
function seekBy(delta) {
  if (!ready || pendingPlay) return;
  audio.currentTime = adjustTime(audio.currentTime, delta);
  message(`${delta > 0 ? '+' : '−'}5초 이동했습니다.`);
  render();
}
$('rewind5').addEventListener('click', () => seekBy(-5));
$('forward5').addEventListener('click', () => seekBy(5));
$('soundTest').addEventListener('click', async () => {
  if (!audio.paused || !ready || !previewBlob) return;
  try {
    await ensureAudioBoost();
    if (!audioContext) throw new Error('Web Audio unavailable');
    if (!previewBuffer) {
      previewBuffer = await audioContext.decodeAudioData(await previewBlob.arrayBuffer());
    }
    if (previewSourceNode) {
      try { previewSourceNode.stop(); } catch { /* already stopped */ }
    }
    previewSourceNode = audioContext.createBufferSource();
    previewSourceNode.buffer = previewBuffer;
    previewSourceNode.connect(previewGain);
    previewSourceNode.onended = () => { previewSourceNode = null; };
    previewSourceNode.start();
    message('부저와 음성 안내를 차례로 미리 듣는 중입니다.');
  } catch {
    message('미리 듣기를 재생하지 못했습니다. 브라우저의 미디어 재생 권한을 확인해 주세요.', true);
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
  if (previewGain) previewGain.gain.value = PRE_GAIN * (value / 100);
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
