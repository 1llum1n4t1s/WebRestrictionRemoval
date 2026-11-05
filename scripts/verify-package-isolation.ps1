param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Root) -or (Test-Path -LiteralPath $Root)) { throw 'Use a new absolute verification root.' }
$ancestor = Split-Path $Root -Parent
while ($ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in verification root.' }
    $ancestor = Split-Path $ancestor -Parent
}
New-Item -ItemType Directory -Path $Root | Out-Null
[IO.File]::WriteAllText("$Root/write-probe", 'ok')
$fixture = "$Root/fixture"
foreach ($dir in @('scripts','icons','src/background','src/offscreen','src/content','_locales','temp-build-chrome','temp-build-firefox')) {
    New-Item -ItemType Directory -Path "$fixture/$dir" -Force | Out-Null
}
foreach ($dir in @('work','output','tmp')) { New-Item -ItemType Directory -Path "$Root/$dir" | Out-Null }
$repo = Split-Path $PSScriptRoot -Parent
Copy-Item "$repo/zip.ps1","$repo/zip.sh" $fixture
Copy-Item "$repo/scripts/copy-package-files.js","$repo/scripts/strip-firefox-background.js" "$fixture/scripts"
[IO.File]::WriteAllText("$fixture/package.json", '{"scripts":{"deps":"bun scripts/noop.js","sync:support":"bun scripts/noop.js"}}')
foreach ($file in @('noop.js','generate-icons.js')) { [IO.File]::WriteAllText("$fixture/scripts/$file", '') }
foreach ($variant in @('chrome','firefox')) {
    $name = if ($variant -eq 'chrome') { 'manifest.json' } else { 'manifest.firefox.json' }
    [IO.File]::WriteAllText("$fixture/$name", ('{"name":"' + $variant + '","manifest_version":3}'))
}
[IO.File]::WriteAllText("$fixture/src/background/background.js", "keep();`n// __FIREFOX_STRIP_BEGIN__`nchrome.offscreen();`n// __FIREFOX_STRIP_END__`nend();`n")
$sentinels = @('temp-build-chrome/sentinel','temp-build-firefox/sentinel','web-viewing-assist.zip','web-restriction-remover.zip')
foreach ($file in ($sentinels + @('src/offscreen/offscreen.js','src/content/volume-booster-mes.js','icons/icon.svg','_locales/messages.json'))) {
    [IO.File]::WriteAllText("$fixture/$file", 'sentinel')
}
$env:TEMP = "$Root/tmp"
$env:TMP = $env:TEMP
& pwsh -NoProfile -File "$fixture/zip.ps1" -WorkRoot "$Root/work" -OutputRoot "$Root/output" -KeepWork
if ($LASTEXITCODE) { throw 'Packaging failed.' }
foreach ($variant in @('chrome','firefox')) {
    $name = if ($variant -eq 'chrome') { 'web-viewing-assist-chrome.zip' } else { 'web-viewing-assist-firefox.xpi' }
    $zip = [IO.Compression.ZipFile]::OpenRead("$Root/output/$name")
    try {
        $entry = $zip.GetEntry('manifest.json')
        $reader = [IO.StreamReader]::new($entry.Open())
        try { if (($reader.ReadToEnd() | ConvertFrom-Json).name -ne $variant) { throw 'Wrong manifest.' } } finally { $reader.Dispose() }
        $reader = [IO.StreamReader]::new($zip.GetEntry('src/background/background.js').Open())
        try { $background = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if (($background.Contains('chrome.offscreen')) -ne ($variant -eq 'chrome')) { throw 'Wrong Firefox strip.' }
        if ([bool]$zip.GetEntry('src/offscreen/offscreen.js') -ne ($variant -eq 'chrome')) { throw 'Wrong offscreen selection.' }
        if ([bool]$zip.GetEntry('src/content/volume-booster-mes.js') -ne ($variant -eq 'firefox')) { throw 'Wrong MES selection.' }
    } finally { $zip.Dispose() }
}
$before = Get-FileHash "$Root/output/web-viewing-assist-chrome.zip"
# 出力先へのコピーを途中で失敗させ、未完 staging のみ残ることを確認する。
$wrapper = [IO.File]::ReadAllText("$fixture/zip.ps1")
if (-not $wrapper.Contains('$source.CopyTo($destination)')) { throw 'Copy injection boundary missing.' }
[IO.File]::WriteAllText("$fixture/zip.ps1", $wrapper.Replace('$source.CopyTo($destination)', '$destination.WriteByte(80); throw "Injected partial archive copy failure"'))
& pwsh -NoProfile -File "$fixture/zip.ps1" -Target chrome -WorkRoot "$Root/work" -OutputRoot "$Root/output" -KeepWork
if ($LASTEXITCODE -eq 0) { throw 'Expected archive copy failure.' }
if ((Get-FileHash "$Root/output/web-viewing-assist-chrome.zip").Hash -ne $before.Hash) { throw 'Existing artifact changed during partial copy.' }
if (@(Get-ChildItem "$Root/output" -Force -Filter '.package-*.zip' | Where-Object Length -eq 1).Count -ne 1) { throw 'Partial staging file not observed.' }
[IO.File]::WriteAllText("$fixture/zip.ps1", $wrapper)
# コピー工程を失敗させ、既存成果物が置換されないことを確認する。
[IO.File]::WriteAllText("$fixture/scripts/copy-package-files.js", 'process.exit(7);')
& pwsh -NoProfile -File "$fixture/zip.ps1" -Target chrome -WorkRoot "$Root/work" -OutputRoot "$Root/output" -KeepWork
if ($LASTEXITCODE -eq 0) { throw 'Expected packaging failure.' }
if ((Get-FileHash "$Root/output/web-viewing-assist-chrome.zip").Hash -ne $before.Hash) { throw 'Existing artifact changed on failure.' }
foreach ($file in $sentinels) { if ([IO.File]::ReadAllText("$fixture/$file") -ne 'sentinel') { throw "Sentinel changed: $file" } }
Write-Host 'PASS: manifests, variant content, Firefox strip, sentinels, failure preservation. Work retained for explicit cleanup.'
