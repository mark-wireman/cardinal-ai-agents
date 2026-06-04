# Quick Start: Deep RL Multi-Agent Code Generator

## Prerequisites Check
```bash
# 1. Verify Node.js
node --version  # Should be v18+

# 2. Verify C++ build tools
cmake --version  # Should be 3.16+
g++ --version    # Or clang/MSVC

# 3. Verify deep_rl_agent binary exists
ls deep-rl-cpp-master/build/deep_rl_agent  # Should exist
```

## Setup (First Time)

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Build Deep RL Agent Binary
```bash
# Option A: Use npm script
npm run build-deep-rl

# Option B: Manual build
cd deep-rl-cpp-master/build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j4  # Or: cmake --build . --config Release on Windows
cd ../..
```

### 3. Configure Environment Variables
Create/verify `.env` file with:
```env
APIGEE_ENDPOINT=https://your-apigee-endpoint/oauth/token
APIGEE_KEY=your-apigee-key
APIGEE_SECRET=your-apigee-secret
GEMINI_ENDPOINT=https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent
```

## Running the MCP Server

```bash
node mcp-server.js
```

Expected output:
```
Deep RL Agent binary found at: .../deep_rl_agent
Gemini-Apigee MCP server running
```

## Using the Deep RL Agent

### Via MCP Tool Call (Story-Only Analysis)
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

### Via MCP Tool Call (Code Analysis + Generation with Gemini/Apigee)
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

### Other Code Providers
- `code_provider: "anthropic"` + `api_key`
- `code_provider: "ollama"` + `ollama_base_url` (+ optional `ollama_model`)
- `code_provider: "generic"` + `endpoint_url` (+ optional `token`)

`deep_rl_code_agent` remains supported as a backward-compatible alias.

### What Happens
1. ✅ MCP server validates `analysis_type`
2. ✅ Spawns deep_rl_agent binary in mode-aware argument format
3. ✅ In `user_story` mode: returns story quality/alignment analysis
4. ✅ In `code` mode: analyzes codebase, trains DQN, and calls selected LLM provider
5. ✅ Returns mode-specific formatted output

### Response Format
```
=== Deep RL Multi-Agent Analysis ===

Analysis: Files: 47, Pattern: MVC

--- Generated Prompt ---
[Contextual prompt with detected libraries]

--- Generated Code ---
[Architecture-conforming implementation]

--- User Story Analysis ---
story[hash] -> score: 0.85

--- Code Analysis ---
Language: C++, Pattern: MVC, Files: 47
```

Story-only response format:
```
=== Deep RL User Story Analysis ===

Mode: user_story
Requirement context: provided

--- Story Analysis ---
[Role/Goal/Benefit checks, scores, feedback]
```

## Troubleshooting

### Binary Not Found
```bash
# Check if binary exists
ls -la deep-rl-cpp-master/build/deep_rl_agent

# If missing, rebuild:
npm run build-deep-rl
```

### Timeout Error
- Binary execution times out after 5 minutes
- Check codebase size (large projects take longer)
- Verify Gemini endpoint is accessible

### Apigee Authentication Failed
- Verify `.env` file has correct credentials
- Check APIGEE_ENDPOINT, APIGEE_KEY, APIGEE_SECRET
- Test token generation: see mcp-server.js `getApigeeToken()`

### Gemini API Error
- Verify GEMINI_ENDPOINT is correct
- Check token has Gemini API access
- Review deep_rl_agent stderr output

## Architecture Validation

See [VALIDATION.md](VALIDATION.md) for complete validation details and compliance with documented multi-agent architecture (per deep-rl-cpp-master/HOWTO.md and README.md).

## Additional Resources

- **Multi-agent details**: `deep-rl-cpp-master/HOWTO.md`
- **DQN architecture**: `deep-rl-cpp-master/README.md`
- **Validation report**: `VALIDATION.md`
- **MCP server code**: `mcp-server.js` (lines 1-235)
