[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path
$obsoleteFiles = @(
    '.env.example',
    'llm.config.example.json'
)

foreach ($relativePath in $obsoleteFiles) {
    $target = Join-Path $root $relativePath
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        Write-Host "[OK] Ya no existe: $relativePath"
        continue
    }

    if ($PSCmdlet.ShouldProcess($target, 'Eliminar archivo de configuración obsoleto')) {
        Remove-Item -LiteralPath $target -Force
        Write-Host "[OK] Eliminado: $relativePath"
    }
}
