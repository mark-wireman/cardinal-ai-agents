# User Guide: User Story Generator Agent

## Overview
The **User Story Generator Agent** (gemini-user-story-generator) is a specialized AI assistant designed to help product managers, developers, and stakeholders create high-quality, detailed user stories using Gemini AI. It ensures user stories follow agile best practices and include all necessary details for implementation.

---

## How to Select the Agent in GitHub Copilot

1. Open the Copilot Chat or Copilot prompt window in your GitHub environment.
2. If agent selection is available, choose **gemini-user-story-generator** from the list of agents.
3. If agent selection is not explicit, reference the agent by name in your prompt or use the workflow that invokes the user story generator.

---

## What Context to Provide the Agent

To generate the most effective user stories, provide the following context:

- **Feature, Requirement, or Problem Description**: Clearly describe what you want a user story for.
- **Context Folder**: Supply relevant files or information from the `context/` folder (e.g., API specifications, business rules).
- **Requirements File**: Attach or reference the requirements file associated with your feature or project.
- **Screen Mockup Folder**: Include any related files from the `screen_mockups_csv/` folder (e.g., UI mockups, configuration tables).
- **Additional Details**:
  - The user or persona (e.g., “As a warehouse manager…”)
  - The goal or action (e.g., “…I want to generate a shipping report…”)
  - The reason or business value (e.g., “…so that I can track deliveries.”)
  - Any technical constraints, requirements, or acceptance criteria.

If you provide minimal details, the agent will ask clarifying questions to gather the necessary context.

---

## How to Interact with the Agent

- Type your request in the Copilot prompt window (e.g., “Generate a user story for exporting order data to CSV”).
- The agent will use the `ask_gemini` tool to generate a detailed user story, following agile best practices.
- If your initial input is vague, the agent will prompt you for more information.
- Review the generated user story and provide feedback or request revisions as needed.

### Example Interactions

- **Prompt:** “Write a user story for a customer resetting their password.”
- **Prompt:** “I need a user story for a mobile app feature that lets drivers update delivery status.”
- **Prompt:** “Generate a user story for exporting order data to CSV, including acceptance criteria. See requirements in requirements.txt and UI in screen_mockups_csv/4._customer_access_req.csv.”

---

## Agent-Specific Tips

- The agent is optimized for clarity, completeness, and adherence to agile standards.
- You can ask for multiple user stories or request stories in a specific format.
- If you want acceptance criteria or technical notes included, mention this in your prompt.
- For best results, always provide as much relevant context as possible from the context folder, requirements file, and screen mockup folder.

---

For further assistance, consult the repository documentation or contact the maintainers.
