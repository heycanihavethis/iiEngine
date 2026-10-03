$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fixtureOutput = [IO.Path]::GetFullPath((Join-Path $projectRoot 'work/managed-fixtures'))
if (-not $fixtureOutput.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture output escapes the workspace.'
}
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'The Windows .NET Framework C# compiler is required for inert metadata fixtures.' }
New-Item -ItemType Directory -Path $fixtureOutput -Force | Out-Null
& $compilerPath /nologo /target:library "/out:$fixtureOutput/BepInEx.dll" (Join-Path $projectRoot 'fixtures/managed/BepInExStub.cs')
if ($LASTEXITCODE -ne 0) { throw 'BepInEx metadata fixture compilation failed.' }
& $compilerPath /nologo /target:library "/reference:$fixtureOutput/BepInEx.dll" "/out:$fixtureOutput/MenuFixture.dll" (Join-Path $projectRoot 'fixtures/managed/MenuFixture.cs')
if ($LASTEXITCODE -ne 0) { throw 'Menu metadata fixture compilation failed.' }
Write-Output 'Inert metadata DLLs created under ignored work/managed-fixtures. No assembly was executed or installed.'
