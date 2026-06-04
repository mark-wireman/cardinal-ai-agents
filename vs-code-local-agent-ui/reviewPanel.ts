import * as vscode from 'vscode';
import * as mammoth from 'mammoth';
import { getActiveAgent, setActiveAgent } from './extension';
import { discoverAgents, type AgentDefinition } from './agentLoader';

type ActivityKind = 'info' | 'progress' | 'warn' | 'error' | 'done';
type ActivityGroup = 'model' | 'prompt' | 'streaming' | 'finalize';

interface UsageEstimate {
  promptChars: number;
  outputChars: number;
  promptTokensEstimate: number;
  outputTokensEstimate: number;
  totalTokensEstimate: number;
  inputCostUsdEstimate: number;
  outputCostUsdEstimate: number;
  totalCostUsdEstimate: number;
}

const ESTIMATED_INPUT_USD_PER_1K_TOKENS = 0.005;
const ESTIMATED_OUTPUT_USD_PER_1K_TOKENS = 0.015;

export class ReviewPanel {
  public static currentPanel: ReviewPanel | undefined;
  private static readonly viewType = 'copilotReviewPanel';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _runTokenSource: vscode.CancellationTokenSource | undefined;
  private _runCounter = 0;
  private _availableModels: Array<{ id: string; vendor: string; family: string; name: string }> = [];
  private _selectedModelId: string | undefined;
  private static _output: vscode.OutputChannel | undefined;
  private _lastWebviewErrorAt = 0;
  private _lastWebviewErrorText = '';

