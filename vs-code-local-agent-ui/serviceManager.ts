import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface ServiceDefinition {
  id: string;
  name: string;
  description: string;
  /** Shell command to start the service */
  command: string;
  /** Working directory relative to deployment package root */
  cwd: string;
  /** Whether the service runs until stopped (true) or exits on its own (false) */
  longRunning: boolean;
  /** Icon for the UI (emoji or codicon) */
  icon: string;
  /** Category for UI grouping */
  category: 'core' | 'rag' | 'analysis' | 'utility';
  /** Environment variables to pass to the service process */
  env?: Record<string, string>;
  /** Environment variables hint (not secrets — just names) */
  envHint?: string[];
  /** Prerequisites description */
  prerequisites?: string;
}

export interface ServiceState {
  definition: ServiceDefinition;
  status: ServiceStatus;
  terminal: vscode.Terminal | undefined;
  startedAt: number | undefined;
  error: string | undefined;
}

// ── Service registry ───────────────────────────────────────────────────────────

function buildServiceDefinitions(): ServiceDefinition[] {
  return [
    {
      id: 'mcp-server',
      name: 'MCP Server',
      description: 'Gemini-Apigee MCP server with RAG tools and Deep RL agent',
      command: 'node mcp-server.js',
      cwd: '.',
      longRunning: true,
      icon: '🔌',
      category: 'core',
      envHint: ['APIGEE_ENDPOINT', 'APIGEE_KEY', 'GEMINI_ENDPOINT', 'OLLAMA_BASE_URL', 'CHROMA_URL'],
      prerequisites: 'Node.js 18+, npm install',
    },
    {
      id: 'ollama',
      name: 'Ollama',
      description: 'Local LLM and embedding model server',
      command: 'ollama serve',
      cwd: '.',
      longRunning: true,
      icon: '🦙',
      category: 'rag',
      prerequisites: 'Ollama installed (https://ollama.com)',
    },
    {
      id: 'chromadb',
      name: 'ChromaDB',
      description: 'Local vector store for RAG embeddings',
      command: 'chroma run --path ./chroma_data --port 8000',
      cwd: '.',
      longRunning: true,
      icon: '🗄️',
      category: 'rag',
      prerequisites: 'pip install chromadb',
    },
    {
      id: 'rag-indexer',
      name: 'RAG Indexer',
      description: 'Index repository for semantic code search',
      command: 'npm run index',
      cwd: 'vs-code-local-rag/copilot-rag-mcp',
      longRunning: false,
      icon: '📇',
      category: 'rag',
      env: {
        REPO_ROOT: '{{ROOT}}',
        OLLAMA_BASE_URL: 'http://localhost:11434',
        EMBED_MODEL: 'nomic-embed-text',
        CHROMA_URL: 'http://localhost:8000',
        COLLECTION: 'codebase',
      },
      prerequisites: 'Ollama + ChromaDB running, npm install',
    },
    {
      id: 'reverse-engineer',
      name: 'Reverse Engineering Agent',
      description: 'Analyze a project into a knowledge graph',
      command: 'python agent.py --root . --output ./kg_output --format all',
      cwd: 'reverse_engineering',
      longRunning: false,
      icon: '🔍',
      category: 'analysis',
      prerequisites: 'Python 3.10+, pip install -r requirements.txt',
    },
    {
      id: 'graph-visualizer',
      name: 'Knowledge Graph Visualizer',
      description: 'Flask web server for interactive graph exploration',
      command: 'python visualizer.py --graph ./kg_output/knowledge_graph.json --port 5000',
      cwd: 'reverse_engineering',
      longRunning: true,
      icon: '🕸️',
      category: 'analysis',
      prerequisites: 'Python 3.10+, Flask, graph output generated',
    },
    {
      id: 'graph-query',
      name: 'Knowledge Graph REPL',
      description: 'Interactive query console for the knowledge graph',
      command: 'python query_graph.py --graph ./kg_output/knowledge_graph.json',
      cwd: 'reverse_engineering',
      longRunning: true,
      icon: '💬',
      category: 'analysis',
      prerequisites: 'Python 3.10+, graph output generated',
    },
    {
      id: 'deep-rl-build',
      name: 'Build Deep RL Agent',
      description: 'Compile the C++ Deep RL code generation agent',
      command: process.platform === 'win32'
        ? 'cmake --build . --config Release'
        : 'cmake .. -DCMAKE_BUILD_TYPE=Release && make -j4',
      cwd: 'deep-rl-cpp-master/build',
      longRunning: false,
      icon: '🔨',
      category: 'core',
      prerequisites: 'C++17 compiler, CMake 3.16+',
    },
    {
      id: 'transcribe',
      name: 'MP4 Transcription',
      description: 'Transcribe video/audio files using Whisper',
      command: 'python transcribe_mp4.py --input "${input}"',
      cwd: '.',
      longRunning: false,
      icon: '🎙️',
      category: 'utility',
      envHint: [],
      prerequisites: 'Python 3.10+, openai-whisper, FFmpeg',
    },
  ];
}

// ── Service Manager ────────────────────────────────────────────────────────────

