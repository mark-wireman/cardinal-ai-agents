import { ChromaClient, IncludeEnum } from "chromadb";
import type { Collection } from "chromadb";
import { config } from "./config.js";

export interface ChunkPayload {
  path: string; // repo-relative path
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  symbol: string; // best-effort nearest declaration name
  language: string;
  text: string;
  fileHash: string; // hash of the whole source file (for incremental indexing)
}

export interface SearchHit {
  score: number;
  payload: ChunkPayload;
}

type ChromaMetadata = Record<string, string | number | boolean>;

export class VectorStore {
  private client: ChromaClient;
  private collection: Collection | null = null;

  constructor() {
    this.client = new ChromaClient({ path: config.chromaUrl });
  }

  private async getCollection(): Promise<Collection> {
    if (!this.collection) {
      this.collection = await this.client.getOrCreateCollection({
        name: config.collection,
        metadata: { "hnsw:space": "cosine" },
      });
    }
    return this.collection;
  }

  // dimension parameter kept for API compatibility with indexer.ts
  async ensureCollection(_dimension: number): Promise<void> {
    await this.getCollection();
  }

  async upsert(
    points: { id: string; vector: number[]; payload: ChunkPayload }[],
  ): Promise<void> {
    if (points.length === 0) return;
    const col = await this.getCollection();
    await col.upsert({
      ids: points.map((p) => p.id),
      embeddings: points.map((p) => p.vector),
      metadatas: points.map((p) => p.payload as unknown as ChromaMetadata),
      documents: points.map((p) => p.payload.text),
    });
  }

  /** Remove every chunk belonging to a given repo-relative file path. */
  async deleteByPath(repoRelativePath: string): Promise<void> {
    const col = await this.getCollection();
    await col.delete({ where: { path: repoRelativePath } });
  }

  async search(vector: number[], limit: number): Promise<SearchHit[]> {
    const col = await this.getCollection();
    const count = await col.count();
    if (count === 0) return [];

    const results = await col.query({
      queryEmbeddings: [vector],
      nResults: Math.min(limit, count),
      include: [IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    const metadatas = results.metadatas?.[0] ?? [];
    const distances = results.distances?.[0] ?? [];
    return metadatas
      .map((meta, i) => {
        if (!meta) return null;
        return {
          // Chroma cosine distance = 1 - cosine_similarity, so invert to get score
          score: 1 - (distances[i] ?? 1),
          payload: meta as unknown as ChunkPayload,
        };
      })
      .filter((h): h is SearchHit => h !== null);
  }

  /** Distinct indexed file paths plus a total chunk count. */
  async stats(): Promise<{ files: string[]; chunkCount: number }> {
    const col = await this.getCollection();
    const all = await col.get({ include: [IncludeEnum.Metadatas] });
    const files = new Set<string>();
    for (const meta of all.metadatas ?? []) {
      if (!meta) continue;
      const filePath = (meta as { path?: string })?.path;
      if (filePath) files.add(filePath);
    }
    return { files: [...files].sort(), chunkCount: all.ids.length };
  }
}
