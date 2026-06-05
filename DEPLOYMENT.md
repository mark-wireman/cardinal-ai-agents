## Gemini Agents & MCP Server Deployment Strategy for nuclear-isotrac* Repositories

This strategy enables a team of developers and project managers to use the Gemini-powered agents (user story, code review, frontend/backend code generation, Katalon test generator) across all code repositories.

### Prerequisites
- **Node.js runtime**: Node.js v18+ and npm
- **C++ Build Tools (for deep_rl_agent multi-agent binary)**:
  - **Windows**: Visual Studio Build Tools 2017+ with C++ workload OR MinGW-w64
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: GCC/G++ compiler, make, and Python 3
  - CMake 3.16+
  - libcurl and nlohmann-json (for LLM integration)
- **Node dependencies**: Install with `npm install` (`@modelcontextprotocol/sdk`, `node-fetch`, `dotenv`)
- **Deep RL Agent binary**: Build with `npm run build-deep-rl` or manually in `deep-rl-cpp-master/build`
- **FOR TPMs ONLY** **Python runtime (for transcription workflows)**: Python 3.10+
- **FOR TPMs ONLY** **Python dependencies (for `transcribe_mp4.py`)**: `openai-whisper`, `torch`
- **Media tooling**: FFmpeg installed and accessible in PATH (or passed using `--ffmpeg_path`)
- **ALREADY INCLUDED IN THE .ENV FILE** **Credentials and environment variables**:
  - `APIGEE_ENDPOINT`
  - `APIGEE_KEY`
  - `APIGEE_SECRET`
  - `GEMINI_ENDPOINT`
- **Repository assets**: Required model files and context artifacts available in repository (`*.pt`, `context/`, `.github/agents/`)
- **Optional production tooling**: PM2, systemd, or Docker/Kubernetes for long-running service management
- **Network requirements**: Outbound connectivity to Apigee and Gemini endpoints

### 1. Centralized MCP Server Deployment
- **Host the MCP server** (`mcp-server.js`) on a shared, always-on development server (on-premises or cloud VM).
- Ensure Node.js (v18+) is installed.
- Place the `.env` file (with Apigee and Gemini credentials) securely on the server. Restrict access to authorized team members only.
- Install dependencies: `npm install` in the root directory.
- Start the MCP server as a background service (e.g., using PM2, systemd, or a Docker container for reliability):
  - Example: `npx pm2 start mcp-server.js --name gemini-apigee-mcp`

### 1.1 MCP Tool Parameters (deep_rl_agent)

The MCP server exposes `deep_rl_agent` as the primary tool (with backward-compatible alias `deep_rl_code_agent`).

#### Story-only analysis mode
Use this when evaluating user story quality and optional requirement alignment.

```json
{
  "name": "deep_rl_agent",
  "arguments": {
    "analysis_type": "user_story",
    "user_story": "As a user I want to export data as CSV",
    "requirement_context": "Optional original requirement text"
  }
}
```

#### Code analysis + generation mode
Use this when analyzing a codebase and generating implementation output.

```json
{
  "name": "deep_rl_agent",
  "arguments": {
    "analysis_type": "code",
    "code_provider": "gemini_apigee",
    "codebase_path": "/absolute/path/to/repo",
    "user_story": "As a user I want to export data as CSV"
  }
}
```

`code_provider` options and required parameters:
- `gemini_apigee`: requires `codebase_path`, `user_story`; uses `GEMINI_ENDPOINT` + Apigee token from `.env`.
- `anthropic`: requires `codebase_path`, `user_story`, `api_key`.
- `ollama`: requires `codebase_path`, `user_story`, `ollama_base_url`; optional `ollama_model` (default `llama3`).
- `generic`: requires `codebase_path`, `user_story`, `endpoint_url`; optional `token`.

Notes:
- `user_story` is always required.
- If `analysis_type` is omitted, MCP defaults to `code` when `codebase_path` is provided; otherwise `user_story`.
- `deep_rl_code_agent` accepts the same schema as `deep_rl_agent`.


### 2. Agent & Context Configuration & Access
- Store all agent YAML/MD files in a central `.github/agents/` directory accessible to all repositories (or symlink/copy as needed).
- Store the `context/` folder (containing standards, requirements, patterns, etc.) in a central location accessible to all nuclear-isotrac* repositories. Recommended approaches:
  - Place `context/` at the root of a shared parent directory, or
  - Use a dedicated repository or shared network location for `context/`.
- For each repository, either:
  - Symlink the central `context/` folder into the repo (if supported by your OS and tooling), or
  - Reference the central `context/` path in agent configurations and documentation.
- Update agent configuration files to point to the central `context/` folder for all standards, requirements, and patterns references.
- If using VS Code or similar tools, configure the workspace to include the central `context/` folder (e.g., as a workspace folder or via symlink) so agents and users can access it seamlessly.

### 3. Repository Integration
- For each `code` repository:
  - Add the `.github/agents/` directory (or reference the central one).
  - Document in the repository README how to invoke the agents (e.g., via VS Code extension, CLI, or web UI).
  - Optionally, provide scripts or tasks for common agent actions (e.g., generate user story, review code, scaffold backend).

### 4. Security & Credentials
- Never commit `.env` or credential files to source control.
- Use environment variables or secret managers for production deployments.
- Limit access to the MCP server and agent endpoints to the project team.

### 5. Developer & PM Workflow
- Developers and PMs interact with the agents via their IDE (VS Code), CLI, or web UI, sending requests to the MCP server.
- Agents leverage the Gemini API via Apigee for all AI-powered tasks.
- All generated artifacts (stories, code, reviews, tests) are saved directly into the relevant repository.

### 6. Maintenance & Updates
- Regularly update the MCP server and agent files for new features or security patches.
- Rotate API keys/secrets as needed.
- Monitor server logs for errors or misuse.

### 7. Optional: Containerization
- For portability, package the MCP server and agent configs in a Docker image.
- Mount the `.env` file and agent directory as volumes.
- Deploy on Kubernetes or Docker Compose for scalability.

---
**Summary:**
Centralize the MCP server and agent configs, secure credentials, and provide clear documentation for team access. Integrate agent workflows into each code* repository for seamless, AI-powered development and project management.
