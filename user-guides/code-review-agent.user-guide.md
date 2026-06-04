# User Guide: Code Review Agent

## Overview
The **Code Review Agent** (gemini-code-review-agent) is a specialized AI assistant for reviewing code using Gemini AI. It references user stories, requirements, and standards from the context folder to ensure code quality, completeness, and alignment with project goals.

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **gemini-code-review-agent** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the Code Review agent.

---

## What Context to Provide the Agent

- **Code to Review**: Provide the code snippet, file, or pull request you want reviewed.
- **User Story and Requirements**: Attach or reference the relevant user story and requirements.
- **Acceptance Criteria**: Include acceptance criteria for explicit verification.
- **Project Standards**: Mention any coding standards, guidelines, or best practices to follow.
- **Context Folder**: Reference files from the context folder for standards and business rules.
- **Areas of Concern**: Specify any particular areas you want the agent to focus on (e.g., security, performance).

If you provide minimal details, the agent will ask clarifying questions to gather the necessary context.

---

## How to Interact with the Agent

- Type your request in the Copilot prompt window (e.g., “Review this code for compliance with the user story and acceptance criteria in requirements.txt”).
- The agent will analyze the code, referencing user stories, requirements, and standards.
- The agent will provide actionable feedback, explicitly verifying acceptance criteria and suggesting improvements.
- Review the feedback and request clarifications or follow-up reviews as needed.

### Example Interactions

- **Prompt:** “Review the attached code for the order processing module. See user story in requirements.txt and standards in context/.”
- **Prompt:** “Does this code meet all acceptance criteria for the delivery feature?”

---

## Agent-Specific Tips

- Attach user stories, requirements, and standards for more thorough reviews.
- Clearly specify acceptance criteria and areas of concern.
- For best results, provide as much relevant context as possible from the context folder and requirements files.

---

For further assistance, consult the repository documentation or contact the maintainers.
