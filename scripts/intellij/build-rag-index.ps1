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
    [switch]$Force
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