export class ServiceManager {
  private static _instance: ServiceManager | undefined;
  private _services: Map<string, ServiceState> = new Map();
  private _onDidChangeStatus = new vscode.EventEmitter<ServiceState>();
  public readonly onDidChangeStatus = this._onDidChangeStatus.event;
  private _deployRoot: string | undefined;

  private constructor() {
    this._deployRoot = this._findDeployRoot();
    for (const def of buildServiceDefinitions()) {
      this._services.set(def.id, {
        definition: def,
        status: 'stopped',
        terminal: undefined,
        startedAt: undefined,
        error: undefined,
      });
    }
  }

  public static getInstance(): ServiceManager {
    if (!ServiceManager._instance) {
      ServiceManager._instance = new ServiceManager();
    }
    return ServiceManager._instance;
  }

  private _findDeployRoot(): string | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (fs.existsSync(path.join(root, 'mcp-server.js'))) {
        return root;
      }
    }
    return undefined;
  }

  public getServices(): ServiceState[] {
    return Array.from(this._services.values());
  }

  public getService(id: string): ServiceState | undefined {
    return this._services.get(id);
  }

  public getServicesByCategory(category: ServiceDefinition['category']): ServiceState[] {
    return this.getServices().filter(s => s.definition.category === category);
  }

  /**
   * Start a service. For services needing user input (e.g. file path for
   * transcription), pass overrideCommand with substitutions applied.
   */
  public async startService(id: string, overrideCommand?: string): Promise<void> {
    const state = this._services.get(id);
    if (!state) {
      throw new Error(`Unknown service: ${id}`);
    }

    if (state.status === 'running' || state.status === 'starting') {
      vscode.window.showWarningMessage(`${state.definition.name} is already ${state.status}.`);
      return;
    }

    const root = this._deployRoot;
    if (!root) {
      vscode.window.showErrorMessage('Deployment package root not found. Open the agents-deployment-package workspace.');
      return;
    }

    const cwd = path.resolve(root, state.definition.cwd);
    if (!fs.existsSync(cwd)) {
      vscode.window.showErrorMessage(`Working directory not found: ${cwd}`);
      return;
    }

    const command = overrideCommand ?? state.definition.command;

    // Update state
    state.status = 'starting';
    state.error = undefined;
    state.startedAt = Date.now();
    this._fireChange(state);

    // Create a dedicated terminal
    const terminalName = `[Agent Studio] ${state.definition.name}`;

    // Dispose old terminal if it exists
    if (state.terminal) {
      try { state.terminal.dispose(); } catch { /* ignore */ }
    }

    // Resolve env vars — replace {{ROOT}} with deployment root
    const terminalEnv: Record<string, string> = {};
    if (state.definition.env) {
      for (const [k, v] of Object.entries(state.definition.env)) {
        terminalEnv[k] = v.replace('{{ROOT}}', root);
      }
    }

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd,
      env: Object.keys(terminalEnv).length > 0 ? terminalEnv : undefined,
      iconPath: new vscode.ThemeIcon(
        state.definition.longRunning ? 'server-process' : 'terminal'
      ),
    });
    state.terminal = terminal;

    terminal.sendText(command);
    terminal.show(/* preserveFocus */ true);

    // Track terminal close
    const closeListener = vscode.window.onDidCloseTerminal(t => {
      if (t === terminal) {
        closeListener.dispose();
        if (state.terminal === terminal) {
          state.terminal = undefined;
          state.status = 'stopped';
          this._fireChange(state);
        }
      }
    });

    // For long-running services, mark as running after a brief delay.
    // For one-shot tasks, mark running immediately (terminal close will set stopped).
    if (state.definition.longRunning) {
      setTimeout(() => {
        if (state.status === 'starting' && state.terminal === terminal) {
          state.status = 'running';
          this._fireChange(state);
        }
      }, 2000);
    } else {
      state.status = 'running';
      this._fireChange(state);
    }
  }

  public async stopService(id: string): Promise<void> {
    const state = this._services.get(id);
    if (!state) {
      throw new Error(`Unknown service: ${id}`);
    }

    if (state.terminal) {
      state.terminal.dispose();
      state.terminal = undefined;
    }
    state.status = 'stopped';
    state.startedAt = undefined;
    this._fireChange(state);
  }

  public async restartService(id: string): Promise<void> {
    await this.stopService(id);
    // Brief pause so terminal closes cleanly
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.startService(id);
  }

  /**
   * Serialize current service states for the webview.
   */
  public toWebviewPayload(): Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    status: ServiceStatus;
    longRunning: boolean;
    prerequisites?: string;
    startedAt?: number;
    error?: string;
  }> {
    return this.getServices().map(s => ({
      id: s.definition.id,
      name: s.definition.name,
      description: s.definition.description,
      icon: s.definition.icon,
      category: s.definition.category,
      status: s.status,
      longRunning: s.definition.longRunning,
      prerequisites: s.definition.prerequisites,
      startedAt: s.startedAt,
      error: s.error,
    }));
  }

  private _fireChange(state: ServiceState): void {
    this._onDidChangeStatus.fire(state);
  }

  public dispose(): void {
    for (const state of this._services.values()) {
      if (state.terminal) {
        try { state.terminal.dispose(); } catch { /* ignore */ }
      }
    }
    this._onDidChangeStatus.dispose();
  }
}
