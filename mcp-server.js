#!/usr/bin/env node
 
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// --- RAG imports (compiled from copilot-rag-mcp) ---
import { config as ragConfig, approxTokens } from './vs-code-local-rag/copilot-rag-mcp/dist/config.js';
import { embedOne } from './vs-code-local-rag/copilot-rag-mcp/dist/embeddings.js';
import { VectorStore } from './vs-code-local-rag/copilot-rag-mcp/dist/vectorstore.js';
import { indexRepo } from './vs-code-local-rag/copilot-rag-mcp/dist/indexer.js';

// RAG vector store singleton
const ragStore = new VectorStore();

function fence(lang) {
  return lang && lang !== 'text' ? lang : '';
}

function renderHit(hit) {
  const p = hit.payload;
  const header = `${p.path}:${p.startLine}-${p.endLine}${p.symbol ? ` (${p.symbol})` : ''}  [score ${hit.score.toFixed(3)}]`;
  return `### ${header}\n\`\`\`${fence(p.language)}\n${p.text}\n\`\`\``;
}

function dedupeHits(hits) {
  const kept = [];
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

// Check if RAG dependencies (Ollama, ChromaDB) are configured
const ragAvailable = Boolean(ragConfig.ollamaBaseUrl && ragConfig.chromaUrl);
if (ragAvailable) {
  console.error(`RAG tools enabled. repo=${ragConfig.repoRoot} collection=${ragConfig.collection}`);
} else {
  console.error('Warning: RAG tools disabled. Set OLLAMA_BASE_URL and CHROMA_URL env vars.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Locate deep_rl_agent binary
const DEEP_RL_AGENT_BINARY = join(__dirname, 'deep-rl-cpp-master', 'build', 'deep_rl_agent');
const deepRLAgentAvailable = existsSync(DEEP_RL_AGENT_BINARY);

if (deepRLAgentAvailable) {
  console.error('Deep RL Agent binary found at:', DEEP_RL_AGENT_BINARY);
} else {
  console.error('Warning: Deep RL Agent binary not found. Expected at:', DEEP_RL_AGENT_BINARY);
  console.error('Build it with: cd deep-rl-cpp-master/build && cmake .. && make');
}
 
// Token cache
let tokenCache = {
  token: null,
  expiresAt: null
};
 
// Apigee authentication
async function getApigeeToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }
 
  try {
    const response = await fetch(process.env.APIGEE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.APIGEE_KEY,
        'X-API-Secret': process.env.APIGEE_SECRET
      },
      body: JSON.stringify({
        grant_type: 'client_credentials'
      })
    });
 
    const data = await response.json();
    const expiresIn = data.expires_in || 3600;
    
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (expiresIn - 300) * 1000
    };
 
    return tokenCache.token;
  } catch (error) {
    throw new Error(`Apigee auth failed: ${error.message}`);
  }
}
 
// Call Gemini with prompt
async function callGemini(prompt) {
  const token = await getApigeeToken();
 
  try {
    const response = await fetch(process.env.GEMINI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    });
 
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    throw new Error(`Gemini call failed: ${error.message}`);
  }
}
 
