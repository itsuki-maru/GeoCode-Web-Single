#Requires -Version 7.0
<#
Run with: pwsh -NoProfile -File tests/setup-japan-local-tiles.test.ps1
Uses only isolated target fixtures, a native command mock, and mocked HTTP downloads.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $PSScriptRoot '../target/japan-local-tiles-tests'
$testRoot = [IO.Path]::GetFullPath((Join-Path $testRoot ([guid]::NewGuid().ToString('N'))))
$fixtureRoot = Join-Path $testRoot '日本語 fixtures with spaces'
$null = New-Item -ItemType Directory -Path $fixtureRoot -Force
$utf8 = [Text.UTF8Encoding]::new($false)
$pwsh = (Get-Process -Id $PID).Path
$subject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts/setup-japan-local-tiles.ps1'))
$mockScript = Join-Path $fixtureRoot 'mock-cli.ps1'
$mockCommand = Join-Path $fixtureRoot 'mock native command.cmd'
$launcher = Join-Path $fixtureRoot 'launch.ps1'
$datasetId = 'a' * 64
$normalRender = 'b' * 64
$terrainRender = 'c' * 64
$script:assertions = 0
$script:cases = 0

function Write-Utf8([string]$Path, [string]$Value) {
    [IO.File]::WriteAllText($Path, $Value, $utf8)
}
function Assert-That([bool]$Condition, [string]$Message) {
    $script:assertions++
    if (-not $Condition) { throw "Assertion failed: $Message" }
}
function Read-Json([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -Depth 50
}
function Argument-Value($Command, [string]$Option) {
    $position = [Array]::IndexOf([string[]]$Command, $Option)
    if ($position -lt 0) { return $null }
    return $Command[$position + 1]
}

Write-Utf8 $mockScript @'
$ErrorActionPreference = 'Stop'
$command = [string[]]$args
[IO.File]::AppendAllText($env:JAPAN_TEST_RECORD, (ConvertTo-Json -InputObject $command -Compress) + "`n", [Text.UTF8Encoding]::new($false))
[Console]::Error.WriteLine('進捗の診断: 日本語と空白パス')
$scenario = $env:JAPAN_TEST_SCENARIO
$dataset = 'a' * 64
$normal = 'b' * 64
$terrain = 'c' * 64
$exitCode = 0
switch ($command[1]) {
    'build-info' { $value = @{ osm_generation_verified = ($scenario -ne 'unverified') } }
    'config' { $value = @{ tile_catalog_database_path = 'D:/日本語 tiles/catalog.sqlite'; local_tile_precompute_max_tiles = 1000000 } }
    'status' { $value = @{ owner_available = ($scenario -ne 'owner-busy'); catalog_exists = $false; datasets = 0; jobs = 0 } }
    'elevation' {
        $value = @{ allowed = ($scenario -ne 'dem-rejected'); exit_code = 0; error = $null; warnings = @(); validation_scope = 'header-only' }
        if ($scenario -eq 'dem-rejected') { $value.exit_code = 2; $value.error = '混在測地系'; $exitCode = 2 }
    }
    'import' {
        $value = @{ id = '00000000-0000-4000-8000-000000000001'; kind = 'import'; dataset_id = $dataset; state = 'succeeded'; error = $null }
        if ($scenario -eq 'import-failed') { $value.state = 'failed'; $value.dataset_id = $null; $value.error = '取り込み失敗'; $exitCode = 1 }
    }
    'datasets' {
        if ($command[2] -eq 'show') {
            $details = @{ capabilities = @{ labels = $true; elevation = ($scenario -like 'terrain*'); contours = ($scenario -like 'terrain*') }; labels = @{ revision = 1; count = 23; categories = @{ 'place.city' = 2; 'landmark.station' = 21 }; skipped = @{} }; skipped_areas = @{} }
            if ($scenario -eq 'old-dataset') { $details = @{ counts = @{ highway = 12 } } }
            $value = @{ id = $dataset; name = '全国 名前 付き'; retired = $false; info = @{ schema_version = $(if ($scenario -eq 'old-dataset') { 2 } else { 3 }); geometry_version = 2; details = $details }; profiles = @(); current_profile_prepared = $true }
        } else {
            $isTerrain = $command[[Array]::IndexOf($command, '--contours') + 1] -eq 'on'
            $render = if ($isTerrain) { $terrain } else { $normal }
            $value = @{ id = $dataset; name = '全国 名前 付き'; render_id = $render; url = "/local-tiles/$dataset/$render/{z}/{x}/{y}.png" }
        }
    }
    'background' {
        $render = $command[[Array]::IndexOf($command, '--render') + 1]
        $value = @{ id = $(if ($render -eq $terrain) { 42 } else { 41 }) }
        if ($scenario -eq 'terrain-publish-failed' -and $render -eq $terrain) { $value = @{ error = '背景登録失敗'; exit_code = 1 }; $exitCode = 1 }
    }
    'url' {
        $render = $command[[Array]::IndexOf($command, '--render') + 1]
        $url = "/local-tiles/$dataset/$render/{z}/{x}/{y}.png"
        $value = @{ dataset_id = $dataset; render_id = $render; url = $url; relative_url = $url; render_compatible = $true; kind = 'raster'; min_zoom = 0; max_zoom = 22; label = '全国 名前 付き' }
    }
    default { throw "Unexpected CLI command: $command" }
}
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 30))
exit $exitCode
'@
# The .cmd wrapper is a native invocation to PowerShell, preserving LASTEXITCODE
# and stdout/stderr behavior without needing a compiler or an installed app.
Write-Utf8 $mockCommand ('@echo off' + "`r`n" + '"' + $pwsh + '" -NoProfile -File "%~dp0mock-cli.ps1" %*' + "`r`n" + 'exit /b %errorlevel%')
Write-Utf8 $launcher @'
$ErrorActionPreference = 'Stop'
$invocation = Get-Content -LiteralPath $env:JAPAN_TEST_INVOCATION -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
function global:Invoke-WebRequest {
        param([string]$Uri, [string]$OutFile, [int]$MaximumRedirection)
        if ($env:JAPAN_TEST_NETWORK -ne 'mock') { throw "Unexpected network request: $Uri" }
        [IO.File]::AppendAllText($env:JAPAN_TEST_HTTP_RECORD, $Uri + "`n")
        if ($Uri.EndsWith('.pbf.md5')) {
            if ($env:JAPAN_TEST_SCENARIO -eq 'bad-md5') { [IO.File]::WriteAllText($OutFile, ('0' * 32) + '  japan-latest.osm.pbf') }
            else { Copy-Item -LiteralPath (Join-Path $env:JAPAN_TEST_FIXTURES 'source.pbf.md5') -Destination $OutFile }
        } elseif ($Uri.EndsWith('.pbf')) {
            Copy-Item -LiteralPath (Join-Path $env:JAPAN_TEST_FIXTURES 'source.pbf') -Destination $OutFile
        } elseif ($Uri.EndsWith('.zip')) {
            Copy-Item -LiteralPath (Join-Path $env:JAPAN_TEST_FIXTURES 'source.zip') -Destination $OutFile
        } else { throw "Unexpected download URI: $Uri" }
}
try { & $env:JAPAN_TEST_SUBJECT @invocation; exit 0 }
catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
'@