  // ── Factory ────────────────────────────────────────────────────────────────
  public static createOrShow(extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
    // If a panel already exists, reveal it WITHOUT recreating. This preserves
    // the user's prompt text, output, timeline, and selected model across
    // focus changes and tab switches.
    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside, /* preserveFocus */ true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      ReviewPanel.viewType,
      'Local Agent Studio',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Keep webview alive when hidden so switching tabs doesn't wipe state.
        retainContextWhenHidden: true,
      }
    );

    ReviewPanel.currentPanel = new ReviewPanel(panel, extensionUri, context);
  }

  /** Force a full rebuild of the panel HTML. Only call from explicit user actions. */
  public static forceRefresh(extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
    if (ReviewPanel.currentPanel) {
      ReviewPanel.currentPanel.dispose();
      ReviewPanel.currentPanel = undefined;
    }
    ReviewPanel.createOrShow(extensionUri, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context?: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._context = context;
    this._selectedModelId = context?.globalState.get<string>('copilotReviewer.selectedModelId');

    // Render with current agents
    const agents = this._getPanelAgents(discoverAgents());
    this._panel.webview.html = this._buildHtml(agents, getActiveAgent());

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        agentPath?: string;
        prompt?: string;
        includeCode?: boolean;
        markdown?: string;
        format?: 'markdown' | 'json';
        reportContent?: string;
        text?: string;
      }) => {
        try {
          switch (msg.command) {
          case 'selectAgent': {
            // User picks from the panel selector (workspace/deployed agents)
            const agents = this._getPanelAgents(discoverAgents());
            const chosen = agents.find(a => a.filePath === msg.agentPath);
            if (chosen) {
              setActiveAgent(chosen);
              this._panel.webview.postMessage({
                command: 'agentChanged',
                name: chosen.name,
                description: chosen.description,
                filePath: chosen.filePath,
              });
            }
            break;
          }
          case 'openAgentPicker':
            // Delegate to the full QuickPick command
            await vscode.commands.executeCommand('copilot-reviewer.selectAgent');
            break;
          case 'copyToClipboard':
            await vscode.env.clipboard.writeText(msg.markdown ?? '');
            vscode.window.showInformationMessage('Copied to clipboard!');
            break;
          case 'openChat':
            await vscode.commands.executeCommand('workbench.action.chat.open');
            break;
          case 'openAgentFile':
            if (msg.agentPath) {
              const uri = vscode.Uri.file(msg.agentPath);
              await vscode.window.showTextDocument(uri);
            }
            break;
          case 'reviewActiveEditor':
            await this._reviewActiveEditor();
            break;
          case 'submitPrompt': {
            const prompt = (msg.prompt ?? '').trim();
            if (!prompt) {
              this._panel.webview.postMessage({
                command: 'error',
                text: 'Please enter a prompt before sending.',
              });
              break;
            }

            this._panel.webview.postMessage({
              command: 'info',
              text: 'Prompt submitted. Preparing request...',
            });
            await this._runPrompt(prompt, msg.includeCode ?? true);
            break;
          }
          case 'cancelRun':
            this._runTokenSource?.cancel();
            break;
          case 'exportReport':
            if (msg.format && msg.reportContent) {
              await this._exportRunReport(msg.format, msg.reportContent);
            }
            break;
          case 'webviewReady':
            vscode.window.showInformationMessage('[Local Agent Studio] Webview ready.');
            this._panel.webview.postMessage({
              command: 'info',
              text: 'Webview ready. Controls initialized.',
            });
            // Discover and push available models once the webview is alive.
            this._refreshAvailableModels();
            break;
          case 'selectModel':
            this._selectedModelId = msg.text || undefined;
            await this._context?.globalState.update('copilotReviewer.selectedModelId', this._selectedModelId);
            this._panel.webview.postMessage({
              command: 'info',
              text: `Model preference set: ${this._selectedModelId ?? 'auto'}`,
            });
            break;
          case 'refreshModels':
            await this._refreshAvailableModels();
            break;
          case 'webviewBoot':
            vscode.window.showInformationMessage('[Local Agent Studio] Webview boot script executed.');
            break;
          case 'webviewError': {
            const text = String(msg.text ?? 'unknown');
            if (!ReviewPanel._output) {
              ReviewPanel._output = vscode.window.createOutputChannel('Local Agent Studio');
            }
            ReviewPanel._output.appendLine(`[${new Date().toISOString()}] webview error:\n${text}\n${'-'.repeat(60)}`);
            // Surface only once per unique message every 5s to avoid notification spam.
            const now = Date.now();
            const firstLine = text.split('\n', 1)[0];
            if (firstLine !== this._lastWebviewErrorText || now - this._lastWebviewErrorAt > 5000) {
              this._lastWebviewErrorText = firstLine;
              this._lastWebviewErrorAt = now;
              vscode.window.showErrorMessage(
                `[Local Agent Studio] Webview error: ${firstLine}`,
                'Show Details'
              ).then(sel => { if (sel === 'Show Details') { ReviewPanel._output?.show(true); } });
            }
            break;
          }
          case 'clientEvent':
            if (msg.text) {
              this._panel.webview.postMessage({
                command: 'info',
                text: `[ui] ${msg.text}`,
              });
            }
            break;
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this._panel.webview.postMessage({
            command: 'error',
            text: `Unhandled panel error: ${text}`,
          });
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Public: called by extension when agent changes ─────────────────────────
  public refreshAgent(agent: AgentDefinition): void {
    this._panel.webview.postMessage({
      command: 'agentChanged',
      name: agent.name,
      description: agent.description,
      filePath: agent.filePath,
      scope: agent.scope,
    });
  }

  public refreshAgentList(agents: AgentDefinition[]): void {
    const panelAgents = this._getPanelAgents(agents);
    this._panel.webview.postMessage({
      command: 'agentListUpdated',
      agents: panelAgents.map(a => ({
        name: a.name,
        description: a.description,
        scope: a.scope,
        filePath: a.filePath,
        isActive: a.filePath === getActiveAgent()?.filePath,
      })),
    });
  }

  // ── Public: run a live review ──────────────────────────────────────────────
  public async startReview(
    code: string,
    lang: string,
    fileName: string,
    _context: vscode.ExtensionContext
  ) {
    const reviewPrompt = [
      `Review this ${lang} code from "${fileName}" with detailed, actionable feedback.`,
      'Use sections in this exact order:',
      '1) Bugs & Risks',
      '2) Code Quality',
      '3) Performance',
      '4) Positive Notes',
      '5) Top Recommendations',
      '',
      `\`\`\`${lang}`,
      code,
      '\`\`\`',
    ].join('\n');

    await this._executeAgentTask({
      userPrompt: reviewPrompt,
      title: `Reviewing ${fileName}`,
      actionLabel: 'Running agent',
      includeCodeContext: false,
    });
  }

  private async _reviewActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._panel.webview.postMessage({
        command: 'error',
        text: 'Open an editor first, then run review.',
      });
      return;
    }

    const selection = editor.selection;
    const code = selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(selection);
    const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? 'active-file';
    await this.startReview(code, editor.document.languageId, fileName, {} as vscode.ExtensionContext);
  }

  private _detectDocxPaths(text: string): string[] {
    const docxPathRegex = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*\.docx\b/gi;
    const matches = text.match(docxPathRegex) ?? [];
    return Array.from(new Set(matches));
  }

  /**
   * Detect text-like file paths the agent should ingest. Supports paths with
   * spaces (Windows OneDrive folders) by terminating on a recognized extension.
   * Returns paths ordered by length descending so longer matches replace first
   * (avoiding partial-substring replacement collisions).
   */
  private _detectIngestablePaths(text: string): { path: string; ext: string }[] {
    // Quoted paths: "C:\foo bar\file.txt" or 'C:\foo\file.md'
    const results = new Map<string, string>();
    const quoted = /["']([A-Za-z]:\\[^"'\r\n]+?\.(txt|md|csv|json|log|xml|html|yaml|yml))["']/gi;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(text)) !== null) {
      results.set(m[1], m[2].toLowerCase());
    }
    // Bare paths terminating in a recognized extension. Include spaces, dashes,
    // parentheses, etc. Stop at a newline or a quote.
    const bare = /([A-Za-z]:\\[^\r\n"'<>|*?]+?\.(txt|md|csv|json|log|xml|html|yaml|yml))(?=\s|$|[.,;)])/gi;
    while ((m = bare.exec(text)) !== null) {
      results.set(m[1], m[2].toLowerCase());
    }
    return Array.from(results.entries())
      .map(([path, ext]) => ({ path, ext }))
      .sort((a, b) => b.path.length - a.path.length);
  }

  private async _ingestTextFile(filePath: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(filePath);
      const fileData = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(fileData).toString('utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._panel.webview.postMessage({
        command: 'error',
        text: `Failed to read text file "${filePath}": ${msg}`,
      });
      return null;
    }
  }

  private async _ingestDocxFile(filePath: string): Promise<string | null> {
    try {
      const uri = vscode.Uri.file(filePath);
      const fileData = await vscode.workspace.fs.readFile(uri);
      const result = await mammoth.extractRawText({ buffer: Buffer.from(fileData) });
      return result.value || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._panel.webview.postMessage({
        command: 'error',
        text: `Failed to read .docx file "${filePath}": ${msg}`,
      });
      return null;
    }
  }

  private async _ingestAllDocxReferences(prompt: string): Promise<string> {
    const docxPaths = this._detectDocxPaths(prompt);
    if (docxPaths.length === 0) {
      return prompt;
    }

    this._panel.webview.postMessage({
      command: 'info',
      text: `Ingesting ${docxPaths.length} .docx file(s)...`,
    });

    let enhancedPrompt = prompt;
    let extractedCount = 0;
    for (const filePath of docxPaths) {
      const text = await this._ingestDocxFile(filePath);
      if (text) {
        extractedCount += 1;
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        this._panel.webview.postMessage({
          command: 'info',
          text: `✓ Extracted ${text.length} characters from ${fileName}`,
        });
        enhancedPrompt = enhancedPrompt.replace(filePath, `[Content from ${fileName}]:\n\n${text}`);
      } else {
        enhancedPrompt = enhancedPrompt.replace(
          filePath,
          `[Document read failed for path: ${filePath}]`
        );
      }
    }

    if (extractedCount === 0) {
      this._panel.webview.postMessage({
        command: 'error',
        text: 'No .docx content could be extracted. Check the file path and permissions, then try again.',
      });
    }

    return enhancedPrompt;
  }

  private async _runPrompt(prompt: string, includeCode: boolean): Promise<void> {
    const docxPaths = this._detectDocxPaths(prompt);
    const textPaths = this._detectIngestablePaths(prompt);

    let enhancedPrompt = prompt;
    let ingestedAny = false;

    if (docxPaths.length > 0) {
      this._panel.webview.postMessage({
        command: 'info',
        text: `Detected ${docxPaths.length} .docx file(s). Reading and extracting content...`,
      });
      enhancedPrompt = await this._ingestAllDocxReferences(enhancedPrompt);
      ingestedAny = true;
    }

    if (textPaths.length > 0) {
      this._panel.webview.postMessage({
        command: 'info',
        text: `Detected ${textPaths.length} text file reference(s). Reading content...`,
      });
      for (const { path, ext } of textPaths) {
        const text = await this._ingestTextFile(path);
        if (text) {
          const fileName = path.split(/[\\/]/).pop() ?? path;
          this._panel.webview.postMessage({
            command: 'info',
            text: `✓ Extracted ${text.length} characters from ${fileName}`,
          });
          const block = `\n\n[Content from ${fileName} (${ext})]:\n\n\`\`\`${ext}\n${text}\n\`\`\`\n`;
          // Replace the path occurrence with a marker, then append the content.
          // This avoids inflating the prompt mid-sentence.
          enhancedPrompt = enhancedPrompt.split(path).join(`<file:${fileName}>`) + block;
          ingestedAny = true;
        } else {
          enhancedPrompt = enhancedPrompt.split(path).join(`[Document read failed for path: ${path}]`);
        }
      }
    }

    await this._executeAgentTask({
      userPrompt: enhancedPrompt,
      title: 'Agent conversation',
      actionLabel: ingestedAny ? 'Processing user prompt with document content' : 'Processing user prompt',
      includeCodeContext: includeCode,
    });
  }

  private _getPanelAgents(allAgents: AgentDefinition[]): AgentDefinition[] {
    const workspaceAgents = allAgents.filter(a => a.scope === 'workspace');
    return workspaceAgents.length > 0 ? workspaceAgents : allAgents;
  }

  private async _executeAgentTask(options: {
    userPrompt: string;
    title: string;
    actionLabel: string;
    includeCodeContext: boolean;
  }): Promise<void> {
    this._runTokenSource?.cancel();
    const tokenSource = new vscode.CancellationTokenSource();
    this._runTokenSource = tokenSource;
    const runId = ++this._runCounter;
    const startedAt = Date.now();

    const activeEditor = vscode.window.activeTextEditor;
    const activeAgent = getActiveAgent();
    const editorCode = activeEditor
      ? (activeEditor.selection && !activeEditor.selection.isEmpty
          ? activeEditor.document.getText(activeEditor.selection)
          : activeEditor.document.getText())
      : '';
    const lang = activeEditor?.document.languageId ?? 'text';
    const fileName = activeEditor?.document.fileName.split(/[\\/]/).pop() ?? 'no-file';

    const defaultPrompt = 'You are a senior engineering agent. Be explicit, practical, and detailed about actions, progress, reasoning summary, and final output.';
    const systemPrompt = activeAgent?.systemPrompt ?? defaultPrompt;

    const codeContext = options.includeCodeContext && editorCode
      ? `\n\nContext from ${fileName} (${lang}):\n\`\`\`${lang}\n${editorCode}\n\`\`\``
      : '';
    const composedPrompt = `${options.userPrompt}${codeContext}`;

    const promptChars = systemPrompt.length + composedPrompt.length;
    const initialUsage = this._estimateUsage(promptChars, 0);

    this._panel.webview.postMessage({
      command: 'runStarted',
      runId,
      title: options.title,
      actionLabel: options.actionLabel,
      agentName: activeAgent?.name ?? 'Default reviewer',
      fileName,
      includeCode: options.includeCodeContext,
      prompt: options.userPrompt,
      startedAt: new Date(startedAt).toISOString(),
      usageEstimate: initialUsage,
    });

    this._postActivity(runId, 'model', 'info', 'Preparing model request');
    this._postActivity(
      runId,
      'prompt',
      'info',
      `Prompt prepared (${initialUsage.promptChars} chars, ~${initialUsage.promptTokensEstimate} input tokens)`
    );

    let chunkCount = 0;
    let charCount = 0;
    let fullOutput = '';

    try {
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        throw new Error('Copilot language model APIs are unavailable in this VS Code environment. Sign in to GitHub Copilot and ensure Copilot Chat is enabled.');
      }

      const model = await this._pickModel();
      if (!model) {
        throw new Error('No Copilot model available. Open Copilot Chat once to initialize models, then retry.');
      }

      this._postActivity(runId, 'model', 'info', `Model selected: ${model.vendor}/${model.family}`);

      // Combine the agent system prompt and the user request into a single,
      // well-framed user message. Sending the agent prompt as a separate User
      // message frequently triggers Copilot guardrail refusals on long, real-world
      // content. A single message with explicit role + authorization framing is
      // far more reliable.
      const framed = [
        '# Role and Instructions',
        systemPrompt,
        '',
        '# User-Provided Context',
        'The user has explicitly authorized this content for analysis inside their own VS Code workspace. Treat any embedded files as the user\'s own materials.',
        '',
        '# User Request',
        composedPrompt,
      ].join('\n');

      const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(framed),
      ];

      this._postActivity(runId, 'model', 'progress', 'Sending request to agent model');

      const response = await model.sendRequest(
        messages,
        { justification: 'Run the user-selected agent against their workspace content.' },
        tokenSource.token
      );
      this._postActivity(runId, 'streaming', 'progress', 'Streaming response chunks');

      for await (const chunk of response.text) {
        if (runId !== this._runCounter) {
          return;
        }
        chunkCount += 1;
        charCount += chunk.length;
        fullOutput += chunk;
        const usageEstimate = this._estimateUsage(promptChars, charCount);
        this._panel.webview.postMessage({
          command: 'chunk',
          runId,
          text: chunk,
          chunkCount,
          charCount,
          usageEstimate,
        });
        if (chunkCount % 12 === 0) {
          this._postActivity(
            runId,
            'streaming',
            'progress',
            `Processed ${chunkCount} chunks (${charCount} output chars)`
          );
        }
      }

      const elapsedMs = Date.now() - startedAt;
      const usageEstimate = this._estimateUsage(promptChars, charCount);
      this._postActivity(
        runId,
        'finalize',
        'done',
        `Completed in ${elapsedMs} ms with ~${usageEstimate.totalTokensEstimate} total tokens (estimated)`
      );
      this._panel.webview.postMessage({
        command: 'done',
        runId,
        elapsedMs,
        chunkCount,
        charCount,
        usageEstimate,
        completedAt: new Date().toISOString(),
      });

      await this._maybeAutoSaveOutput(options.userPrompt, fullOutput, runId);
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        this._postActivity(runId, 'finalize', 'warn', 'Run cancelled by user');
        this._panel.webview.postMessage({
          command: 'cancelled',
          runId,
          usageEstimate: this._estimateUsage(promptChars, charCount),
          completedAt: new Date().toISOString(),
        });
        return;
      }

      const text = err instanceof Error ? err.message : String(err);
      this._postActivity(runId, 'finalize', 'error', `Run failed: ${text}`);
      this._panel.webview.postMessage({
        command: 'error',
        runId,
        text,
        usageEstimate: this._estimateUsage(promptChars, charCount),
        completedAt: new Date().toISOString(),
      });
    } finally {
      tokenSource.dispose();
      if (this._runTokenSource === tokenSource) {
        this._runTokenSource = undefined;
      }
    }
  }

  /**
   * Discover all available Copilot chat models and push the list to the webview
   * so the user can choose which one to use.
   */
  private async _refreshAvailableModels(): Promise<void> {
    try {
      if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
        return;
      }
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this._availableModels = models.map(m => ({
        id: m.id,
        vendor: m.vendor,
        family: m.family,
        name: m.name || `${m.vendor}/${m.family}`,
      }));
      this._panel.webview.postMessage({
        command: 'modelsAvailable',
        models: this._availableModels,
        selectedId: this._selectedModelId,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this._panel.webview.postMessage({
        command: 'info',
        text: `Model discovery failed: ${text}`,
      });
    }
  }

  /**
   * Resolve the chat model to use for the next request, honoring the user's
   * selection and falling back to a sensible default.
   */
  private async _pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    if (this._selectedModelId) {
      const byId = await vscode.lm.selectChatModels({ vendor: 'copilot', id: this._selectedModelId });
      if (byId.length > 0) {
        return byId[0];
      }
    }
    const preferred = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (preferred.length > 0) {
      return preferred[0];
    }
    const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return any[0];
  }

  private _postActivity(runId: number, group: ActivityGroup, kind: ActivityKind, text: string): void {
    this._panel.webview.postMessage({
      command: 'activity',
      runId,
      group,
      kind,
      text,
      at: new Date().toISOString(),
    });
  }

  private _estimateTokenCount(chars: number): number {
    return Math.max(1, Math.ceil(chars / 4));
  }

  private _estimateUsage(promptChars: number, outputChars: number): UsageEstimate {
    const promptTokensEstimate = this._estimateTokenCount(promptChars);
    const outputTokensEstimate = outputChars > 0 ? this._estimateTokenCount(outputChars) : 0;
    const inputCostUsdEstimate = (promptTokensEstimate / 1000) * ESTIMATED_INPUT_USD_PER_1K_TOKENS;
    const outputCostUsdEstimate = (outputTokensEstimate / 1000) * ESTIMATED_OUTPUT_USD_PER_1K_TOKENS;
    return {
      promptChars,
      outputChars,
      promptTokensEstimate,
      outputTokensEstimate,
      totalTokensEstimate: promptTokensEstimate + outputTokensEstimate,
      inputCostUsdEstimate,
      outputCostUsdEstimate,
      totalCostUsdEstimate: inputCostUsdEstimate + outputCostUsdEstimate,
    };
  }

  private async _exportRunReport(format: 'markdown' | 'json', reportContent: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = format === 'markdown' ? 'md' : 'json';
    const fileName = `agent-run-report-${timestamp}.${extension}`;
    const defaultUri = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder, fileName)
      : vscode.Uri.joinPath(this._extensionUri, fileName);

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: format === 'markdown'
        ? { Markdown: ['md'] }
        : { JSON: ['json'] },
    });
    if (!saveUri) {
      return;
    }

    await vscode.workspace.fs.writeFile(saveUri, new TextEncoder().encode(reportContent));
    vscode.window.showInformationMessage(`Run report exported: ${saveUri.fsPath}`);
  }

  /**
   * Inspect the user prompt for a "save in/to <folder>" instruction. If found,
   * resolve the folder, derive a sensible filename + extension from the agent
   * output (preferring fenced code blocks), and write the file. Notify the user
   * with an "Open file" action so they can verify the result.
   */
  private async _maybeAutoSaveOutput(userPrompt: string, output: string, runId: number): Promise<void> {
    if (!output.trim()) {
      return;
    }

    if (this._isRefusal(output)) {
      this._postActivity(
        runId,
        'finalize',
        'error',
        'Model returned a safety refusal. Output was NOT saved. Try (a) running the prompt directly in Copilot Chat, (b) trimming or splitting the input file, or (c) rephrasing to remove anything that looks like personal/confidential extraction.'
      );
      vscode.window.showWarningMessage(
        'Agent run was refused by the model. Output was not saved. See the Action Timeline for guidance.'
      );
      return;
    }

    const target = this._parseSaveTarget(userPrompt);
    if (!target) {
      this._postActivity(runId, 'finalize', 'info', 'Auto-save skipped: no save instruction detected in the prompt.');
      return;
    }
    this._postActivity(runId, 'finalize', 'info', `Auto-save target: ${target.folder}${target.fileName ? ' / ' + target.fileName : ''}`);

    try {
      const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const folderUri = this._resolveFolderUri(target.folder, workspaceUri);
      if (!folderUri) {
        this._postActivity(runId, 'finalize', 'warn', `Auto-save skipped: cannot resolve folder "${target.folder}". Open a workspace or use an absolute path.`);
        return;
      }

      // Make sure the folder exists.
      try {
        await vscode.workspace.fs.createDirectory(folderUri);
      } catch {
        // ignore: createDirectory is idempotent for existing folders
      }

      const { content, extension } = this._extractContentForSave(output, userPrompt);
      const baseName = target.fileName || this._deriveBaseName(userPrompt) || `agent-output-${Date.now()}`;
      const finalName = /\.[A-Za-z0-9]{1,8}$/.test(baseName) ? baseName : `${baseName}.${extension}`;
      const fileUri = vscode.Uri.joinPath(folderUri, finalName);

      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

      this._postActivity(runId, 'finalize', 'done', `Saved agent output to ${fileUri.fsPath}`);

      const openLabel = 'Open file';
      const revealLabel = 'Reveal in Explorer';
      const choice = await vscode.window.showInformationMessage(
        `Agent output saved to ${finalName}`,
        openLabel,
        revealLabel
      );
      if (choice === openLabel) {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc);
      } else if (choice === revealLabel) {
        await vscode.commands.executeCommand('revealInExplorer', fileUri);
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this._postActivity(runId, 'finalize', 'error', `Auto-save failed: ${text}`);
      vscode.window.showErrorMessage(`Auto-save failed: ${text}`);
    }
  }

  /**
   * Parse a save instruction from the prompt. Recognizes:
   *   - "save (in|to|under|into) <folder>"            -> explicit folder
   *   - "save (the X) as a CSV/JSON/MD file"          -> implicit folder (workspace root)
   *   - "save as <name>.<ext>"                        -> explicit filename
   *   - bare "save" verb anywhere in the prompt       -> implicit folder
   * Returns undefined only when the prompt has no save intent at all.
   */
  private _parseSaveTarget(prompt: string): { folder: string; fileName?: string } | undefined {
    // Quoted folder
    const quoted = prompt.match(/save\s+(?:the\s+\S+\s+)?(?:in|to|under|into)\s+["']([^"']+)["']/i);
    if (quoted) {
      return { folder: quoted[1].trim() };
    }
    // Absolute Windows or POSIX path
    const absolute = prompt.match(/save\s+(?:the\s+\S+\s+)?(?:in|to|under|into)\s+([A-Za-z]:[\\\/][^\s.,;]+|\/[^\s.,;]+)/i);
    if (absolute) {
      return { folder: absolute[1].trim() };
    }
    // Bare folder phrase: "save in the requirements folder" / "save to requirements"
    const bare = prompt.match(/save\s+(?:the\s+\S+\s+)?(?:in|to|under|into)\s+(?:the\s+)?([A-Za-z0-9_\-./\\]+?)(?:\s+folder|\s+directory)?(?:[.,;]|\s|$)/i);
    if (bare) {
      const folder = bare[1].trim().replace(/[.,;]+$/, '');
      const stop = new Set(['a', 'an', 'the', 'this', 'that', 'it', 'file', 'csv', 'json', 'yaml', 'markdown', 'md', 'text', 'txt']);
      if (folder && !stop.has(folder.toLowerCase())) {
        return { folder };
      }
    }
    // Explicit filename: "save as foo.csv"
    const named = prompt.match(/save\s+(?:it\s+|the\s+\S+\s+)?as\s+([A-Za-z0-9 _.\-]+\.[A-Za-z0-9]{1,8})\b/i);
    if (named) {
      return { folder: '.', fileName: named[1].trim().replace(/\s+/g, '_') };
    }
    // Generic save intent: "save the requirements as a CSV file", "save it",
    // "create ... and save ...". Default to workspace root.
    if (/\bsave\b/i.test(prompt)) {
      return { folder: '.' };
    }
    // Implicit save when the prompt asks to "create a <something> file"
    if (/\b(create|generate|produce|write|output|export)\b[^.\n]{0,80}\b(file|csv|json|yaml|markdown|report|document)\b/i.test(prompt)) {
      return { folder: '.' };
    }
    return undefined;
  }

  private _resolveFolderUri(folder: string, workspaceUri?: vscode.Uri): vscode.Uri | undefined {
    const isAbsolute = /^[A-Za-z]:[\\\/]/.test(folder) || folder.startsWith('/') || folder.startsWith('\\\\');
    if (isAbsolute) {
      return vscode.Uri.file(folder);
    }
    if (!workspaceUri) {
      // No workspace: fall back to extension storage location so we always save somewhere.
      return this._extensionUri;
    }
    const segments = folder === '.' ? [] : folder.split(/[\\\/]+/).filter(Boolean);
    return segments.length === 0 ? workspaceUri : vscode.Uri.joinPath(workspaceUri, ...segments);
  }

  /**
   * If the output contains a single dominant fenced code block, use only that
   * block's contents and infer extension from the language tag. Otherwise save
   * the full output as markdown.
   */
  private _extractContentForSave(output: string, userPrompt = ''): { content: string; extension: string } {
    const fenceRegex = /```([A-Za-z0-9_+-]*)\s*\n([\s\S]*?)```/g;
    const blocks: { lang: string; body: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(output)) !== null) {
      blocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2] });
    }

    if (blocks.length === 1) {
      const { lang, body } = blocks[0];
      return { content: body.trimEnd() + '\n', extension: this._extensionForLang(lang) };
    }

    if (blocks.length > 1) {
      const langs = new Set(blocks.map(b => b.lang));
      if (langs.size === 1 && blocks[0].lang) {
        const joined = blocks.map(b => b.body.trimEnd()).join('\n');
        return { content: joined + '\n', extension: this._extensionForLang(blocks[0].lang) };
      }
    }

    // No usable code fence. Inspect raw output for structured formats.
    const trimmed = output.trim();
    if (this._looksLikeCsv(trimmed)) {
      return { content: trimmed + '\n', extension: 'csv' };
    }
    if (this._looksLikeJson(trimmed)) {
      return { content: trimmed + '\n', extension: 'json' };
    }

    // The model may have wrapped the structured output with commentary. Try to
    // extract a CSV or JSON region from the middle of the response.
    const csvBlock = this._extractCsvBlock(output);
    if (csvBlock) {
      return { content: csvBlock + '\n', extension: 'csv' };
    }
    const jsonBlock = this._extractJsonBlock(output);
    if (jsonBlock) {
      return { content: jsonBlock + '\n', extension: 'json' };
    }

    // Fall back to format hint from the user prompt.
    const hint = this._extensionFromPromptHint(userPrompt);
    return { content: output.trimEnd() + '\n', extension: hint || 'md' };
  }

  /**
   * Find the first CSV-shaped region in mixed text. Looks for a header row
   * (quoted comma-separated tokens) followed by at least one similarly-shaped
   * row, and returns the contiguous CSV region.
   */
  private _extractCsvBlock(text: string): string | undefined {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^"[^"]+"(?:\s*,\s*"[^"]+")+\s*$/.test(line)) {
        // Walk forward collecting CSV-shaped rows. A row is anything that
        // contains a comma and starts with " or a non-space character.
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.trim() === '') {
            // Allow a blank line to terminate the block.
            break;
          }
          if (next.includes(',')) {
            end = j;
          } else {
            break;
          }
        }
        if (end > i) {
          return lines.slice(i, end + 1).join('\n');
        }
      }
    }
    return undefined;
  }

  /** Find the first balanced JSON object/array in mixed text. */
  private _extractJsonBlock(text: string): string | undefined {
    for (const opener of ['{', '[']) {
      const start = text.indexOf(opener);
      if (start < 0) { continue; }
      const closer = opener === '{' ? '}' : ']';
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) { esc = false; }
          else if (c === '\\') { esc = true; }
          else if (c === '"') { inStr = false; }
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === opener) { depth += 1; }
        else if (c === closer) {
          depth -= 1;
          if (depth === 0) {
            const candidate = text.slice(start, i + 1);
            try { JSON.parse(candidate); return candidate; } catch { return undefined; }
          }
        }
      }
    }
    return undefined;
  }

  private _looksLikeCsv(text: string): boolean {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    if (firstLine.length < 3) {
      return false;
    }
    // Header row of quoted, comma-separated tokens, e.g. "REQ_ID","REQ_TYPE",...
    if (/^"[^"]+"(?:\s*,\s*"[^"]+")+\s*$/.test(firstLine)) {
      return true;
    }
    // Or a simple comma-separated header with at least 3 columns of word chars.
    if (/^[\w .\-]+(?:\s*,\s*[\w .\-]+){2,}\s*$/.test(firstLine)) {
      const second = text.split(/\r?\n/)[1] || '';
      if (second.includes(',')) {
        return true;
      }
    }
    return false;
  }

  private _looksLikeJson(text: string): boolean {
    if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) {
      return false;
    }
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }

  private _extensionFromPromptHint(prompt: string): string | undefined {
    const lower = prompt.toLowerCase();
    if (/\bcsv\b/.test(lower)) { return 'csv'; }
    if (/\bjson\b/.test(lower)) { return 'json'; }
    if (/\byaml\b|\byml\b/.test(lower)) { return 'yaml'; }
    if (/\bmarkdown\b|\bmd\b/.test(lower)) { return 'md'; }
    return undefined;
  }

  private _extensionForLang(lang: string): string {
    const map: Record<string, string> = {
      csv: 'csv',
      json: 'json',
      yaml: 'yaml', yml: 'yml',
      md: 'md', markdown: 'md',
      ts: 'ts', typescript: 'ts',
      js: 'js', javascript: 'js',
      py: 'py', python: 'py',
      sql: 'sql',
      sh: 'sh', bash: 'sh',
      ps1: 'ps1', powershell: 'ps1',
      xml: 'xml',
      html: 'html',
      css: 'css',
      txt: 'txt', text: 'txt',
    };
    return map[lang] || (lang ? lang : 'md');
  }

  private _deriveBaseName(prompt: string): string | undefined {
    // Try to grab a source filename from the prompt and reuse its base name.
    const sourceMatch = prompt.match(/([A-Za-z0-9 _.\-]+?)\.(txt|md|docx|pdf|csv|json|html|xml)\b/i);
    if (sourceMatch) {
      return `${sourceMatch[1].trim().replace(/\s+/g, '_')}.requirements`;
    }
    return undefined;
  }

  /**
   * Detect Copilot's safety-guardrail refusal so we don't write nonsense output
   * to disk and so we can give the user actionable guidance.
   */
  private _isRefusal(output: string): boolean {
    const trimmed = output.trim();
    if (trimmed.length > 600) {
      return false;
    }
    const patterns = [
      /sorry,?\s*i\s*can'?t\s*assist\s*with\s*that/i,
      /i'?m\s*sorry,?\s*(but\s*)?i\s*can'?t\s*help/i,
      /i\s*can'?t\s*help\s*with\s*that\s*request/i,
      /i\s*am\s*unable\s*to\s*assist/i,
      /i\s*cannot\s*comply\s*with\s*this\s*request/i,
    ];
    return patterns.some(p => p.test(trimmed));
  }

  // ── HTML ───────────────────────────────────────────────────────────────────
  private _buildHtml(agents: AgentDefinition[], current?: AgentDefinition): string {
    const agentsJson = JSON.stringify(
      agents.map(a => ({
        name: a.name,
        description: a.description,
        scope: a.scope,
        filePath: a.filePath,
        isActive: a.filePath === current?.filePath,
      }))
    );
    const currentName = current?.name ?? '';
    const currentDesc = current?.description ?? 'No agent selected';
    const currentPath = current?.filePath ?? '';
    const hasAgents = agents.length > 0;

    const scopeIcon: Record<string, string> = {
      workspace: '⬡',
      user:      '◉',
      claude:    '✦',
    };

    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const cspSource = this._panel.webview.cspSource;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data: https:; font-src ${cspSource};"/>
<title>Local Agent Studio</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:var(--vscode-editor-background);
  --surface:var(--vscode-sideBar-background, var(--vscode-editor-background));
  --surface2:var(--vscode-input-background, var(--vscode-editor-background));
  --border:var(--vscode-panel-border, var(--vscode-editorWidget-border, transparent));
  --accent:var(--vscode-focusBorder, var(--vscode-button-background));
  --text:var(--vscode-foreground, var(--vscode-editor-foreground));
  --muted:var(--vscode-descriptionForeground);
  --success:var(--vscode-testing-iconPassed, var(--vscode-debugIcon-startForeground, #4caf50));
  --warn:var(--vscode-editorWarning-foreground, #ffca6b);
  --danger:var(--vscode-editorError-foreground, var(--vscode-errorForeground, #f44336));
  --info:var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground, var(--vscode-focusBorder)));
  --hover:var(--vscode-list-hoverBackground, rgba(127,127,127,.12));
  --active-selection:var(--vscode-list-activeSelectionBackground, rgba(127,127,127,.18));
  --btn-bg:var(--vscode-button-background);
  --btn-fg:var(--vscode-button-foreground);
  --btn-hover:var(--vscode-button-hoverBackground, var(--vscode-button-background));
  --btn-secondary-bg:var(--vscode-button-secondaryBackground, transparent);
  --btn-secondary-fg:var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  --btn-secondary-hover:var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  --link:var(--vscode-textLink-foreground);
  --radius:6px;
  --font-mono:var(--vscode-editor-font-family, 'Consolas', monospace);
  --font-ui:var(--vscode-font-family, 'Segoe UI', sans-serif);
  --font-size:var(--vscode-font-size, 13px);
}
body{background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:var(--font-size);line-height:1.5;min-height:100vh;display:flex;flex-direction:column}

/* ── Header ── */
.header{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 16px;position:sticky;top:0;z-index:10;display:flex;flex-direction:column;gap:8px}
.header-row{display:flex;align-items:center;gap:10px}
.header-icon{width:24px;height:24px;background:var(--btn-bg);border-radius:4px;display:grid;place-items:center;font-size:13px;flex-shrink:0;color:var(--btn-fg)}
.header-title{font-weight:600;font-size:14px}
.badge{font-size:10px;font-weight:600;letter-spacing:.4px;padding:2px 7px;border-radius:10px;text-transform:uppercase;background:transparent;color:var(--accent);border:1px solid var(--accent)}
.badge.ok{color:var(--success);border-color:var(--success)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.badge.active{color:var(--info);border-color:var(--info)}
.ml-auto{margin-left:auto}

/* ── Agent selector strip ── */
.agent-strip{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:border-color .15s}
.agent-strip:hover{border-color:var(--accent)}
.agent-icon{font-size:16px;flex-shrink:0;line-height:1}
.agent-info{flex:1;min-width:0}
.agent-name{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-desc{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-change{font-size:11px;color:var(--accent);white-space:nowrap;flex-shrink:0;text-decoration:none;cursor:pointer}
.agent-change:hover{text-decoration:underline}
.no-agent{color:var(--warn)}

.source-note{font-size:11px;color:var(--muted);padding-left:2px}

/* ── Agent dropdown list ── */
.agent-dropdown{position:relative}
.agent-list{display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--vscode-dropdown-background, var(--surface));border:1px solid var(--vscode-dropdown-border, var(--border));border-radius:var(--radius);overflow:hidden;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.25);color:var(--vscode-dropdown-foreground, var(--text))}
.agent-list.open{display:block}
.agent-item{padding:8px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
.agent-item:last-child{border-bottom:none}
.agent-item:hover{background:var(--hover)}
.agent-item.selected{background:var(--active-selection)}
.agent-item-name{font-weight:600;font-size:12px}
.agent-item-desc{font-size:11px;color:var(--muted)}
.agent-item-scope{font-size:10px;color:var(--muted);margin-left:auto;white-space:nowrap}
.scope-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px;vertical-align:middle;background:var(--accent)}

/* ── Main body ── */
.body{flex:1;padding:16px;max-width:900px;width:100%;margin:0 auto;overflow:visible}

/* ── Composer ── */
.composer{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:12px}
.composer-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px}
.prompt-box{width:100%;min-height:78px;resize:vertical;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border, var(--border));border-radius:var(--radius);color:var(--vscode-input-foreground, var(--text));padding:8px 10px;font-family:var(--font-ui);font-size:var(--font-size);line-height:1.5;outline:none}
.prompt-box:focus{border-color:var(--accent);outline:1px solid var(--accent);outline-offset:-1px}
.composer-controls{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.checkbox-wrap{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;margin-right:auto}

/* ── Activity log ── */
.activity-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden}
.activity-header{padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);display:flex;align-items:center}
.usage-chip{margin-left:10px;padding:2px 6px;border:1px solid var(--border);border-radius:10px;font-size:10px;color:var(--muted);font-weight:500;text-transform:none}
.timeline-groups{max-height:480px;overflow:auto;padding:6px 8px 10px;display:flex;flex-direction:column;gap:8px}
.timeline-group{border:1px solid var(--border);border-radius:var(--radius);background:var(--vscode-editor-background);overflow:hidden;flex:0 0 auto}
.timeline-group summary{cursor:pointer;list-style:none;padding:7px 10px;font-size:11px;font-weight:600;color:var(--muted);display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.4px}
.timeline-group summary::-webkit-details-marker{display:none}
.timeline-group summary::before{content:'▸';font-size:10px;color:var(--muted);transition:transform .14s ease}
.timeline-group[open] summary::before{transform:rotate(90deg)}
.group-count{margin-left:auto;font-size:10px;font-weight:600;color:var(--muted)}
.group-list{padding:0 10px 10px;display:flex;flex-direction:column;gap:8px}
.activity-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--text)}
.activity-dot{width:8px;height:8px;margin-top:5px;border-radius:50%;flex-shrink:0;background:var(--info)}
.activity-progress .activity-dot{background:var(--warn)}
.activity-warn .activity-dot{background:var(--warn)}
.activity-error .activity-dot{background:var(--danger)}
.activity-done .activity-dot{background:var(--success)}
.activity-text{white-space:pre-wrap;word-break:break-word}
.activity-time{display:inline-block;margin-left:6px;color:var(--muted);font-size:10px}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:2px;background:var(--btn-bg);color:var(--btn-fg);border:1px solid transparent;font-size:var(--font-size);font-weight:400;cursor:pointer}
.btn:hover{background:var(--btn-hover)}
.btn.ghost{background:var(--btn-secondary-bg);color:var(--btn-secondary-fg);border:1px solid var(--border)}
.btn.ghost:hover{background:var(--btn-secondary-hover)}
.btn.warn{background:transparent;color:var(--warn);border:1px solid var(--warn)}
.btn.warn:hover{background:var(--hover)}

