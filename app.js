import { formatTime, nextCue, readVolume } from './timer.js';

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

async function loadAudio() {
  const response = await fetch('./assets/audio.json');
  if (!response.ok) throw new Error('audio manifest');
  const manifest = await response.json();
  assetURLs = ['./assets/audio.json', ...Object.values(manifest.tracks).flatMap((track) => track.parts.map((part) => `./assets/${part}`))];
  return Promise.all(['timer', 'preview'].map(async (name) => {
    const track = manifest.tracks[name];
    const parts = await Promise.all(track.parts.map(async (part) => {
      const result = await fetch(`./assets/${part}`);
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
    ready = true;
    message('음악을 켜고 시작하세요. 첫 사용에는 화면 잠금 테스트를 해주세요.');
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
  if (!audio.paused) return;
  preview.currentTime = 0;
  try { await preview.play(); } catch { message('소리 재생을 허용한 뒤 다시 눌러 주세요.', true); }
});
$('retry').addEventListener('click', () => { preparing = prepare(); });
let savedVolume = null;
try { savedVolume = localStorage.getItem('weight-watch-volume'); } catch { /* storage can be disabled */ }
$('volume').value = readVolume(savedVolume);
function setVolume() {
  const value = readVolume($('volume').value);
  audio.volume = preview.volume = value / 100;
  $('volumeValue').textContent = `${value}%`;
  try { localStorage.setItem('weight-watch-volume', String(value)); } catch { /* optional preference */ }
}
$('volume').addEventListener('input', setVolume);
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
  navigator.serviceWorker.register('./sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    await preparing;
    if (!ready) return;
    // Prime full responses explicitly even on the first visit before the SW controls this page.
    const cache = await caches.open('weight-watch-v2');
    await cache.addAll(assetURLs);
    $('offlineStatus').textContent = '오프라인 준비 완료. 다음에는 인터넷 없이도 이 페이지와 안내 음원을 사용할 수 있습니다.';
  }).catch(() => {
    $('offlineStatus').textContent = '이번 운동의 음원은 준비되었지만 다음 접속에는 인터넷이 필요할 수 있습니다.';
  });
}