// Create MCP server
const server = new Server(
  {
    name: 'gemini-apigee-server',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAnalysisType(argumentsObj) {
  if (hasText(argumentsObj?.analysis_type)) {
    return argumentsObj.analysis_type.trim().toLowerCase();
  }

  // Backward compatibility: if codebase_path exists, treat as code mode.
  if (hasText(argumentsObj?.codebase_path)) {
    return 'code';
  }

  return 'user_story';
}

function normalizeCodeProvider(argumentsObj) {
  if (hasText(argumentsObj?.code_provider)) {
    return argumentsObj.code_provider.trim().toLowerCase();
  }
  return 'gemini_apigee';
}

async function buildDeepRLArgs(argumentsObj) {
  const analysisType = normalizeAnalysisType(argumentsObj);

  if (!hasText(argumentsObj?.user_story)) {
    throw new Error('Missing required parameter: user_story');
  }

  const userStory = argumentsObj.user_story.trim();

  // deep_rl_agent story-only detection requires argv[1] to contain a space.
  if (analysisType === 'user_story' && !userStory.includes(' ')) {
    throw new Error('For story-only mode, user_story must contain at least one space so deep_rl_agent detects story mode');
  }

  if (analysisType === 'user_story') {
    const args = [userStory];
    if (hasText(argumentsObj?.requirement_context)) {
      args.push(argumentsObj.requirement_context.trim());
    }

    return {
      analysisType,
      provider: 'story_only',
      args,
      metadata: {
        storyOnly: true,
        hasRequirementContext: args.length > 1
      }
    };
  }

  if (analysisType !== 'code') {
    throw new Error(`Invalid analysis_type: ${analysisType}. Expected "user_story" or "code"`);
  }

  if (!hasText(argumentsObj?.codebase_path)) {
    throw new Error('Missing required parameter for code mode: codebase_path');
  }

  const codebasePath = argumentsObj.codebase_path.trim();
  const provider = normalizeCodeProvider(argumentsObj);

  if (provider === 'gemini_apigee') {
    if (!hasText(process.env.GEMINI_ENDPOINT)) {
      throw new Error('Missing GEMINI_ENDPOINT environment variable for code_provider=gemini_apigee');
    }

    const token = await getApigeeToken();
    return {
      analysisType,
      provider,
      args: [codebasePath, process.env.GEMINI_ENDPOINT, token, userStory],
      metadata: {
        endpoint: process.env.GEMINI_ENDPOINT
      }
    };
  }

  if (provider === 'anthropic') {
    if (!hasText(argumentsObj?.api_key)) {
      throw new Error('Missing required parameter for code_provider=anthropic: api_key');
    }

    return {
      analysisType,
      provider,
      args: [codebasePath, argumentsObj.api_key.trim(), userStory],
      metadata: {}
    };
  }

  if (provider === 'ollama') {
    if (!hasText(argumentsObj?.ollama_base_url)) {
      throw new Error('Missing required parameter for code_provider=ollama: ollama_base_url');
    }

    const model = hasText(argumentsObj?.ollama_model)
      ? argumentsObj.ollama_model.trim()
      : 'llama3';

    return {
      analysisType,
      provider,
      args: [codebasePath, argumentsObj.ollama_base_url.trim(), model, userStory],
      metadata: {
        ollamaModel: model
      }
    };
  }

  if (provider === 'generic') {
    if (!hasText(argumentsObj?.endpoint_url)) {
      throw new Error('Missing required parameter for code_provider=generic: endpoint_url');
    }

    const args = [codebasePath, argumentsObj.endpoint_url.trim()];
    if (hasText(argumentsObj?.token)) {
      args.push(argumentsObj.token.trim());
    }
    args.push(userStory);

    return {
      analysisType,
      provider,
      args,
      metadata: {
        endpoint: argumentsObj.endpoint_url.trim(),
        hasToken: hasText(argumentsObj?.token)
      }
    };
  }

  throw new Error(`Unsupported code_provider: ${provider}. Expected one of gemini_apigee, anthropic, ollama, generic`);
}
 
// Execute deep_rl_agent binary as subprocess (mode-aware)
async function executeDeepRLAgent(args, debugInfo = {}) {
  return new Promise((resolve, reject) => {
    console.error('Executing deep_rl_agent with mode:', debugInfo);
    
    const proc = spawn(DEEP_RL_AGENT_BINARY, args);
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (error) => {
      reject(new Error(`Failed to spawn deep_rl_agent: ${error.message}`));
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`deep_rl_agent exited with code ${code}\nStderr: ${stderr}`));
      } else {
        // Parse the structured output (four sections as documented)
        const result = parseDeepRLOutput(stdout);
        resolve(result);
      }
    });
    
    // Timeout after 5 minutes
    setTimeout(() => {
      proc.kill();
      reject(new Error('deep_rl_agent execution timeout (5 minutes)'));
    }, 300000);
  });
}

