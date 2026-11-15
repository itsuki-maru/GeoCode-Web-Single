# ロックファイルのフィンガープリントが同じでも、-d 指定時は依存関係をインストールする。
Param([switch]$d)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$originalLocation = Get-Location
$rootDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$frontendRoot = Join-Path $rootDir 'src_frontend'
$mainOutput = Join-Path $frontendRoot 'main/dist'
$distribution = Join-Path $rootDir 'dist'

function Assert-WorkspacePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = $rootDir.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output is outside the project: $full"
    }
    # 再帰的な削除やコピーを始める前に、パス内のジャンクションとシンボリックリンクを拒否する。
    $cursor = $full
    while ($cursor -ne $rootDir) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Build path must not be a junction or symlink: $cursor"
            }
        }
        $cursor = Split-Path -Path $cursor -Parent
        if (-not $cursor) { throw "Invalid build path: $full" }
    }
    return $full
}

function Remove-BuildOutput([string]$Path) {
    $full = Assert-WorkspacePath $Path
    if ($full -notin @($mainOutput, $distribution)) { throw "Unexpected build output: $full" }
    if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}

function Invoke-BuildCommand([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

function Get-DependencyFingerprint([string]$Directory) {
    $hashes = foreach ($name in @('package.json', 'package-lock.json', '.npmrc')) {
        $path = Join-Path $Directory $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            "$name=$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
        } elseif ($name -ne '.npmrc') {
            throw "Dependency manifest is missing: $path"
        }
    }
    return $hashes -join [Environment]::NewLine
}

try {
    foreach ($name in @('frontend', 'frontend-mobile', 'frontend-admin', 'template-scripts')) {
        $directory = Assert-WorkspacePath (Join-Path $frontendRoot $name)
        # Vite自身がdist/を削除するため、npmを実行する前にリンクされた出力先を拒否する。
        $projectOutput = Assert-WorkspacePath (Join-Path $directory 'dist')
        Set-Location -LiteralPath $directory
        $fingerprint = Get-DependencyFingerprint $directory
        $modules = Assert-WorkspacePath (Join-Path $directory 'node_modules')
        $stamp = Join-Path $modules '.geocode-build-dependencies'
        $installed = if (Test-Path -LiteralPath $stamp -PathType Leaf) { [IO.File]::ReadAllText($stamp) } else { '' }
        if ($d -or -not (Test-Path -LiteralPath $modules -PathType Container) -or $installed -cne $fingerprint) {
            Invoke-BuildCommand 'npm' @('ci')
            [IO.File]::WriteAllText($stamp, $fingerprint, [Text.UTF8Encoding]::new($false))
        }
        Invoke-BuildCommand 'npm' @('run', 'build')
        $required = if ($name -eq 'template-scripts') { 'template-manifest.json' } else { 'index.html' }
        if (-not (Test-Path -LiteralPath (Join-Path $projectOutput $required) -PathType Leaf)) {
            throw "Build output is missing: $name/dist/$required"
        }
    }

    # 4構成すべてのビルドが成功してから配布し、失敗時は前回の出力を保持する。
    Remove-BuildOutput $mainOutput
    $assets = Join-Path $mainOutput 'assets'
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    foreach ($name in @('frontend', 'frontend-mobile', 'frontend-admin')) {
        $source = Join-Path $frontendRoot "$name/dist"
        Get-ChildItem -LiteralPath $source -Force | Where-Object Name -ne 'index.html' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $mainOutput -Recurse -Force
        }
        $page = switch ($name) {
            'frontend' { 'index.html' }
            'frontend-mobile' { 'index-mobile.html' }
            'frontend-admin' { 'index-admin.html' }
        }
        $html = [IO.File]::ReadAllText((Join-Path $source 'index.html'))
        foreach ($file in @('favicon.ico', 'manifest.json', 'manifest-tab.json', 'apple-touch-icon.png')) {
            $html = $html.Replace(('href="./' + $file + '"'), ('href="/assets/' + $file + '"'))
        }
        [IO.File]::WriteAllText((Join-Path $mainOutput $page), $html, [Text.UTF8Encoding]::new($false))
    }
    Get-ChildItem -LiteralPath $mainOutput -File | Where-Object {
        $_.Extension -in @('.js', '.mjs', '.css', '.svg', '.png', '.json', '.ico')
    } | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $assets -Force }
    Get-ChildItem -LiteralPath (Join-Path $frontendRoot 'template-scripts/dist') -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $assets -Recurse -Force
    }
    $templates = Join-Path $mainOutput 'templates'
    New-Item -ItemType Directory -Path $templates -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $rootDir 'src/templates') -File -Filter '*.html' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $templates -Force
    }
    Remove-BuildOutput $distribution
    Copy-Item -LiteralPath $mainOutput -Destination $distribution -Recurse -Force
    Set-Location -LiteralPath $rootDir
    Invoke-BuildCommand 'cargo' @('build', '--release')
} finally {
    Set-Location -LiteralPath $originalLocation
}
