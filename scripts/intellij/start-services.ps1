<#
.SYNOPSIS
    Start services for IntelliJ workflows.

.DESCRIPTION
    Launches selected services in separate PowerShell windows so IntelliJ run
    configurations can start everything with one click while keeping services alive.

.EXAMPLE
    .\scripts\intellij\start-services.ps1 -ServiceProfile core

.EXAMPLE
    .\scripts\intellij\start-services.ps1 -ServiceProfile all
#>
[CmdletBinding()]
param(
    [ValidateSet('core', 'all')]
    [string]$ServiceProfile = 'core'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Start-ServiceWindow {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Command
    )

    $wd = (Resolve-Path (Join-Path $root $WorkingDirectory)).Path
    $safeWd = $wd.Replace("'", "''")
    $safeTitle = $Title.Replace("'", "''")
    $ps = "Set-Location -LiteralPath '$safeWd'; Write-Host '[$safeTitle] starting...' -ForegroundColor Cyan; $Command"

    Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $ps | Out-Null
    Write-Host "Started: $Title" -ForegroundColor Green
}

Write-Host ''
Write-Host "Starting service profile: $ServiceProfile" -ForegroundColor Cyan
Write-Host ''

# Core services required for MCP + RAG
Start-ServiceWindow -Title 'Ollama' -WorkingDirectory '.' -Command 'ollama serve'
Start-ServiceWindow -Title 'ChromaDB' -WorkingDirectory '.' -Command 'chroma run --path ./chroma_data --port 8000'
Start-ServiceWindow -Title 'MCP Server' -WorkingDirectory '.' -Command 'node mcp-server.js'

if ($ServiceProfile -eq 'all') {
    Start-ServiceWindow -Title 'Reverse Engineering Agent' -WorkingDirectory 'reverse_engineering' -Command 'python agent.py --root . --output ./kg_output --format all'
    Start-ServiceWindow -Title 'Knowledge Graph Visualizer' -WorkingDirectory 'reverse_engineering' -Command 'python visualizer.py'
}

Write-Host ''
Write-Host 'All requested services launched in separate windows.' -ForegroundColor Green
