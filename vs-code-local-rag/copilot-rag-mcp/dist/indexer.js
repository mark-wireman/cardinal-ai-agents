import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import ignore from "ignore";
import { config } from "./config.js";
import { chunkSource, languageFor } from "./chunker.js";
import { embedBatch, probeDimension } from "./embeddings.js";
import { VectorStore } from "./vectorstore.js";
const DATA_DIR = path.join(config.repoRoot, ".copilot-rag");
const MANIFEST_PATH = path.join(DATA_DIR, "manifest.json");
// Directories and files never worth embedding.
const DEFAULT_IGNORES = [
    ".git/**",
    ".copilot-rag/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "out/**",
    "coverage/**",
    ".next/**",
    ".venv/**",
    "venv/**",
    "__pycache__/**",
    "target/**",
    "vendor/**",
    "*.min.js",
    "*.map",
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.pdf",
    "*.zip",
    "*.gz",
    "*.bin",
    "*.exe",
];
function sha1(text) {
    return crypto.createHash("sha1").update(text).digest("hex");
}
function log(msg) {
    // CLI logging goes to stdout; the MCP server never imports this for stdio use.
    process.stdout.write(`${msg}\n`);
}
async function loadManifest() {
    try {
        const raw = await fsp.readFile(MANIFEST_PATH, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return { model: config.embedModel, files: {} };
    }
}
async function saveManifest(m) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2), "utf8");
}
function buildIgnore() {
    const ig = ignore().add(DEFAULT_IGNORES);
    for (const name of [".gitignore", ".copilotignore"]) {
        const p = path.join(config.repoRoot, name);
        if (fs.existsSync(p))
            ig.add(fs.readFileSync(p, "utf8"));
    }
    return ig;
}
async function listSourceFiles() {
    const ig = buildIgnore();
    const entries = await fg("**/*", {
        cwd: config.repoRoot,
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
    });
    return entries.filter((rel) => !ig.ignores(rel));
}
export async function indexRepo(force = false) {
    log(`Indexing ${config.repoRoot}`);
    log(`Ollama: ${config.ollamaBaseUrl} (${config.embedModel})  Chroma: ${config.chromaUrl}`);
    const store = new VectorStore();
    const dim = await probeDimension();
    await store.ensureCollection(dim);
    const prev = await loadManifest();
    // Changing the embedding model invalidates every existing vector.
    if (prev.model !== config.embedModel)
        force = true;
    const next = { model: config.embedModel, files: {} };
    const files = await listSourceFiles();
    let indexedFiles = 0;
    let skippedFiles = 0;
    let totalChunks = 0;
    for (const rel of files) {
        const abs = path.join(config.repoRoot, rel);
        let source;
        try {
            source = await fsp.readFile(abs, "utf8");
        }
        catch {
            continue; // unreadable / binary
        }
        // Skip files that look binary.
        if (source.includes("\u0000"))
            continue;
        const hash = sha1(source);
        next.files[rel] = hash;
        if (!force && prev.files[rel] === hash) {
            skippedFiles += 1;
            continue;
        }
        // File is new or changed: clear its old vectors before re-adding.
        await store.deleteByPath(rel);
        const rawChunks = chunkSource(source);
        if (rawChunks.length === 0)
            continue;
        const language = languageFor(rel);
        const texts = rawChunks.map((c) => `// file: ${rel} (lines ${c.startLine}-${c.endLine})\n${c.text}`);
        for (let i = 0; i < texts.length; i += config.embedBatchSize) {
            const batchTexts = texts.slice(i, i + config.embedBatchSize);
            const batchChunks = rawChunks.slice(i, i + config.embedBatchSize);
            const vectors = await embedBatch(batchTexts);
            const points = vectors.map((vector, j) => {
                const c = batchChunks[j];
                const payload = {
                    path: rel,
                    startLine: c.startLine,
                    endLine: c.endLine,
                    symbol: c.symbol,
                    language,
                    text: c.text,
                    fileHash: hash,
                };
                return { id: crypto.randomUUID(), vector, payload };
            });
            await store.upsert(points);
            totalChunks += points.length;
        }
        indexedFiles += 1;
        if (indexedFiles % 25 === 0)
            log(`  ...${indexedFiles} files embedded`);
    }
    // Delete vectors for files that no longer exist (or are now ignored).
    let removedFiles = 0;
    for (const rel of Object.keys(prev.files)) {
        if (!next.files[rel]) {
            await store.deleteByPath(rel);
            removedFiles += 1;
        }
    }
    await saveManifest(next);
    log(`Done. embedded=${indexedFiles} unchanged=${skippedFiles} removed=${removedFiles} chunks=${totalChunks}`);
    return { indexedFiles, skippedFiles, removedFiles, totalChunks };
}
