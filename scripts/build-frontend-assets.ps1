# 共通フロントを隔離領域でビルドし、SQLite版の埋込資材へ集約する。
Param(
    [switch]$SkipCargoBuild,
    [string]$OutputRoot = 'target/frontend-dist',
    [switch]$InstallDependencies,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$targetRoot = Join-Path $workspaceRoot 'target'
$originalLocation = Get-Location
$originalAssets = [Environment]::GetEnvironmentVariable('GEOCODE_FRONTEND_DIST', 'Process')
$originalTauriConfig = [Environment]::GetEnvironmentVariable('TAURI_CONFIG', 'Process')
$markerName = '.geocode-frontend-output.json'
$pathComparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }

function Assert-WorkspacePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $workspaceRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $pathComparison)) { throw "Workspace外のパスは使用できません: $full" }
    $cursor = $full
    while (-not $cursor.Equals($workspaceRoot, $pathComparison)) {
        # Test-Pathがfalseになるリンク切れも、既存の再解析ポイントとして拒否する。
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "リンクされたパスは使用できません: $cursor" }
        $parent = Split-Path -Path $cursor -Parent
        if (-not $parent -or $parent -eq $cursor) { throw "パスの親を確認できません: $full" }
        $cursor = $parent
    }
    return $full
}

function Assert-OutputPath([string]$Path) {
    $full = Assert-WorkspacePath $Path
    if (-not $full.Equals($script:output, $pathComparison) -and
        -not $full.StartsWith($script:output + [IO.Path]::DirectorySeparatorChar, $pathComparison)) {
        throw "選択したOutputRootの外は操作できません: $full"
    }
    return $full
}

function Assert-NoLinkedTree([string]$Path) {
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push((Assert-OutputPath $Path))
    while ($pending.Count -gt 0) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "出力内のリンクは操作できません: $($item.FullName)" }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
        }
    }
}

