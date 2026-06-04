import * as vscode from 'vscode';
import { createReviewerParticipant } from './participant';
import { ReviewPanel } from './reviewPanel';
import { discoverAgents, pickAgent, type AgentDefinition } from './agentLoader';

// ── Module-level active agent state ───────────────────────────────────────────
let activeAgent: AgentDefinition | undefined;

export function getActiveAgent(): AgentDefinition | undefined {
  return activeAgent;
}

export function setActiveAgent(a: AgentDefinition | undefined): void {
  activeAgent = a;
  updateStatusBar(a);
}

// ── Status bar ─────────────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;

function updateStatusBar(agent: AgentDefinition | undefined): void {
  if (agent) {
    statusBarItem.text = `$(sparkle) ${agent.name}`;
    statusBarItem.tooltip = `Active agent: ${agent.name}\n${agent.description}\n\nClick to change agent`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(sparkle) No agent selected`;
    statusBarItem.tooltip = 'Click to select a Copilot agent';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

// ── Activation ─────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  console.log('Local Agent Studio extension activated');

  // Status bar item — agent picker (right side)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'copilot-reviewer.selectAgent';
  updateStatusBar(undefined);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Status bar item — open Studio (right side, higher priority so it's leftmost of our two)
  const openStudioItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  openStudioItem.text = '$(comment-discussion) Agent Studio';
  openStudioItem.tooltip = 'Open Local Agent Studio';
  openStudioItem.command = 'copilot-reviewer.openPanel';
  openStudioItem.show();
  context.subscriptions.push(openStudioItem);

  // Sidebar view: empty tree provider so the activity-bar icon renders and the
  // viewsWelcome buttons (defined in package.json) are shown.
  const homeProvider: vscode.TreeDataProvider<never> = {
    getTreeItem: () => { throw new Error('no items'); },
    getChildren: () => [],
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('copilot-reviewer.home', homeProvider)
  );

  // Register @reviewer chat participant
  createReviewerParticipant(context);

  // Command: Select Agent via QuickPick
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-reviewer.selectAgent', async () => {
      const agents = discoverAgents();
      const choice = await pickAgent(agents, activeAgent);
      if (choice) {
        setActiveAgent(choice);
        vscode.window.showInformationMessage(
          `Agent set to: ${choice.name}`,
          'Open Studio'
        ).then(action => {
          if (action === 'Open Studio') {
            ReviewPanel.createOrShow(context.extensionUri, context);
          }
        });
        ReviewPanel.currentPanel?.refreshAgent(choice);
      }
    })
  );

  // Command: Open Webview Panel
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-reviewer.openPanel', () => {
      ReviewPanel.createOrShow(context.extensionUri, context);
    })
  );

  // Command: Review Active File (prompts for agent if none selected)
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-reviewer.reviewActiveFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor found.');
        return;
      }

      // Auto-prompt for an agent if none is active
      if (!activeAgent) {
        const agents = discoverAgents();
        if (agents.length > 0) {
          const choice = await pickAgent(agents);
          if (choice) { setActiveAgent(choice); }
        }
      }

      const selection = editor.selection;
      const code = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

      ReviewPanel.createOrShow(context.extensionUri, context);
      ReviewPanel.currentPanel?.startReview(
        code,
        editor.document.languageId,
        editor.document.fileName.split('/').pop() ?? 'file',
        context
      );
    })
  );

  // File watcher: refresh when agent files change
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.github,.claude}/agents/*.md');
  const onAgentFilesChanged = () => {
    const agents = discoverAgents();
    // Clear active if its file was removed
    if (activeAgent && !agents.some(a => a.filePath === activeAgent?.filePath)) {
      setActiveAgent(undefined);
      vscode.window.showWarningMessage(`Agent "${activeAgent?.name}" was removed. Select a new one.`);
    }
    ReviewPanel.currentPanel?.refreshAgentList(agents);
  };
  watcher.onDidCreate(onAgentFilesChanged);
  watcher.onDidChange(onAgentFilesChanged);
  watcher.onDidDelete(onAgentFilesChanged);
  context.subscriptions.push(watcher);
}

export function deactivate() {}
