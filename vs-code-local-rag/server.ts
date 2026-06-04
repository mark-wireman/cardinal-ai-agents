#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, approxTokens } from "./config.js";
import { embedOne } from "./embeddings.js";
import { VectorStore, type SearchHit } from "./vectorstore.js";
import { indexRepo } from "./indexer.js";

const store = new VectorStore();

function fence(lang: string): string {
  return lang && lang !== "text" ? lang : "";
}

function renderHit(hit: SearchHit): string {
  const p = hit.payload;
  const header = `${p.path}:${p.startLine}-${p.endLine}${p.symbol ? ` (${p.symbol})` : ""}  [score ${hit.score.toFixed(3)}]`;
  return `### ${header}\n\`\`\`${fence(p.language)}\n${p.text}\n\`\`\``;
}

/** Drop near-duplicate ranges from the same file so the budget isn't wasted. */
function dedupe(hits: SearchHit[]): SearchHit[] {
  const kept: SearchHit[] = [];
  for (const h of hits) {
    const overlap = kept.find(
      (k) =>
        k.payload.path === h.payload.path &&
        h.payload.startLine <= k.payload.endLine &&
        h.payload.endLine >= k.payload.startLine,
    );
    if (!overlap) kept.push(h);
  }
  return kept;
}

const server = new McpServer(
  { name: "copilot-rag-mcp", version: "0.1.0" },
  {
    instructions:
      "Local semantic index of the user's codebase. Prefer get_context for grounding " +
      "an answer or edit (it returns a small, token-budgeted set of the most relevant " +
      "code) and use search_code to locate where something lives. These tools return " +
      "only the relevant slices of files, so do not request whole files unless a " +
      "returned slice is insufficient. Call reindex only when the index is stale.",
  },
);

server.registerTool(
  "search_code",
  {
    title: "Search code",
    description:
      "Semantic search over the indexed codebase. Returns the top matching code " +
      "chunks with file path and line range. Use this to locate relevant code " +
      "instead of reading or grepping whole files.",
    inputSchema: {
      query: z.string().describe("Natural-language or code description of what to find."),
      k: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe(`Number of chunks to return (default ${config.defaultTopK}).`),
    },
  },
  async ({ query, k }) => {
    const limit = k ?? config.defaultTopK;
    const vector = await embedOne(query);
    const hits = await store.search(vector, limit);
    if (hits.length === 0) {
      return { content: [{ type: "text", text: "No matches. The index may be empty — run reindex." }] };
    }
    const body = hits.map(renderHit).join("\n\n");
    return { content: [{ type: "text", text: body }] };
  },
);

server.registerTool(
  "get_context",
  {
    title: "Get budgeted context",
    description:
      "Returns the most relevant code for a task, packed to stay under a token " +
      "budget. This is the preferred way to gather grounding context before " +
      "answering or editing, because it minimizes tokens sent to the model.",
    inputSchema: {
      query: z.string().describe("What you are about to work on."),
      token_budget: z
        .number()
        .int()
        .min(200)
        .max(16000)
        .optional()
        .describe(`Hard ceiling on returned tokens (default ${config.defaultTokenBudget}).`),
    },
  },
  async ({ query, token_budget }) => {
    const budget = token_budget ?? config.defaultTokenBudget;
    const vector = await embedOne(query);
    // Over-fetch, then dedupe and pack to the budget.
    const raw = await store.search(vector, Math.max(config.defaultTopK * 3, 18));
    const hits = dedupe(raw);

    const blocks: string[] = [];
    let used = 0;
    for (const h of hits) {
      const block = renderHit(h);
      const cost = approxTokens(block);
      if (used + cost > budget) continue; // skip oversized; keep filling with smaller ones
      blocks.push(block);
      used += cost;
    }

    if (blocks.length === 0) {
      return {
        content: [
          { type: "text", text: "No context fit the budget. Raise token_budget or run reindex." },
        ],
      };
    }

    const text =
      `Context for: ${query}\n(${blocks.length} chunks, ~${used} tokens, budget ${budget})\n\n` +
      blocks.join("\n\n");
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "list_indexed_files",
  {
    title: "List indexed files",
    description: "Summarises what is currently indexed: distinct files and total chunk count.",
    inputSchema: {},
  },
  async () => {
    const { files, chunkCount } = await store.stats();
    const preview = files.slice(0, 200).join("\n");
    const more = files.length > 200 ? `\n...and ${files.length - 200} more` : "";
    return {
      content: [
        {
          type: "text",
          text: `${files.length} files, ${chunkCount} chunks indexed.\n\n${preview}${more}`,
        },
      ],
    };
  },
);

server.registerTool(
  "reindex",
  {
    title: "Reindex codebase",
    description:
      "Incrementally re-embed changed files into the vector store. Pass force=true " +
      "to rebuild everything (e.g. after changing the embedding model).",
    inputSchema: {
      force: z.boolean().optional().describe("Rebuild the entire index from scratch."),
    },
  },
  async ({ force }) => {
    const r = await indexRepo(force ?? false);
    return {
      content: [
        {
          type: "text",
          text:
            `Reindex complete. embedded=${r.indexedFiles} unchanged=${r.skippedFiles} ` +
            `removed=${r.removedFiles} chunks=${r.totalChunks}`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the JSON-RPC protocol.
  process.stderr.write(
    `copilot-rag-mcp ready. repo=${config.repoRoot} collection=${config.collection}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
