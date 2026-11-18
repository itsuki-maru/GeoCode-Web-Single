#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ConfigFile,
    [ValidateSet('Inspect', 'Prepare', 'Plan', 'Apply')][string]$Mode = 'Inspect',
    [string]$OriginalDatabase,
    [string]$ProofFile,
    [string]$PlanFile
)
$ErrorActionPreference = 'Stop'
foreach ($item in @($Executable, $ConfigFile)) {
    if (-not [IO.Path]::IsPathRooted($item) -or -not (Test-Path -LiteralPath $item -PathType Leaf)) {
        throw 'ExecutableとConfigFileには、存在するファイルの絶対パスを指定してください。'
    }
}
$arguments = @('local-tiles', 'catalog', 'rebind', $Mode.ToLowerInvariant(), '--config', $ConfigFile, '--json')
switch ($Mode) {
    'Inspect' {
        if ($OriginalDatabase -or $ProofFile -or $PlanFile) { throw 'Inspectでは追加のファイルを指定しません。' }
    }
    'Prepare' {
        if (-not $ProofFile -or $OriginalDatabase -or $PlanFile) { throw 'PrepareにはProofFileだけを指定してください。' }
        $arguments += @('--output', $ProofFile)
    }
    'Plan' {
        if (-not $PlanFile -or -not [IO.Path]::IsPathRooted($PlanFile)) { throw 'PlanFileには新しいJSONファイルの絶対パスを指定してください。' }
        if (Test-Path -LiteralPath $PlanFile) { throw '既存のPlanFileは上書きしません。新しいファイル名を指定してください。' }
        if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($PlanFile)) -PathType Container)) { throw 'PlanFileの親フォルダーを先に用意してください。' }
        if ($OriginalDatabase -and $ProofFile) { throw 'OriginalDatabaseとProofFileはどちらか一方だけを指定してください。' }
        if ($OriginalDatabase) { $arguments += @('--source-database', $OriginalDatabase) }
        if ($ProofFile) { $arguments += @('--proof', $ProofFile) }
    }
    'Apply' {
        if (-not $PlanFile -or $OriginalDatabase -or $ProofFile) { throw 'ApplyにはPlanFileだけを指定してください。' }
        $arguments += @('--plan', $PlanFile)
    }
}
# 引数配列で実行し、コマンド文字列の組み立て・Invoke-Expressionは使わない。
$previousConsoleEncoding = [Console]::OutputEncoding
$previousOutputEncoding = $OutputEncoding
$previousErrorAction = $ErrorActionPreference
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
    # Windows PowerShellは進捗用stderrもErrorRecordにする。終了コードで成否を判定する。
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $nativeOutput = & $Executable @arguments
    $nativeExitCode = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $previousConsoleEncoding
    $OutputEncoding = $previousOutputEncoding
    $ErrorActionPreference = $previousErrorAction
}
if ($nativeExitCode -ne 0) { throw "catalogの移設処理に失敗しました（終了コード $nativeExitCode）。標準エラーの詳細を確認してください。" }
$result = ($nativeOutput -join "`n") | ConvertFrom-Json
if ($Mode -eq 'Plan') {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($result | ConvertTo-Json -Depth 32) + "`n")
    # 存在確認後の競合でも既存ファイルを上書きしない。
    $stream = [IO.File]::Open($PlanFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Write-Host "移設計画を保存しました: $PlanFile"
}
$result
