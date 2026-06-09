<#
.SYNOPSIS
    One-click deployment for the agents-deployment-package.

.DESCRIPTION
    Installs all dependencies, builds all components, configures the
    environment, and installs the Local Agent Studio VS Code extension.

    Run from the repo root:
        .\deploy.ps1

    To skip optional components:
        .\deploy.ps1 -SkipPython -SkipDeepRL

.PARAMETER SkipPython
    Skip Python dependency installation.

.PARAMETER SkipDeepRL
    Skip building the C++ Deep RL agent binary.

.PARAMETER SkipExtension
    Skip installing the VS Code extension (useful in CI).

.PARAMETER Force
    Reinstall everything even if already present.
#>
[CmdletBinding()]
param(
    [switch]$SkipPython,
    [switch]$SkipDeepRL,
    [switch]$SkipExtension,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Write-Step($msg)  { Write-Host "`n[$((Get-Date).ToString('HH:mm:ss'))] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Skip($msg)  { Write-Host "  [SKIP] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# Banner
Write-Host ''
Write-Host '==============================================================' -ForegroundColor Cyan
Write-Host '         agents-deployment-package - 1-Click Deploy           ' -ForegroundColor Cyan
Write-Host '==============================================================' -ForegroundColor Cyan
Write-Host ''

# 1. Prerequisites check
Write-Step '1/8 Checking prerequisites'

# Node.js
try {
    $nodeVersion = (node --version 2>&1).ToString().Trim()
    $nodeMajor = [int]($nodeVersion -replace '^v(\d+).*', '$1')
    if ($nodeMajor -lt 18) {
        Write-Fail "Node.js $nodeVersion found but v18+ required"
        exit 1
    }
    Write-Ok "Node.js $nodeVersion"
} catch {
    Write-Fail 'Node.js not found. Install from https://nodejs.org (v18+)'
    exit 1
}

# Python (optional)
$hasPython = $false
if (-not $SkipPython) {
    try {
        $pyVersion = (python --version 2>&1).ToString().Trim()
        Write-Ok "$pyVersion"
        $hasPython = $true
    } catch {
        Write-Skip 'Python not found - reverse engineering and transcription will be unavailable'
    }
}

# CMake (optional)
$hasCmake = $false
if (-not $SkipDeepRL) {
    try {
        $cmakeVersion = (cmake --version 2>&1 | Select-Object -First 1).ToString().Trim()
        Write-Ok "$cmakeVersion"
        $hasCmake = $true
    } catch {
        Write-Skip 'CMake not found - Deep RL agent will not be built'
    }
}
    # 2. Environment file
# ── 2. Environment file ────────────────────────────────────────────────────────
Write-Step '2/8 Checking environment configuration'

$envFile = Join-Path $root '.env'
$envExample = Join-Path $root '.env.example'

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Ok 'Created .env from .env.example - edit it with your credentials'
        Write-Host ''
        Write-Host '  IMPORTANT: Open .env and fill in your Apigee credentials before' -ForegroundColor Yellow
        Write-Host '     starting the MCP server.' -ForegroundColor Yellow
    } else {
        Write-Fail ".env.example not found at $envExample"
        exit 1
    }
} else {
    Write-Ok '.env file exists'
}

# 3. Node dependencies (root)
Write-Step '3/8 Installing Node dependencies (root)'

if ($Force -or -not (Test-Path (Join-Path $root 'node_modules'))) {
    Push-Location $root
    npm install --no-audit --no-fund 2>&1 | Out-Null
    Pop-Location
    Write-Ok 'npm install (root)'
} else {
    Write-Skip 'node_modules exists (use -Force to reinstall)'
}

# 4. RAG server
Write-Step '4/8 Installing & building RAG server'

$ragDir = Join-Path $root 'vs-code-local-rag\copilot-rag-mcp'
if (Test-Path $ragDir) {
    if ($Force -or -not (Test-Path (Join-Path $ragDir 'node_modules'))) {
        Push-Location $ragDir
        npm install --no-audit --no-fund 2>&1 | Out-Null
        Pop-Location
        Write-Ok 'npm install (RAG server)'
    } else {
        Write-Skip 'RAG server node_modules exists'
    }

    $ragDist = Join-Path $ragDir 'dist\server.js'
    if ($Force -or -not (Test-Path $ragDist)) {
        Push-Location $ragDir
        npm run build 2>&1 | Out-Null
        Pop-Location
        Write-Ok 'RAG server built (TypeScript -> dist/)'
    } else {
        Write-Skip 'RAG server already built'
    }
} else {
    Write-Skip 'RAG server directory not found'
}

# 5. Agent UI extension
Write-Step '5/8 Installing & building Agent Studio extension'

