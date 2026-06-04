import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Display name — from frontmatter `name:` or derived from filename */
  name: string;
  /** One-line description shown in the picker */
  description: string;
  /** The full markdown body (below the frontmatter) used as the system prompt */
  systemPrompt: string;
  /** Raw tool list from frontmatter, if present */
  tools: string[];
  /** Model preference from frontmatter, if present */
  model?: string;
  /** Absolute path to the source .md file */
  filePath: string;
  /** 'workspace' | 'user' | 'claude' — where the file was found */
  scope: 'workspace' | 'user' | 'claude';
}

// ── YAML frontmatter parser ────────────────────────────────────────────────────
// Handles the subset used by VS Code agent files — no external dependency needed.

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }
  const [, yamlBlock, body] = match;
  const meta: Record<string, unknown> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) { continue; }
    const [, key, rawVal] = kv;
    const val = rawVal.trim();

    // Inline array:  tools: ["a", "b"]  or  tools: [a, b]
    if (val.startsWith('[')) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    // Quoted string
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      meta[key] = val.slice(1, -1);
      continue;
    }
    meta[key] = val;
  }
  return { meta, body: body.trim() };
}

// ── Path resolution ────────────────────────────────────────────────────────────

/**
 * Returns the VS Code user-data "User" directory.
 * e.g.  ~/Library/Application Support/Code/User  (macOS)
 *       %APPDATA%\Code\User                       (Windows)
 *       ~/.config/Code/User                       (Linux)
 *
 * Also checks VS Code Insiders paths.
 */
function getUserDataDir(): string | undefined {
  const home = os.homedir();
  const candidates: string[] = [];

  switch (process.platform) {
    case 'darwin':
      candidates.push(
        path.join(home, 'Library', 'Application Support', 'Code', 'User'),
        path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User')
      );
      break;
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      candidates.push(
        path.join(appData, 'Code', 'User'),
        path.join(appData, 'Code - Insiders', 'User')
      );
      break;
    }
    default: // Linux + others
      candidates.push(
        path.join(home, '.config', 'Code', 'User'),
        path.join(home, '.config', 'Code - Insiders', 'User')
      );
  }

  return candidates.find(p => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
}

// ── File discovery ─────────────────────────────────────────────────────────────

function readAgentFiles(dir: string, scope: AgentDefinition['scope']): AgentDefinition[] {
  try {
    if (!fs.existsSync(dir)) { return []; }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const agents: AgentDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) { continue; }
      // Accept both  *.agent.md  (VS format) and  *.md  (GitHub/Claude format)
      if (!entry.name.endsWith('.md')) { continue; }

      const filePath = path.join(dir, entry.name);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);

        // Derive a display name: frontmatter > filename stem
        const stem = entry.name.replace(/\.agent\.md$/, '').replace(/\.md$/, '');
        const name = (meta['name'] as string | undefined) || toTitleCase(stem);
        const description = (meta['description'] as string | undefined) || 'Custom agent';
        const tools = (meta['tools'] as string[] | undefined) || [];
        const model = meta['model'] as string | undefined;

        if (!body) { continue; } // skip files with no body (no system prompt)

        agents.push({ name, description, systemPrompt: body, tools, model, filePath, scope });
      } catch {
        // Skip unreadable files silently
      }
    }
    return agents;
  } catch {
    return [];
  }
}

function toTitleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scans all known agent directories and returns discovered agents.
 *
 * Directories searched (in order):
 *  1. <workspace>/.github/agents     – team/project agents
 *  2. <workspace>/.claude/agents     – Claude-compatible agents
 *  3. <vscode-user>/agents           – personal agents (all workspaces)
 */
export function discoverAgents(): AgentDefinition[] {
  const found: AgentDefinition[] = [];

  // 1. Workspace agents (.github/agents and .claude/agents)
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    found.push(...readAgentFiles(path.join(root, '.github', 'agents'), 'workspace'));
    found.push(...readAgentFiles(path.join(root, '.claude', 'agents'), 'claude'));
  }

  // 2. User-profile agents
  const userDir = getUserDataDir();
  if (userDir) {
    found.push(...readAgentFiles(path.join(userDir, 'agents'), 'user'));
  }

  // Deduplicate by filePath, preserving order (workspace wins over user)
  const seen = new Set<string>();
  return found.filter(a => {
    if (seen.has(a.filePath)) { return false; }
    seen.add(a.filePath);
    return true;
  });
}

// ── QuickPick agent selector ───────────────────────────────────────────────────

const SCOPE_LABELS: Record<AgentDefinition['scope'], string> = {
  workspace: '$(repo)  Workspace',
  user:      '$(person) User profile',
  claude:    '$(sparkle) Claude',
};

/**
 * Shows a VS Code QuickPick listing all discovered agents.
 * Returns the selected agent, or `undefined` if cancelled.
 */
export async function pickAgent(
  agents: AgentDefinition[],
  current?: AgentDefinition
): Promise<AgentDefinition | undefined> {
  if (agents.length === 0) {
    const open = await vscode.window.showInformationMessage(
      'No agent files found in .github/agents or your user profile.',
      'Create one'
    );
    if (open === 'Create one') {
      await vscode.commands.executeCommand('workbench.action.chat.newCustomAgent');
    }
    return undefined;
  }

  type AgentItem = vscode.QuickPickItem & { agent: AgentDefinition };

  const items: AgentItem[] = agents.map(a => ({
    label:       a.name,
    description: SCOPE_LABELS[a.scope],
    detail:      a.description,
    agent:       a,
    picked:      a.filePath === current?.filePath,
  }));

  const choice = await vscode.window.showQuickPick(items, {
    title:             'Select a Copilot Agent',
    placeHolder:       'Filter agents by name or description…',
    matchOnDescription: true,
    matchOnDetail:      true,
  });

  return choice?.agent;
}