/* ── Review card ── */
.review-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px}
.card-header{padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--muted)}
.card-body{padding:14px}
.progress-bar{height:2px;background:var(--vscode-progressBar-background, var(--accent));border-radius:2px;animation:progress 2s ease-in-out infinite alternate;margin-bottom:14px}
@keyframes progress{from{width:20%}to{width:95%}}
.cursor{display:inline-block;width:2px;height:13px;background:var(--accent);vertical-align:middle;animation:blink .7s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* ── Markdown ── */
#output h2{font-size:14px;font-weight:600;margin:18px 0 7px;padding-bottom:3px;border-bottom:1px solid var(--border)}
#output h3{font-size:13px;font-weight:600;margin:10px 0 5px;color:var(--info)}
#output p{margin-bottom:9px}
#output ul,#output ol{padding-left:18px;margin-bottom:9px}
#output li{margin-bottom:3px}
#output code{font-family:var(--font-mono);font-size:11px;background:rgba(255,255,255,.07);padding:1px 4px;border-radius:3px;color:var(--info)}
#output pre{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;overflow-x:auto;margin:10px 0}
#output pre code{background:none;padding:0;border-radius:0;color:var(--text);display:block;white-space:pre}
#output blockquote{border-left:3px solid var(--accent);padding:5px 10px;color:var(--muted);margin:8px 0;background:rgba(0,122,204,.06);border-radius:0 4px 4px 0}
#output strong{font-weight:700}

/* ── Toolbar ── */
.toolbar{display:flex;gap:8px;align-items:center;padding:10px 16px;border-top:1px solid var(--border);background:var(--surface);position:sticky;bottom:0}
.toolbar-right{margin-left:auto;display:flex;gap:8px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background, rgba(127,127,127,.3));border-radius:0}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground, rgba(127,127,127,.5))}
::-webkit-scrollbar-thumb:active{background:var(--vscode-scrollbarSlider-activeBackground, rgba(127,127,127,.7))}
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="header">
  <div class="header-row">
    <div class="header-icon">🔍</div>
    <div>
      <div class="header-title">Local Agent Studio</div>
    </div>
    <div class="ml-auto">
      <span class="badge" id="status-badge">Ready</span>
    </div>
  </div>

  <!-- Agent selector strip -->
  <div class="agent-dropdown" id="agent-dropdown">
    <div class="agent-strip" id="agent-strip">
      <span class="agent-icon" id="agent-icon">${currentName ? '✦' : '○'}</span>
      <div class="agent-info">
        <div class="agent-name ${currentName ? '' : 'no-agent'}" id="agent-name">
          ${currentName || 'No agent selected'}
        </div>
        <div class="agent-desc" id="agent-desc">${currentDesc}</div>
      </div>
      <span class="agent-change" id="agent-change-link" data-action="openPicker" title="Click to open full picker">
        ${hasAgents ? '⌄ change' : '+ add agent'}
      </span>
    </div>

    <!-- Dropdown list -->
    <div class="agent-list" id="agent-list">
      ${agents.map(a => `
        <div class="agent-item ${a.filePath === currentPath ? 'selected' : ''}"
             data-path="${escapeAttr(a.filePath)}">
          <div>
            <div class="agent-item-name">${escapeHtml(a.name)}</div>
            <div class="agent-item-desc">${escapeHtml(a.description)}</div>
          </div>
          <div class="agent-item-scope">
            <span class="scope-dot scope-${a.scope}"></span>${scopeLabel(a.scope)}
          </div>
        </div>
      `).join('')}
      ${agents.length === 0 ? `<div style="padding:12px;color:var(--muted);font-size:12px">
        No agents found in .github/agents or user profile
      </div>` : ''}
      <div class="agent-item" id="open-agent-file-item" style="border-top:1px solid var(--border)">
        <div class="agent-item-name" style="color:var(--accent)">Open agent file…</div>
      </div>
    </div>
  </div>