function Remove-OwnedOutput([string]$Path) {
    $full = Assert-OutputPath $Path
    if ($full.Equals($script:output, $pathComparison)) { throw 'OutputRoot自体の削除は許可しません。' }
    if (Test-Path -LiteralPath $full) {
        Assert-NoLinkedTree $full
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}

function Copy-OutputEntry([string]$Source, [string]$Destination) {
    $sourcePath = Assert-OutputPath $Source
    $destinationPath = Assert-OutputPath $Destination
    Assert-NoLinkedTree $sourcePath
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
}

function Invoke-BuildCommand([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') が失敗しました（exit $LASTEXITCODE）。" }
}

try {
    $candidate = if ([IO.Path]::IsPathRooted($OutputRoot)) { $OutputRoot } else { Join-Path $workspaceRoot $OutputRoot }
    $script:output = (Assert-WorkspacePath $candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    # 既存アプリのdist、ソース、target直下のexeやDBを削除対象にしない。
    if (-not $output.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, $pathComparison)) {
        throw 'OutputRootには、このworkspaceのtarget配下の専用ディレクトリを指定してください。'
    }
    if ((Test-Path -LiteralPath $output) -and -not (Test-Path -LiteralPath $output -PathType Container)) {
        throw "OutputRootはディレクトリである必要があります: $output"
    }
    $markerPath = Join-Path $output $markerName
    if (Test-Path -LiteralPath $output) {
        Assert-NoLinkedTree $output
        $entries = @(Get-ChildItem -LiteralPath $output -Force)
        if ($entries.Count -gt 0 -and -not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw '既存の未管理ディレクトリは上書きしません。新しいOutputRootを指定してください。'
        }
        if (Test-Path -LiteralPath $markerPath) {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
            if ($marker.kind -ne 'geocode-web-single-frontend-output' -or
                -not ([string]$marker.workspace).Equals($workspaceRoot, $pathComparison)) {
                throw 'OutputRootの所有記録がこのworkspaceと一致しません。'
            }
        }
    }
    if ($ValidateOnly) {
        Write-Output "隔離ビルド先を確認しました: $output"
        return
    }
    $null = New-Item -ItemType Directory -Path $output -Force
    [IO.File]::WriteAllText($markerPath, (@{kind='geocode-web-single-frontend-output';workspace=$workspaceRoot} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    foreach ($entry in Get-ChildItem -LiteralPath $output -Force) {
        if ($entry.Name -ne $markerName) { Remove-OwnedOutput $entry.FullName }
    }
    $scratch = Assert-OutputPath (Join-Path $output '.build')
    $assets = Assert-OutputPath (Join-Path $output 'assets')
    $null = New-Item -ItemType Directory -Path $scratch, $assets -Force
    $projects = @('frontend', 'frontend-mobile', 'frontend-admin', 'template-scripts')
    foreach ($name in $projects) {
        $directory = Assert-WorkspacePath (Join-Path $workspaceRoot "src_frontend/$name")
        $modules = Assert-WorkspacePath (Join-Path $directory 'node_modules')
        Set-Location -LiteralPath $directory
        if ($InstallDependencies -or -not (Test-Path -LiteralPath $modules -PathType Container)) {
            Invoke-BuildCommand 'npm' @('ci')
        }
        Invoke-BuildCommand 'npm' @('run', 'type-check')
        $projectOutput = Assert-OutputPath (Join-Path $scratch $name)
        # Viteに既存の各project/distではなく、選択領域内の出力先を明示する。
        Invoke-BuildCommand 'npm' @('exec', '--no', '--', 'vite', 'build', '--outDir', $projectOutput, '--emptyOutDir')
    }

    $pages = @{frontend='index.html';'frontend-mobile'='index-mobile.html';'frontend-admin'='index-admin.html'}
    foreach ($name in @('frontend', 'frontend-mobile', 'frontend-admin')) {
        $projectOutput = Assert-OutputPath (Join-Path $scratch $name)
        $entryHtml = Join-Path $projectOutput 'index.html'
        if (-not (Test-Path -LiteralPath $entryHtml -PathType Leaf)) { throw "HTMLが生成されていません: $entryHtml" }
        $html = [IO.File]::ReadAllText($entryHtml)
        $html = $html.Replace('href="./favicon.ico"', 'href="/assets/favicon.ico"').Replace('href="./apple-touch-icon.png"', 'href="/assets/apple-touch-icon.png"')
        # manifestは共通ソースのままとし、バックエンドの限定変換でローカル化する。
        [IO.File]::WriteAllText((Assert-OutputPath (Join-Path $output $pages[$name])), $html, [Text.UTF8Encoding]::new($false))
        foreach ($entry in Get-ChildItem -LiteralPath $projectOutput -Force) {
            if ($entry.Name -eq 'index.html') { continue }
            if ($entry.PSIsContainer -and $entry.Name -eq 'assets') {
                foreach ($asset in Get-ChildItem -LiteralPath $entry.FullName -Force) { Copy-OutputEntry $asset.FullName $assets }
            } else {
                $destination = if ($entry.Extension.ToLowerInvariant() -in @('.js','.mjs','.css','.svg','.png','.jpg','.jpeg','.gif','.webp','.ico','.json','.webmanifest','.woff','.woff2','.ttf','.wasm','.map')) { $assets } else { $output }
                Copy-OutputEntry $entry.FullName $destination
            }
        }
    }
    $templateOutput = Assert-OutputPath (Join-Path $scratch 'template-scripts')
    if (-not (Test-Path -LiteralPath (Join-Path $templateOutput 'template-manifest.json') -PathType Leaf)) { throw 'テンプレート資材のmanifestがありません。' }
    foreach ($entry in Get-ChildItem -LiteralPath $templateOutput -Force) { Copy-OutputEntry $entry.FullName $assets }
    $templates = Assert-OutputPath (Join-Path $output 'templates')
    $null = New-Item -ItemType Directory -Path $templates -Force
    $templateSource = Assert-WorkspacePath (Join-Path $workspaceRoot 'src/templates')
    foreach ($template in Get-ChildItem -LiteralPath $templateSource -File -Filter '*.html') {
        if ($template.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "リンクされたテンプレートは使用できません: $($template.FullName)" }
        Copy-Item -LiteralPath $template.FullName -Destination $templates -Force
    }
    # 中間資材を埋込対象に含めず、古い専用画面chunkも残さない。
    Remove-OwnedOutput $scratch
    Write-Output "フロント埋込資材を生成しました: $output"
    if (-not $SkipCargoBuild) {
        Set-Location -LiteralPath $workspaceRoot
        [Environment]::SetEnvironmentVariable('GEOCODE_FRONTEND_DIST', $output, 'Process')
        $tauriOverride = if ($originalTauriConfig) { $originalTauriConfig | ConvertFrom-Json -AsHashtable } else { @{} }
        if (-not $tauriOverride.ContainsKey('build')) { $tauriOverride['build'] = @{} }
        $tauriOverride['build']['frontendDist'] = $output
        [Environment]::SetEnvironmentVariable('TAURI_CONFIG', ($tauriOverride | ConvertTo-Json -Depth 30 -Compress), 'Process')
        Invoke-BuildCommand 'cargo' @('build', '--release')
    }
} finally {
    Set-Location -LiteralPath $originalLocation
    [Environment]::SetEnvironmentVariable('GEOCODE_FRONTEND_DIST', $originalAssets, 'Process')
    [Environment]::SetEnvironmentVariable('TAURI_CONFIG', $originalTauriConfig, 'Process')
}
