import "dotenv/config";
import path from "node:path";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  repoRoot: path.resolve(str("REPO_ROOT", process.cwd())),

  ollamaBaseUrl: str("OLLAMA_BASE_URL", "http://localhost:11434").replace(/\/$/, ""),
  embedModel: str("EMBED_MODEL", "nomic-embed-text"),

  chromaUrl: str("CHROMA_URL", "http://localhost:8000"),
  collection: str("COLLECTION", "codebase"),

  maxChunkChars: int("MAX_CHUNK_CHARS", 1600),
  chunkOverlapLines: int("CHUNK_OVERLAP_LINES", 12),
  chunkWindowLines: int("CHUNK_WINDOW_LINES", 55),

  defaultTopK: int("DEFAULT_TOP_K", 8),
  defaultTokenBudget: int("DEFAULT_TOKEN_BUDGET", 2200),
  embedBatchSize: int("EMBED_BATCH_SIZE", 16),
};

/**
 * Cheap token estimate. Roughly 1 token ~= 4 characters of code/English.
 * Used only for budgeting context packing, not for billing accuracy.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
