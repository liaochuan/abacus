#requires -Version 5.1
<#
.SYNOPSIS
  Builds the signed release APK of Abacus (arm64-v8a only).

.DESCRIPTION
  Steps:
    1. Resolve Android SDK / JDK / keystore settings (param > env > config file > default).
    2. Run `npx expo prebuild --platform android --no-install` unless -SkipPrebuild.
    3. Run `gradlew :app:assembleRelease -PreactNativeArchitectures=<arch>`.
    4. Verify the APK signature with apksigner and copy it to dist/.

  Settings file (gitignored, created once):
    scripts/android-release.local.json
      {
        "androidHome":   "E:\\\\path\\\\to\\\\Android\\\\Sdk",
        "javaHome":      "E:\\\\path\\\\to\\\\jdk-17",
        "storeFile":     "E:\\\\path\\\\to\\\\keystore",
        "keyAlias":      "key0",
        "storePassword": "...",
        "keyPassword":   "..."
      }

  Environment variables always win over the settings file:
    ANDROID_HOME / ANDROID_SDK_ROOT, JAVA_HOME,
    ABACUS_UPLOAD_STORE_FILE, ABACUS_UPLOAD_STORE_PASSWORD,
    ABACUS_UPLOAD_KEY_ALIAS, ABACUS_UPLOAD_KEY_PASSWORD

.EXAMPLE
  .\scripts\build-android-release.ps1

.EXAMPLE
  .\scripts\build-android-release.ps1 -SkipPrebuild -Architectures arm64-v8a,x86_64
#>
[CmdletBinding()]
param(
  [string]$Architectures = 'arm64-v8a',
  [switch]$SkipPrebuild,
  [switch]$SkipVerify,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('ConfigPath')) {
  $ConfigPath = Join-Path $PSScriptRoot 'android-release.local.json'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$script:settings = @{}
if (Test-Path -Path $ConfigPath -PathType Leaf) {
  $json = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($property in $json.PSObject.Properties) {
    $script:settings[$property.Name] = $property.Value
  }
} else {
  Write-Host "[warn] settings file not found: $ConfigPath" -ForegroundColor Yellow
}

function Get-Setting {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$EnvName,
    [string]$Default
  )

  if ($EnvName) {
    $envValue = [System.Environment]::GetEnvironmentVariable($EnvName)
    if ($envValue) { return $envValue }
  }

  if ($script:settings.ContainsKey($Name) -and $script:settings[$Name]) {
    return [string]$script:settings[$Name]
  }

  return $Default
}

function Read-Secret {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Resolve-FirstExisting {
  param([string[]]$Candidates)

  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -Path $candidate)) { return $candidate }
  }

  return $null
}

# Native tools (node, gradle) write warnings to stderr; with $ErrorActionPreference = 'Stop'
# PowerShell 5.1 turns those into terminating errors. Route them through cmd so only the
# exit code matters.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Write-Host "==> $Label" -ForegroundColor Cyan
  # 在 cmd 层把 stderr 并进 stdout：否则 PowerShell 5.1 会把原生工具的告警
  # （例如 gradle 打印的 NODE_ENV 提示）当成终止错误，脚本会在拿到退出码前中断。
  & cmd /c "$CommandLine 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}

# ---------------------------------------------------------------- keystore ---
$storeFile = Get-Setting -Name 'storeFile' -EnvName 'ABACUS_UPLOAD_STORE_FILE'
$keyAlias = Get-Setting -Name 'keyAlias' -EnvName 'ABACUS_UPLOAD_KEY_ALIAS'
$storePassword = Get-Setting -Name 'storePassword' -EnvName 'ABACUS_UPLOAD_STORE_PASSWORD'
$keyPassword = Get-Setting -Name 'keyPassword' -EnvName 'ABACUS_UPLOAD_KEY_PASSWORD'

if (-not $storeFile) { throw 'Keystore path is not configured. Set storeFile in the settings file or ABACUS_UPLOAD_STORE_FILE.' }
if (-not (Test-Path -Path $storeFile -PathType Leaf)) { throw "Keystore not found: $storeFile" }
if (-not $keyAlias) { throw 'Key alias is not configured. Set keyAlias or ABACUS_UPLOAD_KEY_ALIAS.' }
if (-not $storePassword) { $storePassword = Read-Secret -Prompt 'Keystore password' }
if (-not $keyPassword) { $keyPassword = Read-Secret -Prompt 'Key password' }

# ------------------------------------------------------------------- tools ---
$androidHome = Get-Setting -Name 'androidHome' -EnvName 'ANDROID_HOME'
if (-not $androidHome) { $androidHome = Get-Setting -Name 'androidHome' -EnvName 'ANDROID_SDK_ROOT' }

