import { ChromaClient, IncludeEnum } from "chromadb";
import { config } from "./config.js";
export class VectorStore {
    client;
    collection = null;
    constructor() {
        this.client = new ChromaClient({ path: config.chromaUrl });
    }
    async getCollection() {
        if (!this.collection) {
            this.collection = await this.client.getOrCreateCollection({
                name: config.collection,
                metadata: { "hnsw:space": "cosine" },
            });
        }
        return this.collection;
    }
    // dimension parameter kept for API compatibility with indexer.ts
    async ensureCollection(_dimension) {
        await this.getCollection();
    }
    async upsert(points) {
        if (points.length === 0)
            return;
        const col = await this.getCollection();
        await col.upsert({
            ids: points.map((p) => p.id),
            embeddings: points.map((p) => p.vector),
            metadatas: points.map((p) => p.payload),
            documents: points.map((p) => p.payload.text),
        });
    }
    /** Remove every chunk belonging to a given repo-relative file path. */
    async deleteByPath(repoRelativePath) {
        const col = await this.getCollection();
        await col.delete({ where: { path: repoRelativePath } });
    }
    async search(vector, limit) {
        const col = await this.getCollection();
        const count = await col.count();
        if (count === 0)
            return [];
        const results = await col.query({
            queryEmbeddings: [vector],
            nResults: Math.min(limit, count),
            include: [IncludeEnum.Metadatas, IncludeEnum.Distances],
        });
        const metadatas = results.metadatas?.[0] ?? [];
        const distances = results.distances?.[0] ?? [];
        return metadatas
            .map((meta, i) => {
            if (!meta)
                return null;
            return {
                // Chroma cosine distance = 1 - cosine_similarity, so invert to get score
                score: 1 - (distances[i] ?? 1),
                payload: meta,
            };
        })
            .filter((h) => h !== null);
    }
    /** Distinct indexed file paths plus a total chunk count. */
    async stats() {
        const col = await this.getCollection();
        const all = await col.get({ include: [IncludeEnum.Metadatas] });
        const files = new Set();
        for (const meta of all.metadatas ?? []) {
            if (!meta)
                continue;
            const filePath = meta?.path;
            if (filePath)
                files.add(filePath);
        }
        return { files: [...files].sort(), chunkCount: all.ids.length };
    }
}
