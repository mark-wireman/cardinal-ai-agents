import * as vscode from 'vscode';
import { getActiveAgent, setActiveAgent } from './extension';
import { discoverAgents, pickAgent } from './agentLoader';

// ── Default fallback prompts (used when no agent file is selected) ─────────────

const DEFAULT_SYSTEM_PROMPT = `You are an expert senior software engineer and code reviewer.
You give clear, actionable, specific feedback. You identify real bugs, suggest concrete improvements
with example code, and explain your reasoning so the developer learns. Format responses with Markdown.`;

function buildReviewPrompt(code: string, lang: string): string {
  return `Review the following ${lang} code with these sections:
## 🐛 Bugs & Issues
## ⚠️ Code Quality
## 🚀 Performance
## ✅ What's Good
## 💡 Top 3 Recommendations

\`\`\`${lang}
${code}
\`\`\``;
}

function buildExplainPrompt(code: string, lang: string): string {
  return `Explain this ${lang} code:
1. **What it does** — high-level purpose
2. **How it works** — step-by-step logic
3. **Key concepts** — patterns / algorithms used
4. **Edge cases** — unusual inputs or states

\`\`\`${lang}
${code}
\`\`\``;
}

function buildRefactorPrompt(code: string, lang: string): string {
  return `Refactor this ${lang} code. Show the refactored code first, then explain each change.

\`\`\`${lang}
${code}
\`\`\``;
}

function buildTestsPrompt(code: string, lang: string): string {
  return `Generate comprehensive unit tests for this ${lang} code. Cover happy paths, edge cases,
and error cases. Use the standard testing framework for ${lang}.

\`\`\`${lang}
${code}
\`\`\``;
}

// ── Participant registration ───────────────────────────────────────────────────

export function createReviewerParticipant(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<void> => {

    // ── Resolve active agent ────────────────────────────────────────────────
    let agent = getActiveAgent();

    // /agent command: let the user pick inline from chat
    if (request.command === 'agent') {
      const agents = discoverAgents();
      const choice = await pickAgent(agents, agent);
      if (choice) {
        setActiveAgent(choice);
        agent = choice;
        stream.markdown(`✅ **Agent set to: ${choice.name}**\n\n> ${choice.description}\n\n`);
        stream.markdown('Now send your prompt and I\'ll use this agent\'s instructions.\n');
      } else {
        stream.markdown('_No agent selected — using default behaviour._\n');
      }
      return;
    }

    // ── Read code from editor ───────────────────────────────────────────────
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.selection;
    const code = editor
      ? (selection && !selection.isEmpty
          ? editor.document.getText(selection)
          : editor.document.getText())
      : '';
    const lang = editor?.document.languageId ?? 'code';
    const fileName = editor?.document.fileName.split('/').pop() ?? 'unknown file';

    // ── Show which agent is active ──────────────────────────────────────────
    if (agent) {
      stream.markdown(`_Using agent: **${agent.name}**_ — [change](command:copilot-reviewer.selectAgent)\n\n`);
    } else {
      stream.markdown(`_No agent selected — using default reviewer._ [Select agent](command:copilot-reviewer.selectAgent)\n\n`);
    }

    // ── Build system prompt from agent file body, or fall back to default ───
    const systemPrompt = agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    // ── Route by slash command ──────────────────────────────────────────────
    let userMessage: string;

    switch (request.command) {
      case 'review':
        if (!code) { stream.markdown('> ⚠️ Open a file or select code first.'); return; }
        stream.markdown(`**Reviewing** \`${fileName}\`…\n\n`);
        userMessage = buildReviewPrompt(code, lang);
        break;

      case 'explain':
        if (!code) { stream.markdown('> ⚠️ Open a file or select code first.'); return; }
        stream.markdown(`**Explaining** \`${fileName}\`…\n\n`);
        userMessage = buildExplainPrompt(code, lang);
        break;

      case 'refactor':
        if (!code) { stream.markdown('> ⚠️ Open a file or select code first.'); return; }
        stream.markdown(`**Refactoring** \`${fileName}\`…\n\n`);
        userMessage = buildRefactorPrompt(code, lang);
        break;

      case 'tests':
        if (!code) { stream.markdown('> ⚠️ Open a file or select code first.'); return; }
        stream.markdown(`**Generating tests for** \`${fileName}\`…\n\n`);
        userMessage = buildTestsPrompt(code, lang);
        break;

      default:
        // Free-form — append code context if we have it
        userMessage = code
          ? `${request.prompt}\n\nCode from \`${fileName}\`:\n\`\`\`${lang}\n${code}\n\`\`\``
          : request.prompt;
        break;
    }

    // ── Build message history ───────────────────────────────────────────────
    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
    ];

    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map(r => (r instanceof vscode.ChatResponseMarkdownPart ? r.value.value : ''))
          .join('');
        if (text) { messages.push(vscode.LanguageModelChatMessage.Assistant(text)); }
      }
    }
    messages.push(vscode.LanguageModelChatMessage.User(userMessage));

    // ── Send to LLM ─────────────────────────────────────────────────────────
    try {
      const response = await request.model.sendRequest(messages, {}, token);
      for await (const chunk of response.text) {
        stream.markdown(chunk);
      }
    } catch (err) {
      if (err instanceof vscode.CancellationError) {
        stream.markdown('\n\n_Cancelled._');
      } else {
        stream.markdown(`\n\n> ❌ **Error:** ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // ── Follow-up buttons ───────────────────────────────────────────────────
    stream.button({ command: 'copilot-reviewer.selectAgent',  title: '$(sparkle) Change agent' });
    stream.button({ command: 'copilot-reviewer.openPanel',    title: '$(preview) Open Local Agent Studio' });
  };

  const participant = vscode.chat.createChatParticipant('copilot-reviewer.agent', handler);
  participant.iconPath = new vscode.ThemeIcon('code-review');

  participant.followupProvider = {
    provideFollowups(): vscode.ChatFollowup[] {
      return [
        { prompt: '/review',  label: '$(search)  Review this file',  command: 'review'  },
        { prompt: '/explain', label: '$(book)    Explain this code',  command: 'explain' },
        { prompt: '/refactor',label: '$(wand)    Suggest refactoring',command: 'refactor'},
        { prompt: '/tests',   label: '$(beaker)  Generate tests',     command: 'tests'   },
        { prompt: '/agent',   label: '$(sparkle) Change agent',       command: 'agent'   },
      ];
    },
  };

  context.subscriptions.push(participant);
  return participant;
}
