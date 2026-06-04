# Agents Architecture Document

## 1. Overview

This repository implements a **multi-agent AI development platform** that orchestrates specialized GitHub Copilot agents through a shared MCP (Model Context Protocol) server. The agents collaborate to support the full software development lifecycle—from requirements gathering and user story generation through code generation, code review, and test automation.

All AI-powered agents communicate with **Google Gemini** via a secure **Apigee API gateway**, with an optional **Deep Reinforcement Learning (DRL) agent** providing advanced code analysis and prompt optimization.

---

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph "Developer Environment (VS Code)"
        DEV[Developer]
        COPILOT[GitHub Copilot Chat]
    end

    subgraph "Agent Layer (.github/agents)"
        USG[User Story Generator]
        REQ[Requirements Generator]
        BCG[Backend Code Generator]
        FCG[Frontend Code Generator]
        CRA[Code Review Agent]
        KTG[Katalon Test Generator]
        JTG[JIRA Test Story Generator]
        GS[Gemini Specialist]
        TG[Transcript Generation]
    end

    subgraph "MCP Server (mcp-server.js)"
        MCP[MCP Server<br/>gemini-apigee-server]
        TOOLS[Tool Registry]
        ASK[ask_gemini tool]
        DRL_TOOL[deep_rl_agent tool]
    end

    subgraph "Deep RL Agent (C++)"
        DRL[DQN Agent]
        CA[Code Analyzer]
        SE[State Encoder]
        PB[Prompt Builder]
        USA[User Story Analyzer]
    end

    subgraph "External Services"
        APIGEE[Apigee Gateway]
        GEMINI[Google Gemini API]
    end

    subgraph "Context Store"
        CTX_GEN[General Standards]
        CTX_IFM[IFM Project Context]
        CTX_RO[RO Project Context]
        CTX_TEST[Testing Templates]
    end

    DEV --> COPILOT
    COPILOT --> USG & REQ & BCG & FCG & CRA & KTG & JTG & GS & TG

    USG --> MCP
    REQ --> MCP
    BCG --> MCP
    FCG --> MCP
    CRA --> MCP
    JTG --> MCP
    GS --> MCP

    KTG --> COPILOT

    MCP --> ASK
    MCP --> DRL_TOOL
    ASK --> APIGEE --> GEMINI
    DRL_TOOL --> DRL

    DRL --> CA & SE & PB & USA

    USG -.->|references| CTX_GEN & CTX_IFM & CTX_RO
    BCG -.->|references| CTX_GEN
    FCG -.->|references| CTX_GEN & CTX_IFM & CTX_RO
    CRA -.->|references| CTX_GEN
    JTG -.->|references| CTX_TEST
```

---

## 3. Component Details

### 3.1 MCP Server (`mcp-server.js`)

The central orchestration layer implementing the **Model Context Protocol** specification. It provides a unified tool interface consumed by all agents.

```mermaid
graph LR
    subgraph "MCP Server"
        direction TB
        TRANSPORT[StdioServerTransport]
        SERVER[MCP Server Instance]
        HANDLER[Request Handler]
    end

    subgraph "Tools Exposed"
        T1[ask_gemini]
        T2[deep_rl_agent]
        T3[deep_rl_code_agent<br/><i>alias</i>]
    end

    subgraph "Auth Layer"
        TOKEN[Token Cache]
        AUTH[getApigeeToken]
    end

    TRANSPORT --> SERVER --> HANDLER
    HANDLER --> T1 & T2 & T3
    T1 --> AUTH
    T2 --> AUTH
    AUTH --> TOKEN
```

| Feature | Detail |
|---------|--------|
| **Protocol** | Model Context Protocol (MCP) over stdio |
| **Runtime** | Node.js (ES Modules) |
| **Authentication** | OAuth2 client credentials via Apigee with token caching |
| **Tools** | `ask_gemini`, `deep_rl_agent`, `deep_rl_code_agent` |
| **Timeout** | 5-minute execution timeout for Deep RL analysis |

### 3.2 Authentication Flow

```mermaid
sequenceDiagram
    participant Agent
    participant MCP as MCP Server
    participant Cache as Token Cache
    participant Apigee as Apigee Gateway
    participant Gemini as Google Gemini

    Agent->>MCP: ask_gemini(prompt)
    MCP->>Cache: Check token validity
    alt Token valid
        Cache-->>MCP: Return cached token
    else Token expired/missing
        MCP->>Apigee: POST /token (client_credentials)
        Apigee-->>MCP: access_token + expires_in
        MCP->>Cache: Store token (expires - 300s buffer)
    end
    MCP->>Gemini: POST /generate (Bearer token)
    Gemini-->>MCP: AI response
    MCP-->>Agent: Formatted result