$pbf = Join-Path $fixtureRoot '全国 source.pbf'
$shape = Join-Path $fixtureRoot '陸域 polygons.shp'
$config = Join-Path $fixtureRoot '設定 env.json'
Write-Utf8 $pbf 'tiny PBF fixture passed to a native CLI mock'
Write-Utf8 $config '{}'
foreach ($extension in '.shp', '.prj', '.shx', '.dbf') {
    Write-Utf8 ([IO.Path]::ChangeExtension($shape, $extension)) "fixture $extension"
}
Copy-Item -LiteralPath $pbf -Destination (Join-Path $fixtureRoot 'source.pbf')
$md5 = (Get-FileHash -LiteralPath $pbf -Algorithm MD5).Hash.ToLowerInvariant()
Write-Utf8 (Join-Path $fixtureRoot 'source.pbf.md5') "$md5  japan-latest.osm.pbf`n"
$zipRoot = Join-Path $fixtureRoot 'zip/land-polygons-split-4326'
$null = New-Item -ItemType Directory -Path $zipRoot -Force
foreach ($extension in '.shp', '.prj', '.shx', '.dbf') {
    Write-Utf8 (Join-Path $zipRoot "land_polygons$extension") "fixture $extension"
}
Compress-Archive -Path (Join-Path $fixtureRoot 'zip/*') -DestinationPath (Join-Path $fixtureRoot 'source.zip')