// Parse deep_rl_agent output sections (supports both story-only and code modes)
function parseDeepRLOutput(output) {
  const sections = {
    mode: 'unknown',
    analysisInfo: '',
    generatedPrompt: '',
    generatedCode: '',
    userStoryAnalysis: '',
    codeAnalysis: '',
    storyOnlyAnalysis: '',
    rawOutput: output
  };

  const storyOnlyHeader = '=== User Story Analysis (Story-Only Mode) ===';
  if (output.includes(storyOnlyHeader)) {
    sections.mode = 'user_story';
    const storyOnlyMatch = output.match(/=== User Story Analysis \(Story-Only Mode\) ===[\s\S]*?\n([\s\S]*)$/);
    if (storyOnlyMatch) {
      sections.storyOnlyAnalysis = storyOnlyMatch[1].trim();
    }
    return sections;
  }
  
  sections.mode = 'code';
  
  // Extract analysis info (first line)
  const analysisMatch = output.match(/Analysed (\d+) files\. Pattern: (\S+)/);
  if (analysisMatch) {
    sections.analysisInfo = `Files: ${analysisMatch[1]}, Pattern: ${analysisMatch[2]}`;
  }
  
  // Extract Generated Prompt section
  const promptMatch = output.match(/=== Generated Prompt ===[\s\S]*?\n([\s\S]*?)(?:===|Calling |$)/);
  if (promptMatch) {
    sections.generatedPrompt = promptMatch[1].trim();
  }
  
  // Extract Generated Code section
  const codeMatch = output.match(/=== Generated Code ===[\s\S]*?\n([\s\S]*?)(?:=== User Story Analysis ===|$)/);
  if (codeMatch) {
    sections.generatedCode = codeMatch[1].trim();
  }
  
  // Extract User Story Analysis section
  const storyMatch = output.match(/=== User Story Analysis ===[\s\S]*?\n([\s\S]*?)(?:=== Code Analysis ===|$)/);
  if (storyMatch) {
    sections.userStoryAnalysis = storyMatch[1].trim();
  }
  
  // Extract Code Analysis section
  const analysisEndMatch = output.match(/=== Code Analysis ===[\s\S]*?\n([\s\S]*)$/);
  if (analysisEndMatch) {
    sections.codeAnalysis = analysisEndMatch[1].trim();
  }
  
  return sections;
}

function formatDeepRLOutput(result, executionContext = {}) {
  if (result.mode === 'user_story') {
    return [
      '=== Deep RL User Story Analysis ===',
      '',
      `Mode: user_story`,
      executionContext.hasRequirementContext ? 'Requirement context: provided' : 'Requirement context: not provided',
      '',
      '--- Story Analysis ---',
      result.storyOnlyAnalysis || '(no story analysis)'
    ].join('\n');
  }

  return [
    '=== Deep RL Multi-Agent Analysis ===',
    '',
    `Mode: code (${executionContext.provider || 'unknown'})`,
    `Analysis: ${result.analysisInfo || '(not available)'}`,
    '',
    '--- Generated Prompt ---',
    result.generatedPrompt || '(no prompt generated)',
    '',
    '--- Generated Code ---',
    result.generatedCode || '(no code generated)',
    '',
    '--- User Story Analysis ---',
    result.userStoryAnalysis || '(no story analysis)',
    '',
    '--- Code Analysis ---',
    result.codeAnalysis || '(no code analysis)'
  ].join('\n');
}

