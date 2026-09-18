$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$projectRoot = Split-Path -Parent $PSScriptRoot
$voiceFolder = Join-Path $projectRoot '작업파일/voices'
New-Item -ItemType Directory -Force -Path $voiceFolder | Out-Null
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.SelectVoice('Microsoft Heami Desktop')
$speaker.Rate = 0
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
try {
  1..120 | ForEach-Object {
    $speaker.SetOutputToWaveFile((Join-Path $voiceFolder "$_.wav"), $format)
    $speaker.Speak("$_ 분")
    $speaker.SetOutputToNull()
  }
} finally { $speaker.Dispose() }
Write-Output 'Generated 120 Korean minute announcements.'
