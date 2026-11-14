# Renders each scene's narration to out/video/audio/<id>.wav with Windows' built-in voice.
param([string]$ScenesJson = 'out/video/scenes.json', [string]$OutDir = 'out/video/audio', [string]$Voice = 'Microsoft Zira Desktop')
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$scenes = Get-Content $ScenesJson -Raw | ConvertFrom-Json
foreach ($s in $scenes) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($Voice)
  $synth.Rate = 1
  $path = Join-Path (Resolve-Path $OutDir) "$($s.id).wav"
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($s.text)
  $synth.Dispose()
  Write-Output "wav $($s.id)"
}