function Run-Case([string]$Label, [hashtable]$Parameters, [string]$Scenario = 'normal', [switch]$Network) {
    $script:cases++
    $caseRoot = Join-Path $testRoot (('{0:D2}-' -f $script:cases) + $Label)
    $null = New-Item -ItemType Directory -Path $caseRoot
    if (-not $Parameters.ContainsKey('DataDirectory')) { $Parameters.DataDirectory = Join-Path $caseRoot '日本語 data with spaces' }
    if ($Parameters.Action -ne 'Download') {
        if (-not $Parameters.ContainsKey('ExePath')) { $Parameters.ExePath = $mockCommand }
        if (-not $Parameters.ContainsKey('ConfigPath')) { $Parameters.ConfigPath = $config }
        if ($Parameters.Action -ne 'Publish') {
            if (-not $Parameters.ContainsKey('PbfPath')) { $Parameters.PbfPath = $pbf }
            if (-not $Parameters.ContainsKey('LandmaskPath')) { $Parameters.LandmaskPath = $shape }
        }
    }
    $invocationPath = Join-Path $caseRoot 'invocation.json'
    Write-Utf8 $invocationPath ($Parameters | ConvertTo-Json -Depth 10)
    $record = Join-Path $caseRoot 'commands.ndjson'
    $httpRecord = Join-Path $caseRoot 'downloads.txt'
    $processInfo = [Diagnostics.ProcessStartInfo]::new($pwsh)
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.StandardOutputEncoding = $utf8
    $processInfo.StandardErrorEncoding = $utf8
    foreach ($argument in @('-NoProfile', '-File', $launcher)) { $processInfo.ArgumentList.Add($argument) }
    foreach ($entry in @{
        JAPAN_TEST_RECORD = $record; JAPAN_TEST_HTTP_RECORD = $httpRecord; JAPAN_TEST_SCENARIO = $Scenario
        JAPAN_TEST_INVOCATION = $invocationPath; JAPAN_TEST_SUBJECT = $subject; JAPAN_TEST_FIXTURES = $fixtureRoot
        JAPAN_TEST_NETWORK = $(if ($Network) { 'mock' } else { 'off' })
    }.GetEnumerator()) { $processInfo.Environment[$entry.Key] = $entry.Value }
    $process = [Diagnostics.Process]::Start($processInfo)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw "Test timed out: $Label" }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    Write-Utf8 (Join-Path $caseRoot 'stdout.txt') $stdout
    Write-Utf8 (Join-Path $caseRoot 'stderr.txt') $stderr
    $commands = @()
    if (Test-Path -LiteralPath $record) {
        $commands = @(Get-Content -LiteralPath $record -Encoding utf8 | ForEach-Object { ,(ConvertFrom-Json $_ -NoEnumerate) })
    }
    $logs = @(Get-ChildItem -LiteralPath (Join-Path $Parameters.DataDirectory 'logs') -Directory -ErrorAction SilentlyContinue)
    $log = if ($logs.Count) { $logs[-1].FullName } else { $null }
    Write-Host "$Label`: exit=$($process.ExitCode), CLI calls=$($commands.Count)"
    return @{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr; Commands = $commands; Log = $log; Data = $Parameters.DataDirectory; HttpRecord = $httpRecord }
}

