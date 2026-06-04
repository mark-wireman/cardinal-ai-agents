# Deep RL Agent — C++ Implementation

A self-learning Deep Q-Network (DQN) agent that:

1. Analyses a codebase's structure, conventions, and dominant language
2. Learns which contextual information to include in prompts
3. Dynamically generates LLM prompts from user stories
4. Uses the LLM to produce idiomatic, architecture-conforming code
5. Scores and analyses user stories via the `UserStoryAnalyzerService`

See [HOWTO.md](HOWTO.md) for standalone and multi-agent usage guides.

---

## Project Structure

```text
deep_rl_cpp/
├── CMakeLists.txt
├── README.md
├── HOWTO.md                              # Usage guide (standalone + multi-agent)
├── controller/
│   ├── controller.hpp                    # Controller — dispatches analysis menu
│   └── controller.cpp
├── model/
│   ├── user_story.hpp                    # UserStory data model
│   ├── user_story.cpp
│   └── id_generator.hpp                  # Hash-based ID generation
├── service/
│   └── service.hpp                       # Service / ServiceController base classes
└── src/
    ├── neural_network.hpp                # Pure C++ neural network (He init, ReLU, SGD)
    ├── replay_buffer.hpp                 # Fixed-capacity experience replay buffer
    ├── dqn_agent.hpp                     # DQN agent (online + target networks, ε-greedy)
    ├── code_analyzer.hpp                 # Codebase walker — language, pattern, features
    ├── state_encoder.hpp                 # CodebaseGraph → 20-dim state vector
    ├── prompt_actions.hpp                # Discrete action space enum + PromptDecisions
    ├── prompt_builder.hpp                # Assembles LLM prompt from agent decisions
    ├── reward_evaluator.hpp              # Scores generated code → scalar reward
    ├── user_story_analyzer_service.hpp   # Analyses user stories, returns scores
    ├── user_story_analyzer_service.cpp
    ├── llm_client.hpp                    # Anthropic + Ollama client interfaces
    ├── llm_client.cpp                    # libcurl implementations
    └── main.cpp                          # Training loop + inference + analysis demo
```

---

## Dependencies

