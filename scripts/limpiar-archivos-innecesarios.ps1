[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectRoot).Path

# Lista cerrada: solo directorios generados conocidos.
$relativeTargets = @(
    'node_modules',
    'dist',
    'coverage',
    '.nyc_output',
    'tmp',
    'temp'
)

foreach ($relativeTarget in $relativeTargets) {
    $target = Join-Path $root $relativeTarget
    if (Test-Path -LiteralPath $target) {
        if ($PSCmdlet.ShouldProcess($target, 'Eliminar directorio generado')) {
            Remove-Item -LiteralPath $target -Recurse -Force
            Write-Host "[OK] Eliminado: $relativeTarget"
        }
    }
}

# Los metadatos incrementales de TypeScript son regenerables. Se excluyen
# explícitamente el repositorio Git y los datos persistentes del bot.
$protectedRoots = @(
    (Join-Path $root '.git'),
    (Join-Path $root 'persistent')
)

Get-ChildItem -LiteralPath $root -Recurse -File -Force -Filter '*.tsbuildinfo' |
    Where-Object {
        $candidate = $_.FullName
        -not ($protectedRoots | Where-Object {
            $candidate.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        })
    } |
    ForEach-Object {
        if ($PSCmdlet.ShouldProcess($_.FullName, 'Eliminar metadatos de compilación')) {
            Remove-Item -LiteralPath $_.FullName -Force
            Write-Host "[OK] Eliminado: $($_.FullName.Substring($root.Length + 1))"
        }
    }

Write-Host '[OK] Limpieza terminada. No se eliminaron fuentes ni datos persistentes.'
