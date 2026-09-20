# Weight Watch

Firefox for Android를 우선 지원하는 한국어 운동 음성 타이머.

- 00:30 0.7초 비프 → 01:00 “1분” → 01:30 비프 → 02:00 “2분”. 최대 120분.
- 무음과 모든 안내가 포함된 하나의 Opus 음원을 다운로드한 뒤 재생한다. 화면 표시용 이벤트가 지연되어도 음원 속 안내 시점은 변하지 않는다.
- 시작·일시정지·재개·초기화, 음량 조절, 소리 미리 듣기, 오프라인 캐시.
- 서버·회원가입·외부 API·추적기 없음. 설정은 기기에만 저장한다.

## 갤럭시에서 사용

음악을 재생한 뒤 Firefox에서 타이머를 시작한다. 음악이 멈추면 Samsung Good Lock의 Sound Assistant → 멀티 사운드에서 Firefox 동시 재생을 허용한다. 필요하면 Firefox의 배터리 백그라운드 제한을 해제한다. 실제 One UI 버전에 따라 메뉴가 다를 수 있다.

YouTube의 자체 백그라운드 재생 조건은 별도다. 같은 브라우저의 두 탭은 충돌할 수 있으므로 음악 앱 또는 다른 브라우저 조합을 우선한다. 화면 잠금·절전·통화·Bluetooth 조건에 따른 실제 동작은 기기에서 검증해야 한다. 이 앱은 OS 실행 제한을 무력화하거나 다른 앱의 재생을 제어하지 않는다.

재생이 멈추면 경과 시간도 멈춘다. 일시정지 시간은 운동 시간에서 제외된다. 탭 강제 종료·새로고침 후 자동 재개하지 않는다. 종료 안내를 끝까지 들려주기 위해 음원은 120분 4초이며 표시 시간은 120:00에서 멈춘다.

## 개발과 배포

별도 빌드 없는 HTML/CSS/ES modules. `npm test`, `npm run check`로 검증한다. HTTP 서버로 저장소 루트를 제공하면 로컬에서 사용할 수 있다.

GitHub Pages Source를 **GitHub Actions**로 설정한다. `main` push 후 공개 파일만 배포한다. 프로젝트 경로(`/weight-watch/`)와 서비스워커 범위는 상대 URL로 처리한다.

`scripts/make-voices.ps1`은 Windows 한국어 Heami 음성을 생성한다. `scripts/build-audio.py`는 NumPy·imageio-ffmpeg로 음량을 정규화하고 240개 안내를 하나의 타임라인에 배치한다. 생성 시 모든 이벤트 위치와 무음 여부를 검사하며 `assets/timeline.json`에 기록한다. 이어서 `scripts/package-audio.py`를 실행하면 배포용 Opus 음원을 base64 조각과 `assets/audio.json`으로 만든다. 브라우저는 조각을 복원하고 SHA-256을 검증하여 하나의 Blob으로 재생한다. 음성은 빌드 시에만 생성하며 사용자 브라우저의 TTS에 의존하지 않는다.

## 기기 검증

S24 울트라 + Firefox + 실제 이어폰에서 MP3, YouTube Music, YouTube 앱, YouTube 웹 각각 30분 잠금 테스트. 목표는 안내 누락·중복 및 음악 강제 정지 0회, 고정 Bluetooth 지연을 고려한 안내 오차 ±1초. OS·Firefox 버전과 멀티 사운드 설정을 함께 기록한다. 데스크톱 테스트를 실기기 통과로 간주하지 않는다.