```

---

## 4. Agent Catalog

### 4.1 Agent Interaction Map

```mermaid
graph LR
    subgraph "Requirements Phase"
        TG[Transcript<br/>Generation]
        REQ[Requirements<br/>Generator]
    end

    subgraph "Story Phase"
        USG[User Story<br/>Generator]
        JTG[JIRA Test Story<br/>Generator]
    end

    subgraph "Development Phase"
        BCG[Backend Code<br/>Generator]
        FCG[Frontend Code<br/>Generator]
    end

    subgraph "Quality Phase"
        CRA[Code Review<br/>Agent]
        KTG[Katalon Test<br/>Generator]
    end

    TG -->|transcript| REQ
    REQ -->|requirements| USG
    USG -->|user stories| BCG & FCG & JTG
    BCG -->|code| CRA
    FCG -->|code| CRA
    USG -->|stories| KTG
    JTG -->|test stories| KTG
```

### 4.2 Agent Specifications

| Agent | File | AI Backend | Primary Tool | Purpose |
|-------|------|-----------|--------------|---------|
| **User Story Generator** | `user-story-generator.agent.md` | Gemini | `ask_gemini` | Generate INVEST-compliant user stories in CSV format |
| **Requirements Generator** | `requirements-generator.md` | Gemini | `ask_gemini` | Extract structured requirements from transcripts |
| **Backend Code Generator** | `backend-code-generator.md` | Gemini | `ask_gemini` | Generate Java Spring Boot + PostgreSQL code |
| **Frontend Code Generator** | `frontend-code-generator.md` | Gemini | `ask_gemini` | Generate Angular 15+ micro frontend code |
| **Code Review Agent** | `code-review-agent.agent.md` | Gemini | `ask_gemini` | Review code against stories & standards |
| **Katalon Test Generator** | `copilot-katalon-test-generator.agent.md` | Copilot | `ask_copilot` | Generate Gherkin feature files + Groovy test scripts |
| **JIRA Test Story Generator** | `jira-test-story-generator.md` | Gemini | `ask_gemini` | Generate Xray-compatible test cases in CSV |
| **Gemini Specialist** | `gemini-specialist.agent.md` | Gemini | `ask_gemini` | General-purpose AI assistant |
| **Transcript Generation** | `transcript-generation.md` | Whisper | Terminal exec | Transcribe MP4 files to text |

---

## 5. Deep RL Agent Architecture

The Deep Reinforcement Learning agent is a C++ binary providing intelligent code analysis and prompt optimization.

```mermaid
graph TB
    subgraph "Deep RL Agent (C++ Binary)"
        direction TB
        MAIN[main.cpp<br/>Entry Point]

        subgraph "Neural Network Layer"
            NN[Neural Network<br/>He init, ReLU, SGD]
            RB[Replay Buffer<br/>Experience Replay]
            DQN[DQN Agent<br/>Online + Target Networks<br/>ε-greedy Policy]
        end

        subgraph "Analysis Layer"
            CA[Code Analyzer<br/>Language detection<br/>Pattern extraction]
            SE[State Encoder<br/>CodebaseGraph → 20-dim vector]
            USA[User Story Analyzer<br/>Quality & alignment scoring]
        end

        subgraph "Generation Layer"
            PA[Prompt Actions<br/>Discrete action space]
            PB[Prompt Builder<br/>Context-aware assembly]
            RE[Reward Evaluator<br/>Code quality scoring]
        end

        subgraph "LLM Clients"
            GAPI[Gemini/Apigee Client]
            ANTH[Anthropic Client]
            OLLM[Ollama Client]
            GEN[Generic HTTP Client]
        end
    end

    MAIN --> DQN
    DQN --> NN & RB
    DQN --> CA & SE
    CA --> SE --> PA --> PB
    PB --> GAPI & ANTH & OLLM & GEN
    GAPI & ANTH & OLLM & GEN --> RE
    RE --> DQN
    MAIN --> USA