$download = Run-Case 'download' @{ Action = 'Download' } -Network
Assert-That ($download.ExitCode -eq 0) "Download succeeds: $($download.Stderr)"
$inputs = Read-Json (Join-Path $download.Data 'inputs.json')
Assert-That ($inputs.PbfMd5 -eq $md5) 'Download verifies the real fixture MD5'
Assert-That ((Test-Path -LiteralPath $inputs.PbfPath) -and (Test-Path -LiteralPath $inputs.LandmaskPath)) 'Download locates PBF and nested SHP'
Assert-That (@(Get-Content -LiteralPath $download.HttpRecord).Count -eq 3) 'Exactly three HTTP requests are mocked'
$originalInputs = [IO.File]::ReadAllText((Join-Path $download.Data 'inputs.json'))
$badDownload = Run-Case 'bad-md5-keeps-manifest' @{ Action = 'Download'; DataDirectory = $download.Data } 'bad-md5' -Network
Assert-That ($badDownload.ExitCode -ne 0 -and $badDownload.Stderr -match 'MD5') 'Checksum mismatch aborts'
Assert-That ([IO.File]::ReadAllText((Join-Path $download.Data 'inputs.json')) -eq $originalInputs) 'Failed download preserves previous input manifest'
$nextDownload = Run-Case 'download-keeps-old-snapshot' @{ Action = 'Download'; DataDirectory = $download.Data } -Network
Assert-That ($nextDownload.ExitCode -eq 0) 'Another successful Download succeeds'
$nextInputs = Read-Json (Join-Path $download.Data 'inputs.json')
Assert-That ($nextInputs.PbfPath -ne $inputs.PbfPath -and $nextInputs.LandmaskPath -ne $inputs.LandmaskPath) 'Each Download selects a fresh input snapshot'
Assert-That ((Get-FileHash -LiteralPath $inputs.PbfPath -Algorithm MD5).Hash.ToLowerInvariant() -eq $md5) 'New downloads preserve the old snapshot files'

$check = Run-Case 'check-downloaded-input' @{ Action = 'Check'; DataDirectory = $download.Data; PbfPath = ''; LandmaskPath = '' }
Assert-That ($check.ExitCode -eq 0) "Check reads downloaded manifest: $($check.Stderr)"
Assert-That ($check.Commands.Count -eq 3 -and $check.Commands[2][1] -eq 'status') 'Check performs read-only native queries'
Write-Utf8 $nextInputs.PbfPath 'tampered input fixture'
$tampered = Run-Case 'check-refuses-changed-pbf' @{ Action = 'Check'; DataDirectory = $download.Data; PbfPath = ''; LandmaskPath = '' }
Assert-That ($tampered.ExitCode -ne 0 -and $tampered.Stderr -match 'PBFがダウンロード後に変更') 'Check refuses changed downloaded PBF'
Assert-That ($tampered.Commands.Count -eq 3) 'Changed inputs prevent import or background registration'

$import = Run-Case 'import-normal' @{ Action = 'Import'; Name = '全国 名前 付き' }
Assert-That ($import.ExitCode -eq 0) "Import succeeds: $($import.Stderr)"
Assert-That ($import.Commands.Count -eq 8) 'Import has expected native command count'
$importCall = @($import.Commands | Where-Object { $_[1] -eq 'import' })[0]
Assert-That ((Argument-Value $importCall '--features') -eq 'standard-v2') 'Import requests the name-capable format'
Assert-That ((Argument-Value $importCall '--contour-data') -eq 'off') 'No DEM means contour collection is off'
Assert-That ((Argument-Value $importCall '--name') -eq '全国 名前 付き' -and (Argument-Value $importCall '--input') -eq $pbf) 'Native argv preserves Japanese and spaces'
Assert-That ((Argument-Value $importCall '--config') -eq $config) 'Explicit configuration path is passed intact'
$receipt = Read-Json (Join-Path $import.Log 'result.json')
Assert-That ($receipt.dataset_id -eq $datasetId -and $receipt.normal.render_id -eq $normalRender) 'Receipt uses dataset ID and prepared render ID'
Assert-That ($receipt.normal.background.id -eq 41 -and $null -eq $receipt.terrain) 'Receipt contains normal background ID only'
Assert-That ($import.Stderr -match '進捗の診断') 'Native progress stays visible on stderr'
foreach ($file in Get-ChildItem -LiteralPath $import.Log -Filter '*.json') {
    $null = Read-Json $file.FullName
    Assert-That (-not ([IO.File]::ReadAllText($file.FullName).Contains('進捗の診断'))) 'Every saved JSON excludes native stderr'
}
$backgroundCall = @($import.Commands | Where-Object { $_[1] -eq 'background' })[0]
Assert-That ((Argument-Value $backgroundCall '--render') -eq $normalRender) 'Background receives exact prepared render'

$publish = Run-Case 'publish-without-inputs' @{ Action = 'Publish'; DatasetId = $datasetId }
Assert-That ($publish.ExitCode -eq 0) "Publish succeeds without source inputs: $($publish.Stderr)"
Assert-That (@($publish.Commands | Where-Object { $_[1] -eq 'import' }).Count -eq 0) 'Publish never reimports'