</div>

<!-- ── Body ── -->
<div class="body">
  <div class="source-note">Agent source: deployed workspace agents from .github/agents</div>

  <div class="composer">
    <div class="composer-title">Agent Prompt</div>
    <textarea id="prompt-box" class="prompt-box" placeholder="Ask the selected agent to review, explain, transform, or generate artifacts..."></textarea>
    <div class="composer-controls">
      <label class="checkbox-wrap">
        <input id="include-code" type="checkbox" checked />
        Include active editor context
      </label>
      <label style="display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px">
        Model:
        <select id="model-select" class="prompt-box" style="min-height:0;padding:2px 6px;width:auto;font-size:12px">
          <option value="">Auto (gpt-4o)</option>
        </select>
      </label>
      <button class="btn ghost" id="review-active-btn" data-action="reviewActiveEditor">Review Active File</button>
      <button class="btn" id="send-prompt-btn" data-action="sendPrompt">Send Prompt</button>
      <button class="btn warn" id="cancel-run-btn" data-action="cancelRun">Cancel</button>
    </div>
  </div>

  <div class="activity-card">
    <div class="activity-header">
      Action Timeline
      <span id="usage-chip" class="usage-chip">tokens/cost pending</span>
      <span id="timeline-stats" style="margin-left:auto;color:var(--muted)">idle</span>
    </div>
    <div class="timeline-groups" id="timeline-groups">
      <details class="timeline-group" open>
        <summary>Model <span id="count-model" class="group-count">0</span></summary>
        <div class="group-list" id="group-model"></div>
      </details>
      <details class="timeline-group" open>
        <summary>Prompt <span id="count-prompt" class="group-count">0</span></summary>
        <div class="group-list" id="group-prompt"></div>
      </details>
      <details class="timeline-group" open>
        <summary>Streaming <span id="count-streaming" class="group-count">0</span></summary>
        <div class="group-list" id="group-streaming"></div>
      </details>
      <details class="timeline-group" open>
        <summary>Finalize <span id="count-finalize" class="group-count">0</span></summary>
        <div class="group-list" id="group-finalize"></div>
      </details>
    </div>
  </div>

  <div class="review-card" id="review-card" style="display:none">
    <div class="card-header">
      <span style="width:7px;height:7px;border-radius:50%;background:var(--info);display:inline-block"></span>
      <span id="card-title">Agent Output</span>
    </div>
    <div class="card-body">
      <div id="progress" class="progress-bar" style="display:none"></div>
      <div id="output"></div>
      <span class="cursor" id="cursor" style="display:none"></span>
    </div>
  </div>