```

### 5.1 Operating Modes

| Mode | Trigger | Input | Output |
|------|---------|-------|--------|
| **User Story Analysis** | `analysis_type: "user_story"` | User story text + optional requirement context | Quality scores, alignment analysis |
| **Code Analysis + Generation** | `analysis_type: "code"` | Codebase path + user story + LLM provider config | Generated prompt, generated code, story analysis, code analysis |

### 5.2 Supported LLM Providers (Code Mode)

```mermaid
graph LR
    DRL[Deep RL Agent]

    DRL -->|gemini_apigee| G[Gemini via Apigee<br/>Uses GEMINI_ENDPOINT + token]
    DRL -->|anthropic| A[Anthropic API<br/>Uses api_key]
    DRL -->|ollama| O[Ollama Local<br/>Uses base_url + model]
    DRL -->|generic| X[Generic HTTP<br/>Uses endpoint_url + optional token]
```

---

## 6. Context Store Structure

The `context/` directory provides domain-specific knowledge that agents reference when generating artifacts.

```mermaid
graph TB
    subgraph "context/"
        subgraph "general/"
            GEN1[API Development Checklist]
            GEN2[Code Review Checklist]
            GEN3[Coding Standards]
            GEN4[Exception & Error Handling]
            GEN5[Security - Auth & Authz]
            GEN6[Spring Boot Logging Standards]
            GEN7[High-Level Design]
            GEN8[Story Point Details]
            GEN9[Swagger/OpenAPI Standards]
        end

        subgraph "IFM/"
            IFM1[Frontend Story AC Template]
            IFM2[Screen Mockups]
            IFM3[Technical Story Template]
        end

        subgraph "RO/"
            RO1[Sample Functional Story]
            RO2[Sample Technical Story]
            RO3[Screen Mockups]
        end

        subgraph "testing/"
            TEST1[Test Case Gen Template]
        end
    end
```

---

## 7. Agent Configuration Schema

Each agent is defined using a YAML frontmatter + Markdown body format:

```yaml
---
name: <agent-identifier>            # Unique agent name
description: <brief description>    # Agent purpose
tools: [<tool-list>]                # Available tool references
mcp-servers:                        # MCP server configuration
  gemini-apigee-server:
    type: 'local'
    command: 'node'
    args: ['./mcp-server.js']
    tools: ['ask_gemini']
---
# Agent Title
<markdown instructions and prompt templates>
```

### 7.1 Common Tool Categories

| Category | Tools | Used By |
|----------|-------|---------|
| **AI** | `ask_gemini`, `ask_copilot` | All agents |
| **File System** | `read_file`, `write_file`, `edit_file`, `list_files`, `delete_file` | Most agents |
| **Edit** | `edit/createDirectory`, `edit/createFile` | Most agents |
| **Agent** | `agent/runSubagent` | Code Review, Frontend, JIRA Test |
| **Web** | `web/search`, `web/scrape` | Code Review, Frontend, JIRA Test |
| **Execution** | `execute`, `read`, `edit`, `search`, `todo` | Backend, Gemini Specialist |

---

## 8. Data Flow — End-to-End SDLC

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant TG as Transcript Agent
    participant REQ as Requirements Agent
    participant USG as User Story Agent
    participant BCG as Backend Code Agent
    participant FCG as Frontend Code Agent
    participant CRA as Code Review Agent
    participant KTG as Katalon Test Agent
    participant JTG as JIRA Test Agent

    Note over Dev,JTG: Requirements Phase
    Dev->>TG: Provide MP4 recording
    TG-->>Dev: Text transcript

    Dev->>REQ: Provide transcript
    REQ-->>Dev: Structured requirements (REQ-001..N)

    Note over Dev,JTG: Story Phase
    Dev->>USG: Provide requirements
    USG-->>Dev: User stories (CSV, Gherkin AC)

    Dev->>JTG: Provide user stories
    JTG-->>Dev: Xray test cases (CSV)

    Note over Dev,JTG: Development Phase
    Dev->>BCG: Provide user story
    BCG-->>Dev: Spring Boot code files

    Dev->>FCG: Provide user story
    FCG-->>Dev: Angular component files

    Note over Dev,JTG: Quality Phase
    Dev->>CRA: Submit code for review
    CRA-->>Dev: Review report (AC verification)

    Dev->>KTG: Provide user story
    KTG-->>Dev: Katalon feature files + Groovy scripts
```

