# User Guide: Frontend Developer Agent

## Overview
The **Frontend Developer Agent** (gemini-frontend-developer) is a specialized AI assistant for generating high-quality frontend code using Gemini AI. It leverages user stories, requirements, and code review context to produce maintainable, standards-compliant code for modern frontend frameworks (e.g., Angular v15+).

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **gemini-frontend-developer** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the Frontend Developer agent.

---

## What Context to Provide the Agent

- **User Story and Requirements**: Provide user stories and requirements directly in your prompt or as attached files (.doc, .docx, .pdf, .csv, .md, .txt, etc.).
- **Acceptance Criteria**: Include acceptance criteria for more targeted code generation.
- **Design or UI Mockups**: Attach or reference any relevant UI mockups or design files.
- **Project Standards**: Mention any coding standards, frameworks, or patterns to follow.
- **Related Agents**: Reference outputs from the user-story generator or code review agent for best results.

---

## How to Interact with the Agent

- Type your request in the Copilot prompt window (e.g., “Generate an Angular component for the order summary page based on this user story”).
- If you attach a file, the agent will extract the user story, requirements, and acceptance criteria from it.
- The agent will generate frontend code that aligns with your requirements and project standards.
- Review the generated code and request modifications or clarifications as needed.

### Example Interactions

- **Prompt:** “Generate a reusable Angular button component based on the attached user story.”
- **Prompt:** “Create a micro frontend for the delivery tracking dashboard. See requirements in requirements.txt and UI in screen_mockups_csv/.”

---

## Agent-Specific Tips

- Attach user stories and requirements as files for more complex scenarios.
- Specify the frontend framework and version if not Angular v15+.
- Reference the code review agent’s guidelines for higher code quality.
- For best results, provide acceptance criteria and UI mockups.

---

For further assistance, consult the repository documentation or contact the maintainers.