| Dependency | Required | Purpose | Install |
| :--------- | :------- | :------ | :------ |
| C++17 compiler | Yes | Structured bindings, `fs::` | GCC 9+, Clang 9+, MSVC 2019+ |
| CMake 3.16+ | Yes | Build system | `apt-get install cmake` |
| libcurl | Optional | HTTP calls to Anthropic/Ollama API | `apt-get install libcurl4-openssl-dev` |
| nlohmann/json | Optional | JSON serialisation | `apt-get install nlohmann-json3-dev` |
| Ollama | Optional | Local LLM inference server | [ollama.com](https://ollama.com) |

The agent runs **without** libcurl/json in demo mode (toy balancing environment).

---

## Build

### Linux / macOS

```bash
# 1. Install optional dependencies (for LLM support)
sudo apt-get install libcurl4-openssl-dev nlohmann-json3-dev   # Ubuntu/Debian
brew install curl nlohmann-json                                # macOS

# 2. Build
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

### Windows (MSVC + vcpkg)

```powershell
vcpkg install curl nlohmann-json
mkdir build && cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build . --config Release
```

---

## Running

### Demo mode — no LLM, no codebase required

```bash
./deep_rl_agent
```

### With a real codebase — Anthropic Claude

```bash
./deep_rl_agent /path/to/project sk-ant-your-api-key "your user story"
```

### With a real codebase — Ollama (no API key)

Detected when the second argument is an `http` base URL with **no path**.

```bash
# Local
./deep_rl_agent /path/to/project http://localhost:11434 llama3.1:8b "your user story"

# Remote
./deep_rl_agent /path/to/project http://192.168.50.153:11434 llama3.1:8b "your user story"
```

### With a real codebase — Generic endpoint (Azure, Gemini, any OpenAI-compatible API)

Detected when the second argument is a URL **with a path**. The token defaults to an empty string.

```bash
# Azure OpenAI
./deep_rl_agent /path/to/project \
    "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01" \
    my-azure-key "your user story"

# Google Gemini
./deep_rl_agent /path/to/project \
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent" \
    my-gemini-key "your user story"

# Any OpenAI-compatible endpoint (token optional)
./deep_rl_agent /path/to/project \
    https://openrouter.ai/api/v1/chat/completions \
    my-token "your user story"
```

The endpoint type is inferred from the URL — see [HOWTO.md](HOWTO.md) for the full detection table.

### Output

Each run with a codebase path prints four sections:

```text
Analysed 21 files. Pattern: MVC
Code Agent Ep 0 | Reward: 1 | Loss: 0 | Eps: 1.0
...

=== Generated Prompt ===
...

=== Generated Code ===
...

=== User Story Analysis ===
  story[13085944...] -> score: 0.8
  ...

=== Code Analysis ===
  Language : C++
  Pattern  : MVC
  Files    : 21
```

For driving the binary from Python (standalone script or multi-agent orchestrator), see [HOWTO.md](HOWTO.md).

---

## How It Works

### Q-Value Flow

```text
State [codebase features + story keywords]  (20-dim)
       │
       ▼
  Online Network  [20 → 128 → 128 → 12]
       │
       ▼
  Q-values: [Q(s,a₀), Q(s,a₁), …, Q(s,a₁₁)]
       │
       ├─ Action selection: argmax → chosen PromptAction
       │
       └─ Training:
             TD Target  = r + γ · max Q_target(s', a')
             TD Error   = TD Target − Q_online(s, a)
             Loss       = TD Error²
             Backprop   → update online network weights
```

### Pipeline

```text
┌──────────────────────────────────────────────────────┐
│ OFFLINE (once per codebase)                          │
│  Codebase → CodeAnalyzer → CodebaseGraph             │
│    detects: language, architecture pattern,          │
│    naming convention, libraries in use               │
└──────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────┐
│ TRAINING (200 episodes)                              │
│  Story + State → DQNAgent.select_action()            │
│       ↓                                              │
│  PromptDecisions → PromptBuilder → Prompt string     │
│    injects: language, libraries, architecture        │
│       ↓                                              │
│  LLM → Generated Code → RewardEvaluator → Reward    │
│       ↓                                              │
│  DQNAgent.train_step() → better Q-values             │
└──────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────┐
│ INFERENCE                                            │
│  New Story → Encode → Agent picks best actions       │
│                  ↓                                   │
│           LLM → Production Code                      │
└──────────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────────┐
│ USER STORY ANALYSIS                                  │
│  UserStoryAnalyzerService scores each story          │
│  Results keyed by content-hash ID                    │
└──────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

| Decision | Rationale |
| :------- | :-------- |
| Header-only core (except LLM client) | Zero-dependency compilation for demo mode |
| He initialisation | Prevents vanishing gradients with ReLU activations |
| Separate online / target networks | Prevents reward instability (moving target problem) |
| ε-greedy with decay | Explores early, exploits learned policy later |
| Multi-signal reward | Compilation + style + architecture = holistic quality |
| Language detection in prompt | Prevents LLM from switching languages (e.g. Python on a C++ project) |
| Library inventory in prompt | Constrains LLM to dependencies already in the codebase |
| Ollama support | Local inference with no API key; detected by `http` prefix on arg |

---

## Extending

- **New action**: Add entry to `PromptAction` enum, handle in `PromptBuilder::build()`
- **Richer state**: Extend `StateEncoder::encode()` — update `STATE_SIZE` in `main.cpp`
- **Different LLM**: Implement `generate()` in `llm_client.cpp` for your provider
- **Deeper network**: Change topology in `DQNAgent` constructor: `{20, 256, 256, 12}`
- **Real reward signal**: Replace the mock reward in `main.cpp` with `RewardEvaluator::compute_reward()` wired to actual compilation + test results
- **Multi-agent orchestration**: See [HOWTO.md — Multi-Agent System](HOWTO.md#multi-agent-system-with-python)