$dem = Join-Path $fixtureRoot 'DEM 日本語 directory'
$null = New-Item -ItemType Directory -Path $dem
$terrain = Run-Case 'import-with-dem' @{ Action = 'Import'; ElevationInput = $dem; ElevationDatumPolicy = 'allow-jgd2000-2011' } 'terrain'
Assert-That ($terrain.ExitCode -eq 0) "DEM import succeeds: $($terrain.Stderr)"
$terrainImport = @($terrain.Commands | Where-Object { $_[1] -eq 'import' })[0]
Assert-That ((Argument-Value $terrainImport '--contour-data') -eq 'on' -and (Argument-Value $terrainImport '--elevation-input') -eq $dem) 'DEM import includes data and contours'
Assert-That ((Argument-Value $terrainImport '--elevation-datum-policy') -eq 'allow-jgd2000-2011') 'DEM policy is preserved'
$terrainPrepare = @($terrain.Commands | Where-Object { $_[1] -eq 'datasets' -and $_[2] -eq 'prepare' })
Assert-That ($terrainPrepare.Count -eq 2 -and (Argument-Value $terrainPrepare[0] '--contours') -eq 'off' -and (Argument-Value $terrainPrepare[1] '--contours') -eq 'on') 'Normal and terrain use distinct explicit settings'
$terrainReceipt = Read-Json (Join-Path $terrain.Log 'result.json')
Assert-That ($terrainReceipt.terrain.render_id -eq $terrainRender -and $terrainReceipt.terrain.background.id -eq 42) 'Terrain receipt stores its own generation and background'

foreach ($failure in @(
    @{ Label = 'owner-busy'; Scenario = 'owner-busy'; Parameters = @{ Action = 'Import' }; Calls = 3; Error = 'owner' },
    @{ Label = 'unverified'; Scenario = 'unverified'; Parameters = @{ Action = 'Import' }; Calls = 1; Error = '認定' },
    @{ Label = 'import-nonzero'; Scenario = 'import-failed'; Parameters = @{ Action = 'Import' }; Calls = 4; Error = '終了コード1' },
    @{ Label = 'missing-setup'; Scenario = 'normal'; Parameters = @{ Action = 'Import'; ConfigPath = (Join-Path $fixtureRoot 'missing.json') }; Calls = 0; Error = '初回セットアップ' },
    @{ Label = 'old-dataset'; Scenario = 'old-dataset'; Parameters = @{ Action = 'Publish'; DatasetId = $datasetId }; Calls = 4; Error = 'capabilities|standard-v2|名称' },
    @{ Label = 'terrain-without-dem'; Scenario = 'normal'; Parameters = @{ Action = 'Import'; Terrain = $true }; Calls = 3; Error = 'ElevationInput' },
    @{ Label = 'dem-rejected'; Scenario = 'dem-rejected'; Parameters = @{ Action = 'Import'; ElevationInput = $dem }; Calls = 4; Error = '終了コード2' },
    @{ Label = 'publish-terrain-without-capability'; Scenario = 'normal'; Parameters = @{ Action = 'Publish'; DatasetId = $datasetId; Terrain = $true }; Calls = 4; Error = '標高・等高線' }
)) {
    $result = Run-Case $failure.Label $failure.Parameters $failure.Scenario
    Assert-That ($result.ExitCode -ne 0 -and $result.Stderr -match $failure.Error) "Failure is diagnosed: $($failure.Label): $($result.Stderr)"
    Assert-That ($result.Commands.Count -eq $failure.Calls) "Failure prevents dependent commands: $($failure.Label)"
}

$partial = Run-Case 'terrain-publish-failure-keeps-normal' @{ Action = 'Publish'; DatasetId = $datasetId; Terrain = $true } 'terrain-publish-failed'
Assert-That ($partial.ExitCode -ne 0) 'Terrain failure returns nonzero'
$partialReceipt = Read-Json (Join-Path $partial.Log 'result.json')
Assert-That ($partialReceipt.normal.background.id -eq 41 -and $null -eq $partialReceipt.terrain) 'Terrain failure retains completed normal background receipt'

Write-Host "Passed $script:cases cases / $script:assertions assertions. Artifacts: $testRoot"
