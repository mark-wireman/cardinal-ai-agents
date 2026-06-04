# User Guide: Gemini Specialist Agent

## Overview
The **Gemini Specialist Agent** is an advanced AI assistant powered by Google Gemini, accessed through a secure Apigee API gateway. It is designed to help users with code analysis, code generation, natural language understanding, problem-solving, and creative content generation.

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **gemini-specialist** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the Gemini Specialist agent.

---

## What Context to Provide the Agent

- **Clear Task or Question**: Clearly state your question or task. The Gemini Specialist excels at:
  - Code analysis and code generation
  - Natural language understanding
  - Problem-solving and technical explanations
  - Creative content generation (e.g., documentation, summaries)
- **Relevant Files or Snippets**: Provide any relevant code snippets, files, or background information that will help the agent understand your request.
- **Specific Goals**: For best results, be specific about your goals (e.g., “Explain how async/await works in JavaScript” or “Generate a Python function to parse CSV files”).

---

## How to Interact with the Agent

- Type your question or request in the Copilot prompt window.
- The agent will use the `ask_gemini` tool to process your prompt and return a response.
- If you need clarification or a follow-up, simply ask additional questions in the same chat.
- If the agent encounters an error from Gemini, it will explain the error to you.

### Example Interactions

- **Prompt:** “Summarize the architecture of the MCP server in this repo.”
- **Prompt:** “Generate a TypeScript function to validate email addresses.”
- **Prompt:** “What are the main differences between Python lists and tuples?”

---

## Agent-Specific Tips

- Use clear, direct language for best results.
- If you want to use a specific tool (e.g., code search, file editing), mention it in your prompt.
- The agent can access and use tools such as file reading, editing, searching, and even running subagents.
- For advanced workflows, reference the agent’s ability to interact with the MCP server and other tools as described in its configuration.

---

For further assistance, consult the repository documentation or contact the maintainers.
