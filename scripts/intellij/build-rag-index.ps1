<#
.SYNOPSIS
    Build or refresh the local RAG index for this repository.

.DESCRIPTION
    Runs npm index scripts from vs-code-local-rag/copilot-rag-mcp with all
    required environment variables set for workspace-root indexing.

.EXAMPLE
    .\scripts\intellij\build-rag-index.ps1

.EXAMPLE
    .\scripts\intellij\build-rag-index.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipServiceChecks,
    [int]$TimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$ragDir = Join-Path $root 'vs-code-local-rag\copilot-rag-mcp'

if (-not (Test-Path $ragDir)) {
    Write-Error "RAG directory not found: $ragDir"
    exit 1
}

$env:REPO_ROOT = "$root"
$env:OLLAMA_BASE_URL = 'http://localhost:11434'
$env:EMBED_MODEL = 'nomic-embed-text'
$env:CHROMA_URL = 'http://localhost:8000'
$env:COLLECTION = 'codebase'

function Test-AnyEndpoint {
    param([string[]]$Urls)
    foreach ($u in $Urls) {
        try {
            $resp = Invoke-WebRequest -Uri $u -Method GET -TimeoutSec 4 -UseBasicParsing
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
                return $true
            }
        } catch {
            # Keep trying the next URL
        }
    }
    return $false
}

function Wait-ServiceReady {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string[]]$Urls,
        [Parameter(Mandatory = $true)][int]$Timeout
    )

    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-AnyEndpoint -Urls $Urls) {
            Write-Host "[OK] $Name is reachable" -ForegroundColor Green
            return $true
        }
        Start-Sleep -Seconds 2
    }

    Write-Host "[SKIP] $Name not reachable after $Timeout seconds" -ForegroundColor Yellow
    return $false
}

if (-not $SkipServiceChecks) {
    Write-Host ''
    Write-Host 'Checking local RAG services before indexing...' -ForegroundColor Cyan
    $ollamaReady = Wait-ServiceReady -Name 'Ollama' -Urls @('http://localhost:11434/api/tags') -Timeout $TimeoutSeconds
    $chromaReady = Wait-ServiceReady -Name 'ChromaDB' -Urls @('http://localhost:8000/api/v2/heartbeat', 'http://localhost:8000/api/v1/heartbeat', 'http://localhost:8000') -Timeout $TimeoutSeconds

    if (-not ($ollamaReady -and $chromaReady)) {
        Write-Error 'Cannot build index because Ollama or ChromaDB is not ready. Start core services first or run with -SkipServiceChecks.'
        exit 1
    }
}

Push-Location $ragDir
try {
    if ($Force) {
        npm run reindex
    } else {
        npm run index
    }
} finally {
    Pop-Location
}
