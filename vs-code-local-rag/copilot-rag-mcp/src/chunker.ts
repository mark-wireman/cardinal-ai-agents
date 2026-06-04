import path from "node:path";
import { config } from "./config.js";

export interface RawChunk {
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
  symbol: string;
  text: string;
}

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".kt": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".md": "markdown",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
  ".sh": "shell",
};

export function languageFor(filePath: string): string {
  return EXT_LANG[path.extname(filePath).toLowerCase()] ?? "text";
}

// Best-effort "what declaration am I inside" detection for labelling chunks.
const DECL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
  /\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/,
  /\bdef\s+([A-Za-z0-9_]+)/, // python
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, // go
  /\bfn\s+([A-Za-z0-9_]+)/, // rust
  /\b(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+([A-Za-z0-9_]+)\s*\(/, // java/c#
];

function detectSymbol(lines: string[]): string {
  for (const line of lines) {
    for (const re of DECL_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1]) return m[1];
    }
  }
  return "";
}

/**
 * Splits source into overlapping line windows, preferring to break on blank
 * lines near the window boundary, and hard-splitting windows that exceed
 * MAX_CHUNK_CHARS. Returns at least one chunk for non-empty files.
 */
export function chunkSource(source: string): RawChunk[] {
  const lines = source.split(/\r?\n/);
  const total = lines.length;
  if (source.trim().length === 0) return [];

  const window = Math.max(10, config.chunkWindowLines);
  const overlap = Math.min(config.chunkOverlapLines, window - 1);
  const chunks: RawChunk[] = [];

  let start = 0; // 0-based line index
  while (start < total) {
    let end = Math.min(start + window, total); // exclusive

    // Try to extend/retract to a nearby blank line for a cleaner boundary.
    const searchFrom = Math.max(start + Math.floor(window * 0.6), start + 1);
    for (let i = Math.min(end, total) - 1; i >= searchFrom; i--) {
      if (lines[i]?.trim() === "") {
        end = i + 1;
        break;
      }
    }

    let slice = lines.slice(start, end);
    let text = slice.join("\n");

    // Hard cap on characters: shrink the window until it fits.
    while (text.length > config.maxChunkChars && slice.length > 1) {
      slice = slice.slice(0, Math.ceil(slice.length / 2));
      end = start + slice.length;
      text = slice.join("\n");
    }

    if (text.trim().length > 0) {
      chunks.push({
        startLine: start + 1,
        endLine: end,
        symbol: detectSymbol(slice),
        text,
      });
    }

    if (end >= total) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
