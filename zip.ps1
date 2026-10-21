# Vuora 拡張機能パッケージ生成スクリプト
# 使い方:
#   pwsh -NoProfile -File zip.ps1                    # Chrome + Firefox 両方
#   pwsh -NoProfile -File zip.ps1 -Target chrome     # Chrome のみ
#   pwsh -NoProfile -File zip.ps1 -Target firefox    # Firefox のみ
#
# Firefox 版は manifest.firefox.json を manifest.json として同梱し、xpi 拡張子で出力する。
# 音量ブースター関連 (offscreen / tabCapture) は Firefox MV3 未対応のため除外されている。

param(
    [ValidateSet("chrome","firefox","both")]
    [string]$Target = "both"
)

# 検証済みの作業対象だけを標準APIで削除する。
function Remove-LocalWorkItem {
    param([string[]]$LiteralPath, [string]$AllowedRoot, [switch]$IgnoreMissing, [switch]$AllowLeafJunction)
    if ([string]::IsNullOrWhiteSpace($AllowedRoot) -or -not [IO.Path]::IsPathRooted($AllowedRoot)) { throw 'Cleanup root must be absolute.' }
    $boundary = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    foreach ($target in $LiteralPath) {
        if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) { throw 'Cleanup target must be absolute.' }
        $resolved = [IO.Path]::GetFullPath($target)
        if (-not $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup target is outside the allowed root.' }
        $ancestor = $resolved
        while ($ancestor) {
            if (Test-Path -LiteralPath $ancestor) {
                $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
                if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not ($AllowLeafJunction -and $ancestor -eq $resolved -and $item.LinkType -eq 'Junction')) { throw 'Cleanup path contains a reparse point.' }
            }
            $ancestor = Split-Path $ancestor -Parent
        }
        if (-not (Test-Path -LiteralPath $resolved)) { if ($IgnoreMissing) { continue }; throw "Cleanup target is missing: $resolved" }
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        $leafLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($item.PSIsContainer -and -not $leafLink) {
            if (@(Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Cleanup directory contains a reparse point.' }
        }
        Remove-Item -LiteralPath $resolved -Recurse:($item.PSIsContainer -and -not $leafLink) -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $resolved) { throw "Cleanup target remains: $resolved" }
    }
}

$ErrorActionPreference = "Stop"

Write-Host "拡張機能パッケージを生成中... (Target: $Target)" -ForegroundColor Cyan
Write-Host ""

# スクリプトのディレクトリをカレントディレクトリに設定。
# `-File` 実行では MyCommand.Path が必ず得られ、Windows PowerShell 5.1 でも解釈できる。
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($scriptDir) { Set-Location $scriptDir }

# 依存インストール & アイコン生成
Write-Host "依存パッケージを lockfile どおりにインストール中..." -ForegroundColor Yellow
pnpm install --frozen-lockfile --silent
if ($LASTEXITCODE -ne 0) {
    Write-Host "pnpm install --frozen-lockfile に失敗しました (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host "アイコンを生成中..." -ForegroundColor Yellow
node scripts/generate-icons.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "アイコン生成に失敗しました (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

function Build-Package {
    param(
        [string]$Variant,        # "chrome" | "firefox"
        [string]$ManifestSource, # "manifest.json" | "manifest.firefox.json"
        [string]$OutputName      # "web-viewing-assist-chrome.zip" | "web-viewing-assist-firefox.xpi"
    )

    Write-Host ""
    Write-Host "==== $Variant 版をビルド中 ====" -ForegroundColor Cyan

    if (Test-Path $OutputName) {
        Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputName)) -AllowedRoot $PSScriptRoot
    }

    $tempDir = "temp-build-$Variant"
    if (Test-Path $tempDir) { Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempDir)) -AllowedRoot $PSScriptRoot }
    New-Item -ItemType Directory -Path $tempDir | Out-Null

    Write-Host "ファイルをコピー中 ($ManifestSource → manifest.json)..." -ForegroundColor Yellow
    # Firefox 版は manifest.firefox.json を manifest.json として配置する。
    # Chrome 版は manifest.json をそのまま使う。
    Copy-Item $ManifestSource -Destination "$tempDir/manifest.json"
    Copy-Item "icons" -Destination $tempDir -Recurse
    Copy-Item "src" -Destination $tempDir -Recurse
    Copy-Item "_locales" -Destination $tempDir -Recurse

    # 不要ファイル除去
    Get-ChildItem -Path $tempDir -Recurse -Include "*.DS_Store","*.swp","*~" | ForEach-Object { Remove-LocalWorkItem -LiteralPath $_.FullName -AllowedRoot $PSScriptRoot -IgnoreMissing }

    if ($Variant -eq "firefox") {
        # Firefox 版は chrome.offscreen / chrome.tabCapture の呼び出しブロックを物理削除する。
        # AMO linter の UNSUPPORTED_API 警告 3 件を消すため、__FIREFOX_STRIP_BEGIN__ から
        # __FIREFOX_STRIP_END__ までを (マーカー行を含めて) 削除する。
        $bgPath = "$tempDir/src/background/background.js"
        $content = Get-Content $bgPath -Raw
        $stripped = [regex]::Replace($content, '(?s)\s*//\s*__FIREFOX_STRIP_BEGIN__.*?//\s*__FIREFOX_STRIP_END__\s*\r?\n', "`n")
        Set-Content -Path $bgPath -Value $stripped -NoNewline -Encoding UTF8
        Write-Host "Firefox build: background.js の chrome.offscreen / chrome.tabCapture 呼び出しを strip 済み" -ForegroundColor DarkGray
    }

    Write-Host "アーカイブを作成中..." -ForegroundColor Cyan
    # Compress-Archive は zip 形式。Firefox 用は拡張子を xpi に変えるだけで Firefox AMO が受理する。
    $tempZip = "$OutputName.tmp.zip"
    if (Test-Path $tempZip) { Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempZip)) -AllowedRoot $PSScriptRoot }
    Compress-Archive -Path "$tempDir/*" -DestinationPath $tempZip -Force
    Move-Item -Path $tempZip -Destination $OutputName -Force

    Remove-LocalWorkItem -LiteralPath ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($tempDir)) -AllowedRoot $PSScriptRoot

    if (Test-Path $OutputName) {
        $size = (Get-Item $OutputName).Length
        $sizeKB = [math]::Round($size / 1KB, 2)
        Write-Host "$Variant 版 作成成功: $OutputName ($sizeKB KB)" -ForegroundColor Green
    } else {
        Write-Host "$Variant 版 作成に失敗しました" -ForegroundColor Red
        exit 1
    }
}

if ($Target -eq "chrome" -or $Target -eq "both") {
    Build-Package -Variant "chrome" -ManifestSource "manifest.json" -OutputName "web-viewing-assist-chrome.zip"
}
if ($Target -eq "firefox" -or $Target -eq "both") {
    Build-Package -Variant "firefox" -ManifestSource "manifest.firefox.json" -OutputName "web-viewing-assist-firefox.xpi"
}

Write-Host ""
Write-Host "✨ パッケージング完了" -ForegroundColor Green
Write-Host "   Chrome Web Store: https://chrome.google.com/webstore/devconsole" -ForegroundColor Blue
Write-Host "   Firefox AMO:      https://addons.mozilla.org/developers/" -ForegroundColor Blue