$uiDir = Join-Path $root 'vs-code-local-agent-ui'
if (Test-Path $uiDir) {
    if ($Force -or -not (Test-Path (Join-Path $uiDir 'node_modules'))) {
        Push-Location $uiDir
        npm install --no-audit --no-fund 2>&1 | Out-Null
        Pop-Location
        Write-Ok 'npm install (Agent UI)'
    } else {
        Write-Skip 'Agent UI node_modules exists'
    }

    $uiOut = Join-Path $uiDir 'out\extension.js'
    if ($Force -or -not (Test-Path $uiOut)) {
        Push-Location $uiDir
        npm run compile 2>&1 | Out-Null
        Pop-Location
        Write-Ok 'Agent UI compiled (TypeScript -> out/)'
    } else {
        Write-Skip 'Agent UI already compiled'
    }
} else {
    Write-Skip 'Agent UI directory not found'
}

# 6. Python dependencies
Write-Step '6/8 Installing Python dependencies'

if (-not $SkipPython -and $hasPython) {
    $reqFile = Join-Path $root 'reverse_engineering\requirements.txt'
    if (Test-Path $reqFile) {
        $pipArgs = "-m pip install -r `"$reqFile`" --quiet"
        $pipProc = Start-Process -FilePath 'python' -ArgumentList $pipArgs -Wait -NoNewWindow -PassThru
        if ($pipProc.ExitCode -eq 0) {
            Write-Ok 'Python packages installed (reverse_engineering)'
        } else {
            Write-Skip "Python dependency install failed (exit $($pipProc.ExitCode)) - reverse engineering features may be unavailable"
        }
    } else {
        Write-Skip 'requirements.txt not found'
    }
} else {
    Write-Skip 'Python installation skipped'
}

# 7. Deep RL Agent build (optional)
Write-Step '7/8 Building Deep RL Agent (C++)'

$deepRlBuild = Join-Path $root 'deep-rl-cpp-master\build'
if (-not $SkipDeepRL -and $hasCmake) {
    $binaryName = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'deep_rl_agent.exe' } else { 'deep_rl_agent' }
    $binaryPath = Join-Path $deepRlBuild $binaryName
    if ($Force -or -not (Test-Path $binaryPath)) {
        if (-not (Test-Path $deepRlBuild)) {
            New-Item -ItemType Directory -Path $deepRlBuild -Force | Out-Null
        }
        Push-Location $deepRlBuild
        cmake .. -DCMAKE_BUILD_TYPE=Release 2>&1 | Out-Null
        cmake --build . --config Release 2>&1 | Out-Null
        Pop-Location
        if (Test-Path $binaryPath) {
            Write-Ok "Deep RL agent built: $binaryName"
        } else {
            Write-Skip 'Deep RL build completed but binary not found (check compiler output)'
        }
    } else {
        Write-Skip 'Deep RL agent binary already exists'
    }
} else {
    Write-Skip 'Deep RL build skipped (no CMake or -SkipDeepRL)'
}

# 8. VS Code extension install
Write-Step '8/8 Installing VS Code extension'

if (-not $SkipExtension) {
    $vsixPath = Join-Path $uiDir 'vs-code-local-agent-ui-0.0.1.vsix'
    if (Test-Path $vsixPath) {
        try {
            code --install-extension $vsixPath --force 2>&1 | Out-Null
            Write-Ok 'Local Agent Studio extension installed'
        } catch {
            Write-Skip 'Could not install extension (is VS Code in PATH?)'
        }
    } else {
        Write-Skip '.vsix not found - build it with: cd vs-code-local-agent-ui && npx @vscode/vsce package'
    }
} else {
    Write-Skip 'Extension install skipped'
}

# Summary
Write-Host ''
Write-Host '==============================================================' -ForegroundColor Green
Write-Host '                    Deployment Complete!                      ' -ForegroundColor Green
Write-Host '==============================================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Next steps:' -ForegroundColor White
Write-Host ''
if (-not (Test-Path $envFile) -or (Get-Content $envFile -Raw) -match 'your-apigee') {
    Write-Host '  1. Edit .env with your Apigee/Gemini credentials' -ForegroundColor Yellow
    Write-Host '  2. Reload VS Code (Ctrl+Shift+P -> "Reload Window")' -ForegroundColor White
} else {
    Write-Host '  1. Reload VS Code (Ctrl+Shift+P -> "Reload Window")' -ForegroundColor White
}
Write-Host '  2. Open Command Palette -> "Tasks: Run Task"' -ForegroundColor White
Write-Host '     -> "Start All Core Services"' -ForegroundColor White
Write-Host ''
Write-Host '  Or use the Agent Studio panel:' -ForegroundColor White
Write-Host '     Command Palette -> "Local Agent Studio: Open Studio"' -ForegroundColor White
Write-Host '     -> expand the Services panel -> start services individually' -ForegroundColor White
Write-Host ''
Write-Host '  For RAG (semantic code search):' -ForegroundColor White
Write-Host '     1. Start Ollama and ChromaDB (via Services panel or tasks)' -ForegroundColor White
Write-Host '     2. Run task "Index: Build RAG Index"' -ForegroundColor White
Write-Host ''