function getDeepRLToolSchema() {
  return {
    type: 'object',
    properties: {
      analysis_type: {
        type: 'string',
        enum: ['user_story', 'code'],
        description: 'Analysis mode: user_story (story-only analysis) or code (codebase analysis + generation). Defaults to code when codebase_path is provided; otherwise user_story.'
      },
      user_story: {
        type: 'string',
        description: 'User story text to analyze or generate code from.'
      },
      requirement_context: {
        type: 'string',
        description: 'Optional original requirement text for story-only alignment scoring (user_story mode only).'
      },
      codebase_path: {
        type: 'string',
        description: 'Absolute path to the codebase to analyze (required for code mode).'
      },
      code_provider: {
        type: 'string',
        enum: ['gemini_apigee', 'anthropic', 'ollama', 'generic'],
        description: 'LLM provider for code mode. gemini_apigee uses GEMINI_ENDPOINT + Apigee token; anthropic uses api_key; ollama uses ollama_base_url + optional ollama_model; generic uses endpoint_url + optional token.'
      },
      api_key: {
        type: 'string',
        description: 'API key for code_provider=anthropic.'
      },
      ollama_base_url: {
        type: 'string',
        description: 'Ollama base URL with no path (e.g. http://localhost:11434) for code_provider=ollama.'
      },
      ollama_model: {
        type: 'string',
        description: 'Ollama model name for code_provider=ollama. Defaults to llama3.'
      },
      endpoint_url: {
        type: 'string',
        description: 'Generic endpoint URL with path (e.g. https://.../chat/completions) for code_provider=generic.'
      },
      token: {
        type: 'string',
        description: 'Optional token for code_provider=generic.'
      }
    },
    required: ['user_story']
  };
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: 'ask_gemini',
      description: 'Send a prompt to Gemini AI through Apigee authentication',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt to send to Gemini'
          }
        },
        required: ['prompt']
      }
    }
  ];
  
  // Add deep_rl_agent tool if binary is available (multi-agent architecture)
  if (deepRLAgentAvailable) {
    const deepRLSchema = getDeepRLToolSchema();

    tools.push({
      name: 'deep_rl_agent',
      description: 'Deep RL analyzer with two modes: user_story (story-only quality/alignment analysis) and code (codebase analysis + prompt/code generation).',
      inputSchema: deepRLSchema
    });

    tools.push({
      name: 'deep_rl_code_agent',
      description: 'Backward-compatible alias for deep_rl_agent. Supports both user_story and code modes via analysis_type and provider parameters.',
      inputSchema: deepRLSchema
    });
  }

  // RAG tools (semantic codebase search via Ollama + ChromaDB)
  if (ragAvailable) {
    tools.push({
      name: 'search_code',
      description:
        'Semantic search over the indexed codebase. Returns the top matching code ' +
        'chunks with file path and line range. Use this to locate relevant code ' +
        'instead of reading or grepping whole files.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language or code description of what to find.'
          },
          k: {
            type: 'integer',
            minimum: 1,
            maximum: 30,
            description: `Number of chunks to return (default ${ragConfig.defaultTopK}).`
          }
        },
        required: ['query']
      }
    });

    tools.push({
      name: 'get_context',
      description:
        'Returns the most relevant code for a task, packed to stay under a token ' +
        'budget. This is the preferred way to gather grounding context before ' +
        'answering or editing, because it minimizes tokens sent to the model.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you are about to work on.'
          },
          token_budget: {
            type: 'integer',
            minimum: 200,
            maximum: 16000,
            description: `Hard ceiling on returned tokens (default ${ragConfig.defaultTokenBudget}).`
          }
        },
        required: ['query']
      }
    });

    tools.push({
      name: 'list_indexed_files',
      description: 'Summarises what is currently indexed: distinct files and total chunk count.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    });

    tools.push({
      name: 'reindex',
      description:
        'Incrementally re-embed changed files into the vector store. Pass force=true ' +
        'to rebuild everything (e.g. after changing the embedding model).',
      inputSchema: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Rebuild the entire index from scratch.'
          }
        }
      }
    });
  }
  
  return { tools };
});
 
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'ask_gemini') {
    try {
      const { prompt } = request.params.arguments;
      const response = await callGemini(prompt);
      
      return {
        content: [
          {
            type: 'text',
            text: response
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
  
  // Multi-agent deep RL analyzer/generator (follows mode-aware deep_rl_agent interface)
  if (request.params.name === 'deep_rl_agent' || request.params.name === 'deep_rl_code_agent') {
    if (!deepRLAgentAvailable) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Deep RL Agent binary not found at ${DEEP_RL_AGENT_BINARY}.\nBuild it with: cd deep-rl-cpp-master/build && cmake .. && make`
          }
        ],
        isError: true
      };
    }
    
    try {
      const argsInput = request.params.arguments || {};
      const executionRequest = await buildDeepRLArgs(argsInput);

      const result = await executeDeepRLAgent(executionRequest.args, {
        analysisType: executionRequest.analysisType,
        provider: executionRequest.provider
      });

      const output = formatDeepRLOutput(result, {
        provider: executionRequest.provider,
        hasRequirementContext: executionRequest.metadata?.hasRequirementContext
      });
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
 
  // --- RAG tool handlers ---
  if (request.params.name === 'search_code') {
    if (!ragAvailable) {
      return { content: [{ type: 'text', text: 'Error: RAG tools are disabled. Set OLLAMA_BASE_URL and CHROMA_URL.' }], isError: true };
    }
    try {
      const { query, k } = request.params.arguments;
      const limit = k ?? ragConfig.defaultTopK;
      const vector = await embedOne(query);
      const hits = await ragStore.search(vector, limit);
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: 'No matches. The index may be empty — run reindex.' }] };
      }
      const body = hits.map(renderHit).join('\n\n');
      return { content: [{ type: 'text', text: body }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (request.params.name === 'get_context') {
    if (!ragAvailable) {
      return { content: [{ type: 'text', text: 'Error: RAG tools are disabled. Set OLLAMA_BASE_URL and CHROMA_URL.' }], isError: true };
    }
    try {
      const { query, token_budget } = request.params.arguments;
      const budget = token_budget ?? ragConfig.defaultTokenBudget;
      const vector = await embedOne(query);
      const raw = await ragStore.search(vector, Math.max(ragConfig.defaultTopK * 3, 18));
      const hits = dedupeHits(raw);

      const blocks = [];
      let used = 0;
      for (const h of hits) {
        const block = renderHit(h);
        const cost = approxTokens(block);
        if (used + cost > budget) continue;
        blocks.push(block);
        used += cost;
      }

      if (blocks.length === 0) {
        return { content: [{ type: 'text', text: 'No context fit the budget. Raise token_budget or run reindex.' }] };
      }

      const text = `Context for: ${query}\n(${blocks.length} chunks, ~${used} tokens, budget ${budget})\n\n` + blocks.join('\n\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (request.params.name === 'list_indexed_files') {
    if (!ragAvailable) {
      return { content: [{ type: 'text', text: 'Error: RAG tools are disabled. Set OLLAMA_BASE_URL and CHROMA_URL.' }], isError: true };
    }
    try {
      const { files, chunkCount } = await ragStore.stats();
      const preview = files.slice(0, 200).join('\n');
      const more = files.length > 200 ? `\n...and ${files.length - 200} more` : '';
      return { content: [{ type: 'text', text: `${files.length} files, ${chunkCount} chunks indexed.\n\n${preview}${more}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (request.params.name === 'reindex') {
    if (!ragAvailable) {
      return { content: [{ type: 'text', text: 'Error: RAG tools are disabled. Set OLLAMA_BASE_URL and CHROMA_URL.' }], isError: true };
    }
    try {
      const force = request.params.arguments?.force ?? false;
      const r = await indexRepo(force);
      return { content: [{ type: 'text', text: `Reindex complete. embedded=${r.indexedFiles} unchanged=${r.skippedFiles} removed=${r.removedFiles} chunks=${r.totalChunks}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});
 
// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gemini-Apigee MCP server running');
}
 
main().catch(console.error);