---

## 9. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **IDE** | VS Code + GitHub Copilot | Latest |
| **Agent Runtime** | GitHub Copilot Agents | — |
| **MCP Server** | Node.js (ES Modules) | 18+ |
| **MCP Protocol** | `@modelcontextprotocol/sdk` | 1.x |
| **AI Gateway** | Google Apigee | — |
| **AI Model** | Google Gemini | — |
| **Deep RL** | Custom C++ (DQN) | C++17 |
| **Transcription** | OpenAI Whisper | medium model |
| **Target Backend** | Java Spring Boot + PostgreSQL | v21 / latest |
| **Target Frontend** | Angular (Micro Frontends) | 15+ |
| **Test Automation** | Katalon (Gherkin/Groovy) | — |
| **Project Management** | JIRA + Xray | — |

---

## 10. Deployment Architecture

```mermaid
graph TB
    subgraph "Local Developer Machine"
        VS[VS Code]
        AGENTS[.github/agents/*.md]
        MCP[mcp-server.js]
        DRL[deep_rl_agent binary]
        ENV[.env file<br/>APIGEE_ENDPOINT<br/>APIGEE_KEY<br/>APIGEE_SECRET<br/>GEMINI_ENDPOINT]
        CTX[context/ folder]
    end

    subgraph "Cloud Services"
        APIGEE[Apigee API Gateway<br/>Authentication & Rate Limiting]
        GEMINI[Google Gemini API<br/>AI Inference]
    end

    VS --> AGENTS
    AGENTS -->|stdio| MCP
    MCP --> DRL
    MCP -->|HTTPS| APIGEE
    APIGEE -->|HTTPS| GEMINI
    MCP -.->|reads| ENV
    AGENTS -.->|references| CTX
```

### 10.1 Environment Variables

| Variable | Purpose |
|----------|---------|
| `APIGEE_ENDPOINT` | OAuth2 token endpoint for Apigee |
| `APIGEE_KEY` | API key for client credentials grant |
| `APIGEE_SECRET` | API secret for client credentials grant |
| `GEMINI_ENDPOINT` | Gemini model inference endpoint |

---

## 11. Security Considerations

- **No hardcoded secrets** — All credentials loaded from `.env` file
- **Token caching with buffer** — Tokens refreshed 300 seconds before expiry
- **Apigee Gateway** — Provides rate limiting, monitoring, and access control
- **Client Credentials flow** — Machine-to-machine auth, no user tokens exposed
- **Process isolation** — Deep RL agent runs as a sandboxed subprocess with 5-minute timeout
- **Input validation** — MCP server validates all tool parameters before execution

---

## 12. Extension Points

| Extension | How |
|-----------|-----|
| **Add new agent** | Create `.md` file in `.github/agents/` with YAML frontmatter |
| **Add new MCP tool** | Register in `ListToolsRequestSchema` handler in `mcp-server.js` |
| **Add LLM provider** | Implement provider case in `buildDeepRLArgs()` function |
| **Add project context** | Create subfolder in `context/` with standards and templates |
| **Switch AI model** | Update `GEMINI_ENDPOINT` environment variable |

---

## 13. Key Design Decisions

1. **MCP over stdio** — Enables local, low-latency agent-tool communication without network overhead
2. **Gemini via Apigee** — Enterprise security, audit logging, and rate control over direct API access
3. **Separate agents per concern** — Single-responsibility agents that can be composed for complex workflows
4. **Context-driven generation** — All agents reference shared standards and templates for consistency
5. **Deep RL for prompt optimization** — Learned prompt construction outperforms static templates for code generation
6. **CSV output format for stories** — Direct JIRA/Xray bulk import compatibility
7. **Gherkin acceptance criteria** — Machine-readable test specifications that bridge stories and automation
