<#
.SYNOPSIS
    One-click deployment entrypoint for IntelliJ users.

.DESCRIPTION
    Wraps deploy.ps1 with IntelliJ-friendly defaults and guidance.
    By default this skips VS Code extension install.

.EXAMPLE
    .\deploy-intellij.ps1

.EXAMPLE
    .\deploy-intellij.ps1 -SkipPython -SkipDeepRL -Force
#>
[CmdletBinding()]
param(
    [switch]$SkipPython,
    [switch]$SkipDeepRL,
    [switch]$InstallVsCodeExtension,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$deployScript = Join-Path $root 'deploy.ps1'

if (-not (Test-Path $deployScript)) {
    Write-Error "deploy.ps1 not found at $deployScript"
    exit 1
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '  IntelliJ 1-Click Deploy: agents-deployment-package' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''


# Pass switches by name (not as positional strings)
$deployParameters = @{
    SkipExtension = (-not $InstallVsCodeExtension)
}

if ($SkipPython) { $deployParameters.SkipPython = $true }
if ($SkipDeepRL) { $deployParameters.SkipDeepRL = $true }
if ($Force) { $deployParameters.Force = $true }

& $deployScript @deployParameters

Write-Host ''
Write-Host 'IntelliJ next steps:' -ForegroundColor Green
Write-Host '  1. Open Run Configurations and run "02 - Start Core Services"' -ForegroundColor White
Write-Host '  2. Run "04 - Build RAG Index" after Ollama and ChromaDB are up' -ForegroundColor White
Write-Host '  3. Keep core service terminals running while using MCP tools' -ForegroundColor White
Write-Host ''
