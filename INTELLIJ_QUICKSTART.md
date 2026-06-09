# IntelliJ 1-Click Deployment Guide

This guide provides an IntelliJ-native deployment path for the agents-deployment-package.

## What is included

- One-click deployment script: deploy-intellij.ps1
- IntelliJ shared run configurations in .run/
- Service launcher scripts in scripts/intellij/
- RAG index builder script that always indexes the workspace root
- IntelliJ plugin module: intellij-local-agent-studio/ (Tool Window UI)

## IntelliJ-native Tool Window UI

This repository now includes a true IntelliJ plugin module at intellij-local-agent-studio/.

It provides a Local Agent Studio Tool Window with native UI buttons for:

- One Click Deploy
- Start Core Services
- Build RAG Index
- Start Core + Index

### Run the plugin in a sandbox IDE

1. Open intellij-local-agent-studio/ as a Gradle project in IntelliJ.
2. Run the Gradle task runIde.
3. In the sandbox IDE, open this repository root.
4. Open the Local Agent Studio Tool Window.

### Build and install plugin ZIP

From intellij-local-agent-studio/:

```powershell
.\gradlew.bat buildPlugin
```

Then install the ZIP from intellij-local-agent-studio/build/distributions/ via:

- Settings -> Plugins -> Gear icon -> Install Plugin from Disk

## Prerequisites

- Windows PowerShell 5+ or PowerShell 7+
- Node.js 18+
- npm
- Optional: Python 3.10+ (reverse engineering and transcription)
- Optional: CMake 3.16+ (Deep RL C++ agent build)
- Optional: Ollama and ChromaDB (for local RAG)

## One-click deploy in IntelliJ

1. Open this repository in IntelliJ.
2. Open Run Configurations.
3. Run: 01 - One Click Deploy (IntelliJ).

That run configuration executes deploy-intellij.ps1, which wraps deploy.ps1 and skips VS Code extension installation by default.

## Start services from IntelliJ

After deployment, run one of these from the IntelliJ Run menu:

- 02 - Start Core Services
- 03 - Start All Services
- 05 - Start Core Services + Build Index

Core profile starts:

- Ollama
- ChromaDB
- MCP server

All profile adds:

- Reverse engineering agent
- Knowledge graph visualizer

## Build the RAG index from IntelliJ

Run: 04 - Build RAG Index

If you want a single action, run: 05 - Start Core Services + Build Index

This script sets:

- REPO_ROOT to project root
- OLLAMA_BASE_URL to <http://localhost:11434>
- CHROMA_URL to <http://localhost:8000>
- EMBED_MODEL to nomic-embed-text
- COLLECTION to codebase

## Terminal fallback (if run configurations are not visible)

Run from IntelliJ Terminal:

```powershell
.\deploy-intellij.ps1
.\scripts\intellij\start-services.ps1 -ServiceProfile core
.\scripts\intellij\build-rag-index.ps1
```

## If Run Configurations are missing in IntelliJ

1. Confirm [agents-deployment-package/.run](.run) exists in the project root.
2. In IntelliJ, use File -> Open and select the repository root (not a subfolder).
3. Open Run -> Edit Configurations and check for the imported shared configs.
4. If still missing, click Add New Configuration -> Shell Script and use:
	- Script text: `powershell -ExecutionPolicy Bypass -File "$PROJECT_DIR$/scripts/intellij/start-core-and-index.ps1"`
5. Run that config and keep the service windows open while using MCP tools.

## If index build fails with fetch failed

- This usually means Ollama or ChromaDB is not ready yet.
- Use `05 - Start Core Services + Build Index` (it waits for readiness).
- Or rerun `04 - Build RAG Index` after waiting 15-30 seconds.

## If Start Core Services reports "Ollama not found in PATH"

1. Install Ollama from <https://ollama.com/download>.
2. Close and reopen IntelliJ so it picks up updated PATH.
3. In IntelliJ terminal, verify:

```powershell
ollama --version
```

4. Pull embedding model once:

```powershell
ollama pull nomic-embed-text
```

5. Run `05 - Start Core Services + Build Index` again.

## Notes

- .env is created from .env.example if missing.
- Fill APIGEE_ENDPOINT, APIGEE_KEY, APIGEE_SECRET, and GEMINI_ENDPOINT in .env before using ask_gemini.
- Long-running services are launched in separate PowerShell windows so IntelliJ is not blocked.
