# User Guide: Backend Code Generator Agent

## Overview
The **Backend Code Generator Agent** (gemini-backend-code-generator) is a specialized AI assistant for generating backend code in Java Spring Boot and PostgreSQL from user stories. It produces REST APIs, data models, repositories, and database migrations based on well-defined requirements.

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **gemini-backend-code-generator** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the Backend Code Generator agent.

---

## What Context to Provide the Agent

- **User Story and Requirements**: Provide user stories and requirements directly in your prompt or as attached files.
- **Data Models/Entities**: Describe the data models or entities involved, if known.
- **API Endpoints**: Specify required API endpoints and HTTP methods.
- **Business Rules**: Include any security, validation, or business rules.
- **Integration Needs**: Mention any external dependencies or integrations.
- **Acceptance Criteria**: Attach or reference acceptance criteria for more targeted code generation.

If you provide minimal details, the agent will ask clarifying questions to gather the necessary context.

---

## How to Interact with the Agent

- Type your request in the Copilot prompt window (e.g., “Generate backend code for order management based on this user story”).
- The agent will analyze the user story, extract backend requirements, and generate Java Spring Boot and PostgreSQL code.
- Review the generated code and request modifications or clarifications as needed.

### Example Interactions

- **Prompt:** “Generate REST API and data models for the inventory module. See user story in requirements.txt.”
- **Prompt:** “Create Spring Boot endpoints for user authentication and registration.”

---

## Agent-Specific Tips

- Attach user stories and requirements as files for more complex scenarios.
- Specify data models, endpoints, and business rules for more precise code generation.
- For best results, provide acceptance criteria and integration details.

---

For further assistance, consult the repository documentation or contact the maintainers.
