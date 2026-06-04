# Agents Deployment Package - README

## Overview
This repository contains resources, scripts, and documentation for deploying and managing AI agents, with a focus on agent architecture, deployment flows, and supporting data/configuration files. The package is designed to facilitate the deployment and operation of agents in a modular and scalable manner.

---

## Repository Structure & File Descriptions

### Root Files

### Folders
 **.github/agents/**: Directory for GitHub Copilot-compatible agent definitions and configuration files. Each agent in this folder is designed to be used with GitHub Copilot or other GitHub-integrated automation tools. This folder may include YAML/JSON files describing agent capabilities, usage instructions, and workflow integration points.


## Agent Architecture
### Agents in `.github/agents/`
Each agent in the `.github/agents/` directory is a modular automation or AI component that can be triggered via GitHub workflows, Copilot, or other automation tools. Agents are defined by configuration files (YAML/JSON) specifying their:

- **Purpose**: What the agent does (e.g., code review, deployment, data extraction).
- **Inputs**: Required parameters or files.
- **Outputs**: Artifacts or results produced.
- **Triggers**: Events or workflow steps that activate the agent (e.g., push, pull request, manual dispatch).
- **Integration**: How the agent interacts with the rest of the repository (e.g., comments on PRs, creates issues, updates files).

#### Example Agent Descriptions

- **Deployment Agent**: Automates deployment of the MCP server or agents to a target environment. Triggered on push to main or via manual workflow dispatch. Reads deployment configuration, runs deployment scripts, and posts status updates.
- **Transcription Agent**: Runs the `transcribe_mp4.py` script on uploaded MP4 files, extracts transcripts, and attaches results to PRs or issues.
- **Documentation Agent**: Validates that documentation (e.g., `DEPLOYMENT.md`, `README.md`) is up to date with code changes. Can auto-generate or update docs based on codebase analysis.

> **Note:** The actual agents present may vary. See each file in `.github/agents/` for specific details and configuration.

### Using Agents with GitHub Copilot

GitHub Copilot can leverage agents in this repository by:

1. **Workflow Integration**: Agents are referenced in GitHub Actions workflows (e.g., `.github/workflows/`). When a workflow runs, it can invoke agents as defined in `.github/agents/`.
2. **Manual Invocation**: Some agents support manual triggers via the GitHub Actions UI ("Run workflow" button). Parameters can be set as defined in the agent's configuration.
3. **Copilot Chat**: When using GitHub Copilot Chat, you can ask Copilot to:
   - Summarize what each agent does (by referencing `.github/agents/` files).
   - Suggest how to invoke or configure an agent.
   - Generate or modify agent configuration files.
4. **Custom Prompts**: For AI-powered agents, Copilot can help you write prompts or scripts to interact with the agent, or explain the agent's logic and expected outputs.

#### Example: Running an Agent via Workflow

1. Navigate to the **Actions** tab in your GitHub repository.
2. Select the workflow that uses the desired agent.
3. Click **Run workflow** (if manual trigger is supported).
4. Fill in any required parameters and start the workflow.
5. Monitor workflow logs for agent output and results.

#### Example: Modifying an Agent with Copilot

1. Open the agent's configuration file in `.github/agents/`.
2. Use Copilot Chat to ask for explanations or suggestions (e.g., "Explain this agent's configuration" or "Add a new trigger for pull requests").
3. Apply Copilot's suggestions and commit changes.

---

### High-Level Components
1. **MCP Server (`mcp-server.js`)**
   - Acts as the central orchestrator for agent execution.
   - Handles incoming API requests (possibly via Apigee), routes them to the appropriate agent, and manages agent lifecycle (init, run, shutdown).
   - Integrates with model files (base/medium) for agent instantiation.

2. **Model Files (`base.en.pt`, etc.)**
   - Provide the neural network weights and configurations for different agent variants.
   - Loaded by the MCP server or agent runtime as needed.

3. **Supporting Scripts & Data**
   - `transcribe_mp4.py`: Used for preprocessing MP4 files.
   - CSVs in `screen_mockups_csv/`: Used for configuring agent behavior, simulating UI, or providing test scenarios.
   - API specs in `context/`: Define the external interfaces agents must support.

4. **Documentation & Diagrams**
   - Markdown and draw.io files provide architectural overviews, deployment instructions, and flow diagrams for onboarding and maintenance.

---

## Execution Flow

1. **Initialization**
   - The MCP server is started (via Node.js), loading configuration from `package.json` and initializing agent models from the appropriate `.pt` files.

2. **API Request Handling**
   - External systems (e.g., via Apigee) send requests to the MCP server.
   - The server parses requests, determines the required agent, and loads the necessary model/context.

3. **Agent Execution**
   - The agent processes the request, possibly using context from CSVs or API specs.
   - If needed, the agent may invoke supporting scripts (e.g., for transcription or data extraction).

4. **Response & Logging**
   - The agent returns results to the MCP server, which formats and sends the response back to the requester.
   - Logs and transcripts may be generated for monitoring or further training.

5. **Monitoring & Maintenance**
   - Diagrams and documentation support ongoing maintenance, troubleshooting, and onboarding of new team members.

---

## Prerequisites

Before deploying or running components in this repository, ensure the following are installed and configured:

1. **Node.js and npm**
   - Node.js v18 or later
   - npm (comes with Node.js)

2. **C++ Build Tools (for deep_rl_agent binary)**
   - **Windows**: Visual Studio Build Tools 2017 or later with C++ workload OR MinGW-w64
   - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
   - **Linux**: GCC/G++ compiler, make, and Python 3
   - CMake 3.16 or later
   - libcurl and nlohmann-json (optional, for LLM integration)

3. **Node.js packages (repository dependencies)**
   - `@modelcontextprotocol/sdk`
   - `node-fetch`
   - `dotenv`
   - Install with: `npm install`

4. **FOR TPMs ONLY** **Python runtime (for transcription workflow)**
   - Python 3.10 or later recommended

5. **FOR TPMs ONLY** **Python packages (for `transcribe_mp4.py`)**
   - `openai-whisper` (imported as `whisper`)
   - `torch` (required by Whisper runtime)
   - Install with: `pip install openai-whisper torch`

6. **FFmpeg (required for MP4/audio transcription)**
   - FFmpeg must be installed and available in PATH, or supplied via `--ffmpeg_path` when running the transcription script.

7. **ALREADY INCLUDED IN THE .ENV FILE** **Credentials and environment variables (for MCP server and Gemini via Apigee)**
   - `APIGEE_ENDPOINT`
   - `APIGEE_KEY`
   - `APIGEE_SECRET`
   - `GEMINI_ENDPOINT`

8. **Model and project assets**
   - Required model/config files present in repository (for example: `base.en.pt`, `base.pt`, `medium`, `medium.en.pt`, `medium.pt`)
   - Access to the `context/` folder and agent definitions in `.github/agents/`

9. **Optional deployment tooling (recommended for shared environments)**
   - PM2 for process management (`npx pm2 ...`)
   - Docker/Kubernetes for containerized deployment

10. **Network access**
    - Outbound access from host environment to configured Apigee and Gemini endpoints

---

## Getting Started
1. **Install Node dependencies**: Run `npm install` to set up Node.js dependencies.
2. **Build the deep_rl_agent binary** (for multi-agent code generation):
   ```bash
   cd deep-rl-cpp-master/build
   cmake .. -DCMAKE_BUILD_TYPE=Release
   make -j$(nproc)  # or: cmake --build . --config Release on Windows
   cd ../..
   ```
3. **Start the MCP server**: Run `node mcp-server.js` (or use a script from `package.json`).
4. **Configure agents**: Update model files, CSVs, and API specs as needed for your deployment.
5. **Refer to documentation**: See `DEPLOYMENT.md` and architecture diagrams for detailed setup and flow information.

### Using the Deep RL Multi-Agent Analyzer

The MCP server now includes a `deep_rl_agent` tool (with backward-compatible alias `deep_rl_code_agent`) that supports both story-only analysis and code-aware analysis/generation (as documented in `deep-rl-cpp-master/HOWTO.md`):

**Architecture:**
```
MCP Server → deep_rl_agent binary (subprocess) → LLM endpoint (provider-specific)
     ↓              ↓                                      ↓
  Node.js      C++ DQN Agent                      Code Generation
             (analyzes codebase,
              learns patterns)
```

**Example usage (story-only mode):**
```javascript
{
   "name": "deep_rl_agent",
   "arguments": {
      "analysis_type": "user_story",
      "user_story": "As a pharmacist I want to view cleaning task schedule grouped by frequency",
      "requirement_context": "Display tasks grouped by daily, weekly, and monthly frequencies"
   }
}
```

**Example usage (code mode via Gemini + Apigee):**
```javascript
{
   "name": "deep_rl_agent",
  "arguments": {
      "analysis_type": "code",
      "code_provider": "gemini_apigee",
    "codebase_path": "/path/to/your/project",
    "user_story": "As a user I want to reset my password via email"
  }
}
```

**Example usage (code mode via Ollama):**
```javascript
{
   "name": "deep_rl_agent",
   "arguments": {
      "analysis_type": "code",
      "code_provider": "ollama",
      "codebase_path": "/path/to/your/project",
      "ollama_base_url": "http://localhost:11434",
      "ollama_model": "llama3.1:8b",
      "user_story": "As a user I want to reset my password via email"
   }
}
```

**What it does:**
1. **In `user_story` mode**: scores story quality and optional requirement alignment
2. **In `code` mode**: analyzes codebase, trains DQN, builds context-aware prompt, and calls the selected provider
3. **Returns mode-specific output**:
    - Story mode: structured user story analysis section
    - Code mode: generated prompt, generated code, user story analysis, code analysis summary

**Output format:**
```
=== Deep RL Multi-Agent Analysis ===

Analysis: Files: 21, Pattern: MVC

--- Generated Prompt ---
[Context-aware prompt with detected libraries and patterns]

--- Generated Code ---
[Architecture-conforming implementation]

--- User Story Analysis ---
story[hash] -> score: 0.8

--- Code Analysis ---
Language: C++, Pattern: MVC, Files: 21
```

Story-only output starts with:
```
=== Deep RL User Story Analysis ===
```

---

## Additional Notes
- For detailed API and agent configuration, see files in the `context/` and `screen_mockups_csv/` directories.
- For visualizing architecture or flow, open `.drawio` files in draw.io.
- For transcript extraction or audio processing, use `transcribe_mp4.py` as described in `transcript_extraction_architecture.md`.

---

For further questions, consult the documentation files or contact the repository maintainers.
