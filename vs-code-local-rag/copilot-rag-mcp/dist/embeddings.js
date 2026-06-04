import { config } from "./config.js";
/**
 * Embeds an array of texts using a local Ollama model.
 *
 * Primary path: POST /api/embed with an `input` array (Ollama >= 0.2),
 * which returns { embeddings: number[][] }.
 * Fallback path: per-item POST /api/embeddings with `prompt`
 * (older Ollama), returning { embedding: number[] }.
 */
export async function embedBatch(texts) {
    if (texts.length === 0)
        return [];
    try {
        const res = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: config.embedModel, input: texts }),
        });
        if (res.ok) {
            const data = (await res.json());
            if (data.embeddings && data.embeddings.length === texts.length) {
                return data.embeddings;
            }
        }
    }
    catch {
        // fall through to legacy endpoint
    }
    // Legacy fallback: one request per text.
    const out = [];
    for (const text of texts) {
        const res = await fetch(`${config.ollamaBaseUrl}/api/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: config.embedModel, prompt: text }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Ollama embedding request failed (${res.status}). ` +
                `Is Ollama running at ${config.ollamaBaseUrl} and is "${config.embedModel}" pulled? ${body}`);
        }
        const data = (await res.json());
        out.push(data.embedding);
    }
    return out;
}
export async function embedOne(text) {
    const [v] = await embedBatch([text]);
    return v;
}
/** Probe the model once to learn the embedding dimensionality. */
export async function probeDimension() {
    const v = await embedOne("dimension probe");
    if (!v || v.length === 0) {
        throw new Error("Could not determine embedding dimension from Ollama.");
    }
    return v.length;
}
