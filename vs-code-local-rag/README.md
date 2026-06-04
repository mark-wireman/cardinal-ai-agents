# copilot-rag-mcp

A **fully local** Retrieval-Augmented Generation MCP server that gives GitHub
Copilot agent mode token-efficient semantic search over your codebase.

- **Embeddings:** Ollama (local, no API cost)
- **Vector store:** Qdrant (local Docker)
- **Protocol:** Model Context Protocol over stdio (works with Copilot agent mode)

## Why this saves money

As of **June 1, 2026**, GitHub Copilot bills on **token usage** (input, output,
and cached tokens) rather than premium requests. Code completions stay free; the
metering hits chat, agent mode, and code review. The dominant cost lever is now
**how much context you send per turn** — trimming a request from ~100k to ~20k
input tokens is roughly an 80% input-cost reduction.

This server returns **only the relevant slices** of your code via the
`get_context` tool (packed to a hard token budget) instead of letting Copilot
read or grep whole files. Paired with the included `copilot-instructions.md`,
Copilot is told to retrieve narrowly before answering.

## Prerequisites

- Node.js 18.17+
- [Ollama](https://ollama.com) running locally
- Docker (for Qdrant) or a Qdrant instance

## Setup

```bash
# 1. Start Ollama and pull an embedding model
ollama pull nomic-embed-text          # 768-dim, fast
# or: ollama pull mxbai-embed-large   # 1024-dim, higher quality

# 2. Start Qdrant locally
docker run -p 6333:6333 -p 6334:6334 -v "$(pwd)/qdrant_storage:/qdrant/storage" qdrant/qdrant

# 3. Install and build this server
npm install
cp .env.example .env                  # then edit REPO_ROOT etc.
npm run build

# 4. Build the index for your repo (incremental on subsequent runs)
npm run index                         # add -- --force to rebuild from scratch
```

## Wire it into VS Code

Copy `.vscode/mcp.json` into your **target repo** (the one Copilot edits), or use
the `settings.snippet.jsonc` form for a user-level install. Replace the absolute
path to `dist/server.js`. Then:

1. Reload VS Code.
2. Command Palette -> **MCP: Show MCP Servers** -> confirm `codebase-rag` is
   **Running**.
3. Open Copilot Chat -> **Agent** mode -> in the Tools dropdown, enable the
   `codebase-rag` tools.

VS Code's `.vscode/mcp.json` uses the top-level key **`servers`** (not
`mcpServers`, which is Cursor/Claude Desktop). In user `settings.json` the same
block lives under an `mcp` key.

## Tools exposed

| Tool                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `get_context`        | Most relevant code for a task, packed under a token budget.    |
| `search_code`        | Locate code by meaning; returns path + line range per chunk.   |
| `list_indexed_files` | Summarise what's indexed (files + chunk count).                |
| `reindex`            | Incrementally re-embed changed files (`force` to rebuild all). |

## How indexing works

- Walks `REPO_ROOT`, respecting `.gitignore`, `.copilotignore`, and a built-in
  ignore list (node_modules, dist, lockfiles, binaries, etc.).
- Chunks each file into overlapping line windows (capped by `MAX_CHUNK_CHARS`),
  preferring blank-line boundaries, and tags each chunk with its nearest symbol.
- Stores a content hash per file in `.copilot-rag/manifest.json`. Re-running only
  re-embeds changed files and deletes vectors for removed ones. Changing the
  embedding model triggers a full rebuild automatically.

## Keep it fresh

Run `npm run index` from a watch task, a git `post-commit` hook, or periodically.
The `reindex` tool lets Copilot refresh on demand, but a hook keeps cost at zero
since embeddings are local.

## Tuning the cost/quality trade-off

- `DEFAULT_TOKEN_BUDGET` — the hard ceiling `get_context` packs to. Lower = cheaper.
- `DEFAULT_TOP_K` — chunks `search_code` returns.
- `CHUNK_WINDOW_LINES` / `MAX_CHUNK_CHARS` — chunk granularity.
- `EMBED_MODEL` — `nomic-embed-text` (fast) vs `mxbai-embed-large` (sharper recall).

## Notes

- Token counts here are approximate (chars / 4), used only for packing — not
  Copilot's exact billing tokenizer. Check your GitHub billing dashboard for
  real numbers.
- All embedding/search traffic stays on localhost; your code is not sent to any
  third-party embedding API.