</div>

<!-- ── Toolbar ── -->
<div class="toolbar" id="toolbar" style="display:none">
  <span style="font-size:11px;color:var(--muted)" id="toolbar-label">Review complete</span>
  <div class="toolbar-right">
    <button class="btn ghost" id="copy-output-btn" data-action="copyOutput">📋 Copy</button>
    <button class="btn ghost" id="export-md-btn" data-action="exportMarkdown">Export .md</button>
    <button class="btn ghost" id="export-json-btn" data-action="exportJson">Export .json</button>
    <button class="btn" id="open-chat-btn" data-action="openChat">💬 Continue in Chat</button>
  </div>
</div>

<script nonce="${nonce}">
// Boot diagnostic: runs first, isolates parse/runtime errors in main script.
(function(){
  try {
    var _vscBoot = acquireVsCodeApi();
    window.__vsc = _vscBoot;
    _vscBoot.postMessage({ command: 'webviewBoot' });
    window.addEventListener('error', function(ev){
      try {
        var stack = (ev && ev.error && ev.error.stack) ? ('\\n' + ev.error.stack) : '';
        var src = '';
        try {
          // Pull the offending line from the second inline script.
          var scripts = document.getElementsByTagName('script');
          var s = scripts[scripts.length - 1];
          if (s && s.textContent && ev.lineno) {
            var lines = s.textContent.split(/\\r?\\n/);
            var ln = ev.lineno - 1;
            for (var i = Math.max(0, ln - 1); i <= Math.min(lines.length - 1, ln + 1); i++) {
              src += '\\n  L' + (i + 1) + ': ' + lines[i];
            }
          }
        } catch(_e) {}
        _vscBoot.postMessage({
          command: 'webviewError',
          text: (ev && ev.message ? ev.message : 'error') +
            (ev && ev.filename ? ' @ ' + ev.filename + ':' + ev.lineno + ':' + ev.colno : '') +
            src + stack
        });
      } catch(e) {}
    });
    window.addEventListener('unhandledrejection', function(ev){
      try { _vscBoot.postMessage({ command: 'webviewError', text: 'unhandledrejection: ' + (ev && ev.reason ? String(ev.reason) : 'unknown') }); } catch(e) {}
    });
  } catch(e) {
    // acquireVsCodeApi failed; nothing else we can do here
  }
})();
</script>
<script nonce="${nonce}">
const vscode = window.__vsc || acquireVsCodeApi();
let allAgents = ${agentsJson};
let rawMarkdown = '';
let activeFilePath = '${escapeJs(currentPath)}';
let activeRunId = 0;
const groupCounters = { model: 0, prompt: 0, streaming: 0, finalize: 0 };
let currentRunReport = null;

