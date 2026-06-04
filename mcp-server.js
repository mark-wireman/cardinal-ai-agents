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
 
  throw new Error(`Unknown tool: ${request.params.name}`);
});
 
// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gemini-Apigee MCP server running');
}
 
main().catch(console.error);