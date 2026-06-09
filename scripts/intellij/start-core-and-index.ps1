<#
.SYNOPSIS
    Start core services and build the RAG index in one IntelliJ action.

.DESCRIPTION
    Launches ChromaDB and MCP server in separate windows, then waits
    for readiness and runs the index build.

.EXAMPLE
    .\scripts\intellij\start-core-and-index.ps1

.EXAMPLE
    .\scripts\intellij\start-core-and-index.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$startScript = Join-Path $PSScriptRoot 'start-services.ps1'
$indexScript = Join-Path $PSScriptRoot 'build-rag-index.ps1'

if (-not (Test-Path $startScript)) {
    Write-Error "Missing script: $startScript"
    exit 1
}
if (-not (Test-Path $indexScript)) {
    Write-Error "Missing script: $indexScript"
    exit 1
}

Write-Host ''
Write-Host 'Launching core services...' -ForegroundColor Cyan
powershell -ExecutionPolicy Bypass -File $startScript -ServiceProfile core

Write-Host ''
Write-Host 'Building RAG index (with service readiness checks)...' -ForegroundColor Cyan
$indexArgs = @('-ExecutionPolicy', 'Bypass', '-File', $indexScript, '-TimeoutSeconds', $TimeoutSeconds)
if ($Force) { $indexArgs += '-Force' }

powershell @indexArgs

Write-Host ''
Write-Host 'Done. Core services should remain running in separate windows.' -ForegroundColor Green
