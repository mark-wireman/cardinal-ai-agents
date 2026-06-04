# Copilot Instructions

## Context retrieval (read this first)

This workspace has a local semantic index exposed through the **agents-deployment**
MCP server. Use it as your primary way to gather code context.

- Before answering a question about the code or making an edit, call
  **`get_context`** with a short description of the task. It returns the most
  relevant code already trimmed to a token budget. Work from what it returns.
- Use **`search_code`** when you need to locate where something lives (a
  function, a route, a config) rather than to read large spans.
- **Do not read or request whole files** unless a returned slice is genuinely
  insufficient, and then ask for only the specific lines you still need.
- **Do not grep or scan the repository broadly.** Prefer one targeted retrieval
  over pulling many files into context.
- If retrieval returns nothing useful, say so and ask a clarifying question
  instead of loading large amounts of code speculatively.
- Call **`reindex`** only if results look stale (e.g. you just created files).

## Why

Context tokens are billed. Pulling irrelevant code into the request inflates
cost without improving the answer. Retrieve narrowly, then reason.

## Answering style

- Keep responses focused; show only the code that changes.
- When editing, return a minimal diff or the changed function, not the whole file.
- State assumptions briefly rather than re-deriving context already retrieved.

## Additional tools

This workspace also exposes:
- **`ask_gemini`** — Send prompts to Gemini AI via Apigee.
- **`deep_rl_agent`** — DQN-based code analysis and generation from user stories.