if (-not $androidHome) {
  $localProperties = Join-Path $repoRoot 'android\local.properties'
  if (Test-Path -Path $localProperties) {
    $sdkLine = Get-Content -Path $localProperties | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
    if ($sdkLine) { $androidHome = ($sdkLine -replace '^sdk\.dir=', '').Trim() -replace '/', '\' }
  }
}

if (-not $androidHome) {
  $androidHome = Resolve-FirstExisting -Candidates @(
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    'E:\Code\SDK\android'
  )
}

if (-not $androidHome -or -not (Test-Path -Path $androidHome)) {
  throw 'Android SDK not found. Set androidHome in the settings file or ANDROID_HOME.'
}

$javaHome = Get-Setting -Name 'javaHome' -EnvName 'JAVA_HOME'
if (-not $javaHome) {
  $javaHome = Resolve-FirstExisting -Candidates @(
    'E:\Code\SDK\jdk\corretto-17.0.17',
    'E:\Code\SDK\jdk\corretto-21.0.9',
    'D:\Android Studio\jbr',
    'C:\Program Files\Android\Android Studio\jbr'
  )
}

if (-not $javaHome -or -not (Test-Path -Path (Join-Path $javaHome 'bin\java.exe'))) {
  throw 'JDK 17 or 21 not found. Set javaHome in the settings file or JAVA_HOME.'
}

$env:ANDROID_HOME = $androidHome
$env:ANDROID_SDK_ROOT = $androidHome
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;$androidHome\platform-tools;$env:Path"
$env:ABACUS_UPLOAD_STORE_FILE = (Resolve-Path -Path $storeFile).Path
$env:ABACUS_UPLOAD_STORE_PASSWORD = $storePassword
$env:ABACUS_UPLOAD_KEY_ALIAS = $keyAlias
$env:ABACUS_UPLOAD_KEY_PASSWORD = $keyPassword

Write-Host "Android SDK : $androidHome"
Write-Host "JDK         : $javaHome"
Write-Host "Keystore    : $env:ABACUS_UPLOAD_STORE_FILE (alias $keyAlias)"
Write-Host "Architectures: $Architectures"

# ---------------------------------------------------------------- prebuild ---
if (-not $SkipPrebuild) {
  Invoke-Native -Label 'expo prebuild' -CommandLine 'npx expo prebuild --platform android --no-install'
}

$androidProject = Join-Path $repoRoot 'android'
$localProperties = Join-Path $androidProject 'local.properties'
if (-not (Test-Path -Path $localProperties)) {
  "sdk.dir=$(($androidHome -replace '\\', '/'))" | Set-Content -Path $localProperties -Encoding ASCII
}

# ------------------------------------------------------------------ gradle ---
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$apk = Join-Path $androidProject 'app\build\outputs\apk\release\app-release.apk'
# 先删除旧产物：构建失败时不能把上一轮留下的 APK 当成本次结果复制出去。
if (Test-Path -Path $apk) { Remove-Item -Path $apk -Force }

Push-Location $androidProject
try {
  Invoke-Native -Label 'gradlew :app:assembleRelease' -CommandLine ".\gradlew.bat :app:assembleRelease `"-PreactNativeArchitectures=$Architectures`" --no-daemon"
} finally {
  Pop-Location
}

$stopwatch.Stop()

# ------------------------------------------------------------------- output ---
if (-not (Test-Path -Path $apk)) { throw "APK not found: $apk" }

$buildTools = Get-ChildItem -Path (Join-Path $androidHome 'build-tools') -Directory -ErrorAction SilentlyContinue |
  Sort-Object -Property Name -Descending |
  Select-Object -First 1

$versionCode = 'unknown'
$versionName = 'unknown'
if ($buildTools) {
  $aapt2 = Join-Path $buildTools.FullName 'aapt2.exe'
  if (Test-Path -Path $aapt2) {
    $packageLine = & $aapt2 dump badging $apk 2>$null | Where-Object { $_ -like 'package:*' } | Select-Object -First 1
    if ($packageLine -match "versionCode='(\d+)'") { $versionCode = $Matches[1] }
    if ($packageLine -match "versionName='([^']+)'") { $versionName = $Matches[1] }
  }
}

$distDir = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$artifactName = "abacus-$versionName-$versionCode-$($Architectures -replace ',', '_').apk"
$artifact = Join-Path $distDir $artifactName
Copy-Item -Path $apk -Destination $artifact -Force

# ------------------------------------------------------------------- verify ---
$signatureState = 'not verified'
if (-not $SkipVerify) {
  $apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
  if (Test-Path -Path $apksigner) {
    $verifyOutput = & cmd /c "`"$apksigner`" verify --print-certs `"$artifact`" 2>&1"
    if ($LASTEXITCODE -ne 0) {
      $signatureState = 'INVALID'
      $verifyOutput | ForEach-Object { "  $_" }
    } else {
      $signatureState = 'valid'
      $verifyOutput | Where-Object { $_ -match 'certificate (DN|SHA-256 digest)' } | ForEach-Object { "  $_" }
    }
  }
}

$sizeMb = [math]::Round((Get-Item -Path $artifact).Length / 1MB, 1)
$sha256 = (Get-FileHash -Path $artifact -Algorithm SHA256).Hash

Write-Host ''
Write-Host '==> done' -ForegroundColor Green
Write-Host "APK         : $artifact"
Write-Host "Package     : $(if ($packageLine) { ($packageLine -replace "^package: name='", '') -replace "'.*$", '' } else { 'unknown' })"
Write-Host "Version     : $versionName ($versionCode)"
Write-Host "ABI         : $Architectures"
Write-Host "Size        : $sizeMb MB"
Write-Host "SHA-256     : $sha256"
Write-Host "Signature   : $signatureState"
Write-Host "Elapsed     : $([math]::Round($stopwatch.Elapsed.TotalMinutes, 1)) min"
