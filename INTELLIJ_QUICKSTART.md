# IntelliJ 1-Click Deployment Guide

This guide provides an IntelliJ-native deployment path for the agents-deployment-package.

## What is included

- One-click deployment script: deploy-intellij.ps1
- IntelliJ shared run configurations in .run/
- Service launcher scripts in scripts/intellij/
- RAG index builder script that always indexes the workspace root

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

Core profile starts:

- Ollama
- ChromaDB
- MCP server

All profile adds:

- Reverse engineering agent
- Knowledge graph visualizer

## Build the RAG index from IntelliJ

Run: 04 - Build RAG Index

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

## Notes

- .env is created from .env.example if missing.
- Fill APIGEE_ENDPOINT, APIGEE_KEY, APIGEE_SECRET, and GEMINI_ENDPOINT in .env before using ask_gemini.
- Long-running services are launched in separate PowerShell windows so IntelliJ is not blocked.