function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── Scope label helper ──
function scopeLabel(s){return s==='workspace'?'Workspace':s==='user'?'User profile':'Claude';}

// ── Dropdown ──────────────────────────────────────────────────────────────────
function toggleDropdown(){
  document.getElementById('agent-list').classList.toggle('open');
}
document.addEventListener('click', e => {
  const d = document.getElementById('agent-dropdown');
  if (!d.contains(e.target)) document.getElementById('agent-list').classList.remove('open');
});

function selectAgent(filePath){
  activeFilePath = filePath;
  document.getElementById('agent-list').classList.remove('open');
  vscode.postMessage({command:'selectAgent', agentPath: filePath});
  const a = allAgents.find(x => x.filePath === filePath);
  if(a){ updateAgentStrip(a); }
  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.path === filePath);
  });
}

function openPicker(){
  document.getElementById('agent-list').classList.remove('open');
  vscode.postMessage({command:'openAgentPicker'});
}

function openAgentFile(){
  document.getElementById('agent-list').classList.remove('open');
  if(activeFilePath) vscode.postMessage({command:'openAgentFile', agentPath: activeFilePath});
}

function updateAgentStrip(a){
  document.getElementById('agent-name').textContent = a.name;
  document.getElementById('agent-name').classList.toggle('no-agent', false);
  document.getElementById('agent-desc').textContent = a.description;
  document.getElementById('agent-icon').textContent = a.scope==='user'?'◉':a.scope==='claude'?'✦':'⬡';
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(md){
  // SECURITY: escape ALL HTML first, then apply markdown transforms. The model
  // may legitimately emit \`<img>\`, \`<script>\`, or other tags in its prose;
  // assigning those to innerHTML would execute inline event handlers (e.g.
  // \`<img src=x onerror=...>\`) and crash the webview script context.
  const safe = String(md).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return safe
    .replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,(_,l,c)=>\`<pre><code>\${c.replace(/\\n+$/,'')}</code></pre>\`)
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>')
    .replace(/^## (.+)$/gm,'<h2>$1</h2>')
    .replace(/^### (.+)$/gm,'<h3>$1</h3>')
    .replace(/^[-*] (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>.*<\\/li>\\n?)+/g,m=>\`<ul>\${m}</ul>\`)
    .replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>')
    .replace(/\\n\\n+/g,'</p><p>');
}

function pushActivity(group, kind, text, isoTime){
  const list = document.getElementById('group-' + group) || document.getElementById('group-finalize');
  const node = document.createElement('div');
  node.className = 'activity-item activity-' + kind;
  const ts = isoTime ? new Date(isoTime).toLocaleTimeString() : new Date().toLocaleTimeString();
  node.innerHTML = '<span class="activity-dot"></span>' +
    '<div class="activity-text">' + escapeHtml(text) + '<span class="activity-time">' + escapeHtml(ts) + '</span></div>';
  list.appendChild(node);
  groupCounters[group] = (groupCounters[group] || 0) + 1;
  const countEl = document.getElementById('count-' + group);
  if (countEl) { countEl.textContent = String(groupCounters[group]); }
  const container = document.getElementById('timeline-groups');
  container.scrollTop = container.scrollHeight;
}

function setTimelineStats(text){
  document.getElementById('timeline-stats').textContent = text;
}

function resetTimelineGroups(){
  ['model','prompt','streaming','finalize'].forEach(group => {
    groupCounters[group] = 0;
    const countEl = document.getElementById('count-' + group);
    if (countEl) { countEl.textContent = '0'; }
    const list = document.getElementById('group-' + group);
    if (list) { list.innerHTML = ''; }
  });
}

function formatUsd(value){
  return '$' + Number(value || 0).toFixed(4);
}

function updateUsageChip(usage){
  if (!usage) return;
  const text = '~' + usage.totalTokensEstimate + ' tokens | ' + formatUsd(usage.totalCostUsdEstimate);
  document.getElementById('usage-chip').textContent = text;
}

function emitClientEvent(text){
  vscode.postMessage({ command: 'clientEvent', text });
}

function dispatchUiAction(action, target){
  switch (action) {
    case 'openPicker':
      openPicker();
      break;
    case 'sendPrompt':
      sendPrompt();
      break;
    case 'reviewActiveEditor':
      reviewActiveEditor();
      break;
    case 'cancelRun':
      cancelRun();
      break;
    case 'copyOutput':
      copyOutput();
      break;
    case 'exportMarkdown':
      exportReport('markdown');
      break;
    case 'exportJson':
      exportReport('json');
      break;
    case 'openChat':
      openChat();
      break;
    default:
      if (action) {
        emitClientEvent('Unknown UI action: ' + action);
      }
      break;
  }
}

function bindAgentListHandlers(){
  document.querySelectorAll('.agent-item[data-path]').forEach(node => {
    const handler = () => {
      const filePath = node.dataset.path;
      if (filePath) {
        selectAgent(filePath);
      }
    };
    node.removeEventListener('click', handler);
    node.addEventListener('click', handler);
  });

  const openAgentFileItem = document.getElementById('open-agent-file-item');
  if (openAgentFileItem) {
    const handler = () => openAgentFile();
    openAgentFileItem.removeEventListener('click', handler);
    openAgentFileItem.addEventListener('click', handler);
  }
}

function bindStaticHandlers(){
  const agentStrip = document.getElementById('agent-strip');
  if (agentStrip) {
    const handler = () => toggleDropdown();
    agentStrip.removeEventListener('click', handler);
    agentStrip.addEventListener('click', handler);
  }

  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    const handler = () => vscode.postMessage({ command: 'selectModel', text: modelSelect.value });
    modelSelect.removeEventListener('change', handler);
    modelSelect.addEventListener('change', handler);
  }

  const agentChangeLink = document.getElementById('agent-change-link');
  if (agentChangeLink) {
    const handler = (e) => {
      e.stopPropagation();
      openPicker();
    };
    agentChangeLink.removeEventListener('click', handler);
    agentChangeLink.addEventListener('click', handler);
  }

  const reviewBtn = document.getElementById('review-active-btn');
  if (reviewBtn) {
    const handler = () => reviewActiveEditor();
    reviewBtn.removeEventListener('click', handler);
    reviewBtn.addEventListener('click', handler);
  }

  const sendBtn = document.getElementById('send-prompt-btn');
  if (sendBtn) {
    const handler = () => sendPrompt();
    sendBtn.removeEventListener('click', handler);
    sendBtn.addEventListener('click', handler);
  }

  const cancelBtn = document.getElementById('cancel-run-btn');
  if (cancelBtn) {
    const handler = () => cancelRun();
    cancelBtn.removeEventListener('click', handler);
    cancelBtn.addEventListener('click', handler);
  }

  const copyBtn = document.getElementById('copy-output-btn');
  if (copyBtn) {
    const handler = () => copyOutput();
    copyBtn.removeEventListener('click', handler);
    copyBtn.addEventListener('click', handler);
  }

  const exportMdBtn = document.getElementById('export-md-btn');
  if (exportMdBtn) {
    const handler = () => exportReport('markdown');
    exportMdBtn.removeEventListener('click', handler);
    exportMdBtn.addEventListener('click', handler);
  }

  const exportJsonBtn = document.getElementById('export-json-btn');
  if (exportJsonBtn) {
    const handler = () => exportReport('json');
    exportJsonBtn.removeEventListener('click', handler);
    exportJsonBtn.addEventListener('click', handler);
  }

  const openChatBtn = document.getElementById('open-chat-btn');
  if (openChatBtn) {
    const handler = () => openChat();
    openChatBtn.removeEventListener('click', handler);
    openChatBtn.addEventListener('click', handler);
  }

  bindAgentListHandlers();
}

function sendPrompt(){
  const prompt = document.getElementById('prompt-box').value.trim();
  const includeCode = document.getElementById('include-code').checked;
  vscode.postMessage({command:'submitPrompt', prompt, includeCode});
}

function reviewActiveEditor(){
  vscode.postMessage({command:'reviewActiveEditor'});
}

function cancelRun(){
  vscode.postMessage({command:'cancelRun'});
}

function buildMarkdownReport(report){
  const lines = [];
  lines.push('# Agent Run Report');
  lines.push('');
  lines.push('- Run ID: ' + report.runId);
  lines.push('- Status: ' + report.status);
  lines.push('- Agent: ' + report.agentName);
  lines.push('- Title: ' + report.title);
  lines.push('- File: ' + report.fileName);
  lines.push('- Started: ' + report.startedAt);
  lines.push('- Completed: ' + (report.completedAt || 'n/a'));
  if (report.elapsedMs != null) {
    lines.push('- Elapsed: ' + report.elapsedMs + ' ms');
  }
  if (report.usageEstimate) {
    lines.push('- Estimated input tokens: ' + report.usageEstimate.promptTokensEstimate);
    lines.push('- Estimated output tokens: ' + report.usageEstimate.outputTokensEstimate);
    lines.push('- Estimated total tokens: ' + report.usageEstimate.totalTokensEstimate);
    lines.push('- Estimated input cost: ' + formatUsd(report.usageEstimate.inputCostUsdEstimate));
    lines.push('- Estimated output cost: ' + formatUsd(report.usageEstimate.outputCostUsdEstimate));
    lines.push('- Estimated total cost: ' + formatUsd(report.usageEstimate.totalCostUsdEstimate));
  }
  lines.push('');
  lines.push('## User Prompt');
  lines.push('');
  lines.push(report.prompt || '(none)');
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  for (const item of report.activities || []) {
    lines.push('- [' + item.group + '][' + item.kind + '] ' + item.text + ' (' + item.at + ')');
  }
  lines.push('');
  lines.push('## Output');
  lines.push('');
  lines.push(report.outputMarkdown || '(no output)');
  return lines.join('\\n');
}

function exportReport(format){
  if (!currentRunReport) {
    return;
  }
  const reportContent = format === 'json'
    ? JSON.stringify(currentRunReport, null, 2)
    : buildMarkdownReport(currentRunReport);
  vscode.postMessage({ command: 'exportReport', format, reportContent });
}

// Bind handlers after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  bindStaticHandlers();
  vscode.postMessage({ command: 'webviewReady' });
}, { once: true });

// Failsafe: also bind immediately in case DOMContentLoaded already fired
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  bindStaticHandlers();
  vscode.postMessage({ command: 'webviewReady' });
}

// Delegated click routing as a CSP-safe fallback for all controls.
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) {
    return;
  }

  const actionEl = target.closest('[data-action]');
  if (actionEl) {
    e.preventDefault();
    e.stopPropagation();
    const action = actionEl.getAttribute('data-action') || '';
    dispatchUiAction(action, actionEl);
    return;
  }

  const agentItem = target.closest('.agent-item[data-path]');
  if (agentItem) {
    e.preventDefault();
    const filePath = agentItem.getAttribute('data-path');
    if (filePath) {
      selectAgent(filePath);
    }
    return;
  }

  if (target.closest('#agent-strip')) {
    toggleDropdown();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.ctrlKey) {
    return;
  }
  const promptEl = document.getElementById('prompt-box');
  if (document.activeElement === promptEl) {
    e.preventDefault();
    sendPrompt();
  }
});

// ── Message handler ───────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  const el = id => document.getElementById(id);
  switch(msg.command){
    case 'agentChanged':
      activeFilePath = msg.filePath;
      updateAgentStrip(msg);
      document.querySelectorAll('.agent-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.path === msg.filePath);
      });
      break;
    case 'modelsAvailable': {
      const sel = el('model-select');
      if (sel) {
        const current = msg.selectedId || '';
        sel.innerHTML = '<option value="">Auto (gpt-4o)</option>' +
          (msg.models || []).map(m => \`<option value="\${escapeHtml(m.id)}" \${m.id===current?'selected':''}>\${escapeHtml(m.name)} (\${escapeHtml(m.family)})</option>\`).join('');
      }
      break;
    }
    case 'agentListUpdated':
      allAgents = msg.agents;
      const list = el('agent-list');
      list.innerHTML = '';
      msg.agents.forEach(a => {
        const div = document.createElement('div');
        div.className = 'agent-item' + (a.isActive ? ' selected' : '');
        div.dataset.path = a.filePath;
        div.onclick = () => selectAgent(a.filePath);
        div.innerHTML = \`<div>
          <div class="agent-item-name">\${escapeHtml(a.name)}</div>
          <div class="agent-item-desc">\${escapeHtml(a.description)}</div>
        </div>
        <div class="agent-item-scope">
          <span class="scope-dot scope-\${a.scope}"></span>\${scopeLabel(a.scope)}
        </div>\`;
        list.appendChild(div);
      });
      const open = document.createElement('div');
      open.className = 'agent-item';
      open.id = 'open-agent-file-item';
      open.style.borderTop = '1px solid var(--border)';
      open.onclick = openAgentFile;
      open.innerHTML = '<div class="agent-item-name" style="color:var(--accent)">Open agent file…</div>';
      list.appendChild(open);
      bindAgentListHandlers();
      break;
    case 'runStarted':
      activeRunId = msg.runId;
      rawMarkdown = '';
      resetTimelineGroups();
      el('review-card').style.display = 'block';
      el('toolbar').style.display = 'none';
      el('progress').style.display = 'block';
      el('cursor').style.display = 'inline-block';
      el('output').innerHTML = '';
      el('card-title').textContent = msg.title + ' | ' + msg.agentName;
      el('status-badge').textContent = 'Running';
      el('status-badge').className = 'badge warn';
      setTimelineStats('running');
      updateUsageChip(msg.usageEstimate);
      pushActivity('prompt', 'info', msg.actionLabel + ' for ' + msg.fileName, new Date().toISOString());
      currentRunReport = {
        runId: msg.runId,
        status: 'running',
        title: msg.title,
        agentName: msg.agentName,
        fileName: msg.fileName,
        prompt: msg.prompt,
        includeCode: msg.includeCode,
        startedAt: msg.startedAt,
        completedAt: null,
        elapsedMs: null,
        outputMarkdown: '',
        usageEstimate: msg.usageEstimate,
        activities: [],
      };
      break;
    case 'activity':
      if (msg.runId !== activeRunId) break;
      pushActivity(msg.group, msg.kind, msg.text, msg.at);
      if (currentRunReport) {
        currentRunReport.activities.push({ group: msg.group, kind: msg.kind, text: msg.text, at: msg.at });
      }
      break;
    case 'chunk':
      if (msg.runId !== activeRunId) break;
      rawMarkdown += msg.text;
      el('output').innerHTML = renderMarkdown(rawMarkdown);
      window.scrollTo(0, document.body.scrollHeight);
      setTimelineStats(msg.chunkCount + ' chunks | ' + msg.charCount + ' chars');
      updateUsageChip(msg.usageEstimate);
      if (currentRunReport) {
        currentRunReport.outputMarkdown = rawMarkdown;
        currentRunReport.usageEstimate = msg.usageEstimate;
      }
      break;
    case 'done':
      if (msg.runId !== activeRunId) break;
      el('progress').style.display = 'none';
      el('cursor').style.display = 'none';
      el('toolbar').style.display = 'flex';
      el('status-badge').textContent = 'Done';
      el('status-badge').className = 'badge ok';
      setTimelineStats(msg.elapsedMs + ' ms | ' + msg.chunkCount + ' chunks');
      updateUsageChip(msg.usageEstimate);
      if (currentRunReport) {
        currentRunReport.status = 'done';
        currentRunReport.completedAt = msg.completedAt;
        currentRunReport.elapsedMs = msg.elapsedMs;
        currentRunReport.usageEstimate = msg.usageEstimate;
        currentRunReport.outputMarkdown = rawMarkdown;
      }
      // Re-bind toolbar handlers when they become visible
      const copyBtn = el('copy-output-btn');
      const expMdBtn = el('export-md-btn');
      const expJsonBtn = el('export-json-btn');
      const chatBtn = el('open-chat-btn');
      if (copyBtn) {
        const handler = () => copyOutput();
        copyBtn.removeEventListener('click', handler);
        copyBtn.addEventListener('click', handler);
      }
      if (expMdBtn) {
        const handler = () => exportReport('markdown');
        expMdBtn.removeEventListener('click', handler);
        expMdBtn.addEventListener('click', handler);
      }
      if (expJsonBtn) {
        const handler = () => exportReport('json');
        expJsonBtn.removeEventListener('click', handler);
        expJsonBtn.addEventListener('click', handler);
      }
      if (chatBtn) {
        const handler = () => openChat();
        chatBtn.removeEventListener('click', handler);
        chatBtn.addEventListener('click', handler);
      }
      break;
    case 'cancelled':
      if (msg.runId !== activeRunId) break;
      el('progress').style.display = 'none';
      el('cursor').style.display = 'none';
      el('status-badge').textContent = 'Cancelled';
      el('status-badge').className = 'badge';
      setTimelineStats('cancelled');
      updateUsageChip(msg.usageEstimate);
      if (currentRunReport) {
        currentRunReport.status = 'cancelled';
        currentRunReport.completedAt = msg.completedAt;
        currentRunReport.usageEstimate = msg.usageEstimate;
        currentRunReport.outputMarkdown = rawMarkdown;
      }
      break;
    case 'error':
      if (msg.runId && msg.runId !== activeRunId) break;
      el('progress').style.display = 'none';
      el('cursor').style.display = 'none';
      el('output').innerHTML += \`<blockquote>❌ <strong>Error:</strong> \${escapeHtml(msg.text)}</blockquote>\`;
      el('status-badge').textContent = 'Error';
      el('status-badge').className = 'badge';
      pushActivity('finalize', 'error', msg.text, new Date().toISOString());
      setTimelineStats('error');
      updateUsageChip(msg.usageEstimate);
      if (currentRunReport) {
        currentRunReport.status = 'error';
        currentRunReport.completedAt = msg.completedAt || new Date().toISOString();
        currentRunReport.usageEstimate = msg.usageEstimate || currentRunReport.usageEstimate;
        currentRunReport.outputMarkdown = rawMarkdown;
      }
      break;
    case 'info':
      pushActivity('prompt', 'info', msg.text, new Date().toISOString());
      break;
  }
});

function openChat(){ vscode.postMessage({command:'openChat'}); }
function copyOutput(){ vscode.postMessage({command:'copyToClipboard', markdown: rawMarkdown}); }
</script>
</body>
</html>`;
  }

  public dispose() {
    ReviewPanel.currentPanel = undefined;
    this._runTokenSource?.cancel();
    this._runTokenSource?.dispose();
    this._runTokenSource = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }
}

// HTML helpers used in template literal above
function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(s: string): string {
  return s.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
function escapeJs(s: string): string {
  return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}
function scopeLabel(s: string): string {
  return s === 'workspace' ? 'Workspace' : s === 'user' ? 'User profile' : 'Claude';
}
