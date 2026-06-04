# Quick Start: Agents Deployment Package

## 1-Click Deploy (Recommended)

```powershell
# Clone the repo and open in VS Code
git clone <repo-url> agents-deployment-package
cd agents-deployment-package
code .

# Run the deployment script (installs everything)
.\deploy.ps1
```

The script will:
- Check prerequisites (Node.js 18+, Python, CMake)
- Create `.env` from `.env.example` (edit with your credentials)
- Install all Node.js dependencies (root, RAG server, Agent UI)
- Build the RAG server and Agent Studio extension
- Install Python packages for reverse engineering
- Build the Deep RL C++ agent (if CMake is available)
- Install the Local Agent Studio VS Code extension

### After deploy.ps1 finishes

1. **Edit `.env`** with your Apigee/Gemini credentials
2. **Reload VS Code** (Ctrl+Shift+P -> "Reload Window")
3. **Start services** - pick one method:
   - **Task Runner:** Ctrl+Shift+P -> "Tasks: Run Task" -> "Start All Core Services"
   - **Agent Studio:** Ctrl+Shift+P -> "Local Agent Studio: Open Studio" -> expand Services panel
   - **Command Palette:** "Local Agent Studio: Start a Service"

### Optional flags

```powershell
.\deploy.ps1 -SkipPython     # Skip Python/reverse engineering setup
.\deploy.ps1 -SkipDeepRL     # Skip C++ agent build
.\deploy.ps1 -SkipExtension  # Skip VS Code extension install (CI)
.\deploy.ps1 -Force          # Reinstall everything
```

---

## Manual Setup (Alternative)

### Prerequisites Check
```bash
node --version    # Should be v18+
cmake --version   # Should be 3.16+ (optional)
python --version  # Should be 3.10+ (optional)
```

### Step-by-Step

```bash
# 1. Install Node dependencies
npm install

# 2. Create environment file
cp .env.example .env
# Edit .env with your credentials

# 3. Build the RAG server
cd vs-code-local-rag/copilot-rag-mcp && npm install && npm run build && cd ../..

# 4. Build & install the Agent Studio extension
cd vs-code-local-agent-ui && npm install && npm run compile
code --install-extension vs-code-local-agent-ui-0.0.1.vsix --force
cd ..

# 5. (Optional) Install Python dependencies
pip install -r reverse_engineering/requirements.txt

# 6. (Optional) Build Deep RL Agent
cd deep-rl-cpp-master/build && cmake .. -DCMAKE_BUILD_TYPE=Release && cmake --build . --config Release && cd ../..
```

---

## VS Code Tasks

All operations are available as VS Code tasks (Ctrl+Shift+P -> "Tasks: Run Task"):

| Task | What it does |
|------|-------------|
| Full Setup (1-Click Deploy) | Runs all install/build steps in sequence |
| Start All Core Services | Starts Ollama, ChromaDB, MCP Server |
| Start: MCP Server | Just the MCP server |
| Start: Ollama | Local LLM server for embeddings |
| Start: ChromaDB | Vector database for RAG |
| Start: Knowledge Graph Visualizer | Flask UI for reverse engineering output |
| Index: Build RAG Index | Embed workspace into vector store |
| Analyze: Reverse Engineer Project | Generate knowledge graph from codebase |
| Validate: Check Prerequisites | Verify all tools are installed |

---

## MCP Server Tools

Once running, the MCP server exposes these tools to Copilot agent mode:

| Tool | Purpose |
|------|---------|
| `ask_gemini` | Send prompts to Gemini via Apigee |
| `deep_rl_agent` | DQN-based code analysis and generation |
| `search_code` | Semantic search over indexed codebase |
| `get_context` | Token-budgeted context retrieval (RAG) |
| `list_indexed_files` | Show what is in the vector store |
| `reindex` | Refresh the codebase index |

### Deep RL Agent Usage

```json
{
  "name": "deep_rl_agent",
  "arguments": {
    "analysis_type": "user_story",
    "user_story": "As a user I want to export data as CSV",
    "requirement_context": "Exports should support filtering by date range and status"
  }
}
```

Code analysis mode:
```json
{
  "name": "deep_rl_agent",
  "arguments": {
    "analysis_type": "code",
    "code_provider": "gemini_apigee",
    "codebase_path": "/absolute/path/to/your/project",
    "user_story": "As a user I want to export data as CSV"
  }
}
```

Other code providers: `anthropic` (+ `api_key`), `ollama` (+ `ollama_base_url`), `generic` (+ `endpoint_url`).

---

## Agent Studio

The Local Agent Studio extension provides a UI for:
- **Selecting agents** from `.github/agents/`, the deployment package, or user profile
- **Running agent prompts** with automatic RAG context grounding
- **Starting/stopping services** directly from the Services panel
- **Exporting run reports** as Markdown or JSON

Open it: Ctrl+Shift+P -> "Local Agent Studio: Open Studio"

---

## Troubleshooting

### Binary Not Found
```bash
ls -la deep-rl-cpp-master/build/deep_rl_agent
npm run build-deep-rl  # Rebuild if missing
```

### Apigee Authentication Failed
- Verify `.env` has correct `APIGEE_ENDPOINT`, `APIGEE_KEY`, `APIGEE_SECRET`

### Timeout Error
- Binary times out after 5 minutes for large codebases
- Verify Gemini endpoint is accessible

### Validate Prerequisites
- Run task: "Validate: Check Prerequisites"

## Additional Resources

- **Architecture validation**: [VALIDATION.md](VALIDATION.md)
- **Team deployment strategy**: [DEPLOYMENT.md](DEPLOYMENT.md)
- **Multi-agent details**: `deep-rl-cpp-master/HOWTO.md`
- **DQN architecture**: `deep-rl-cpp-master/README.md`
