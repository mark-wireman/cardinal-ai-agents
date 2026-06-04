# How To: Deep RL Analyzer

This guide covers two usage modes:

1. [Standalone](#standalone-usage) — run the analyzer directly from the command line
2. [Multi-Agent System](#multi-agent-system-with-python) — drive the analyzer from a Python orchestrator

---

## Standalone Usage

### Prerequisites

Build the binary first (see [README.md](README.md)):

```bash
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
cd ..
```

The binary is at `build/deep_rl_agent`.

---

### Mode 1 — Demo (no LLM, no codebase)

Runs a toy balancing environment to verify the DQN training loop works.

```bash
./build/deep_rl_agent
```

Expected output:

```
Running standalone DQN demo (toy balancing env)...

Episode 0   | Steps: 14  | Reward: -1.23 | AvgLoss: 0 | Eps: 1
Episode 50  | Steps: 31  | Reward: -2.07 | AvgLoss: 0.012 | Eps: 0.78
...
```

---

### Mode 2 — Codebase Analysis + Code Generation (Anthropic)

Analyses your codebase, trains the DQN on synthetic stories, then generates code for your user story using the Anthropic Claude API.

```bash
./build/deep_rl_agent <codebase_path> <api_key> "<user story>"
```

Example:

```bash
./build/deep_rl_agent /path/to/my/project sk-ant-abc123 \
    "As a user I want to reset my password via email"
```

---

### Mode 3 — Codebase Analysis + Code Generation (Ollama)

Uses a local or remote Ollama server — no API key required.

```bash
./build/deep_rl_agent <codebase_path> <ollama_base_url> <model> "<user story>"
```

Detected automatically when the second argument is an `http` base URL with **no path** (e.g. `http://host:11434`).

**Local Ollama:**

```bash
ollama serve   # start the server first

./build/deep_rl_agent /path/to/my/project \
    http://localhost:11434 \
    llama3.1:8b \
    "As a user I want to reset my password via email"
```

**Remote Ollama host:**

```bash
./build/deep_rl_agent /path/to/my/project \
    http://192.168.50.153:11434 \
    llama3.1:8b \
    "As a user I want to reset my password via email"
```

---

### Mode 4 — Codebase Analysis + Code Generation (Generic endpoint)

Accepts any model endpoint URL — Azure OpenAI, Google Gemini, or any
OpenAI-compatible API. The token is optional and defaults to an empty string.

```bash
./build/deep_rl_agent <codebase_path> <endpoint_url> [token] "<user story>"
```

Detected automatically when the second argument is an `https` URL **with a path**
(e.g. `https://host/v1/chat/completions`). The endpoint type is then
inferred from the URL:

| URL contains | Auth mechanism | Request format | Response field |
| :----------- | :------------- | :------------- | :------------- |
| `openai.azure.com` | `api-key` header | OpenAI messages | `choices[0].message.content` |
| `googleapis.com` | `?key=` query param | Gemini contents/parts | `candidates[0].content.parts[0].text` |
| anything else | `Authorization: Bearer` header | OpenAI messages | `choices[0].message.content` |

**Azure OpenAI:**

```bash
./build/deep_rl_agent /path/to/my/project \
    "https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01" \
    my-azure-api-key \
    "As a user I want to reset my password via email"
```

**Google Gemini:**

```bash
./build/deep_rl_agent /path/to/my/project \
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent" \
    my-gemini-api-key \
    "As a user I want to reset my password via email"
```

**Generic OpenAI-compatible (e.g. OpenRouter, Together AI, local vLLM):**

```bash
# With auth token
./build/deep_rl_agent /path/to/my/project \
    https://openrouter.ai/api/v1/chat/completions \
    my-token \
    "As a user I want to reset my password via email"

# Anonymous / no token
./build/deep_rl_agent /path/to/my/project \
    http://localhost:8000/v1/chat/completions \
    "As a user I want to reset my password via email"
```

---

### Output Sections

Every run with a codebase path produces four labelled sections:

```
Analysed 21 files. Pattern: MVC
Code Agent Ep 0   | Reward: 1 | Loss: 0    | Eps: 1.0
Code Agent Ep 50  | Reward: 1 | Loss: 0.01 | Eps: 0.70
...

=== Generated Prompt ===
You are a C++ code generation assistant ...
## User Story
As a user I want to reset my password via email
## Language
Write **C++** only. ...
## Libraries Already in Use
- fstream
- map
- string
...

Calling Ollama (llama3.1:8b @ http://192.168.50.153:11434/api/chat)...

=== Generated Code ===
// PasswordResetService.hpp
...

=== User Story Analysis ===
  story[13085944...] -> score: 0.8
  story[17837190...] -> score: 0.8
  story[18414075...] -> score: 0.8

=== Code Analysis ===
  Language : C++
  Pattern  : MVC
  Files    : 21
```

---

## Multi-Agent System with Python

The analyzer binary is designed to be driven as a subprocess. A Python orchestrator
can invoke it, parse the output, and chain results across multiple agents.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│ Python Orchestrator                                  │
│                                                      │
│  StoryAgent ──► AnalyzerAgent ──► ReviewerAgent     │
│       │               │                  │           │
│  Break backlog    Run deep_rl_agent   Score output   │
│  into stories     per story           and rank       │
└─────────────────────────────────────────────────────┘
         ▼                  ▼
    Ollama / Claude    deep_rl_agent binary
```

---

### Python Wrapper

Save this as `agents/analyzer_agent.py`:

```python
import subprocess
import re
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class AnalyzerResult:
    files_analysed: int = 0
    pattern: str = ""
    language: str = ""
    generated_prompt: str = ""
    generated_code: str = ""
    story_scores: dict = field(default_factory=dict)

class AnalyzerAgent:
    """Wraps the deep_rl_agent binary as a callable Python agent."""

    def __init__(
        self,
        binary: str = "./build/deep_rl_agent",
        ollama_url: str = "http://localhost:11434",
        model: str = "llama3.1:8b",
        api_key: Optional[str] = None,
    ):
        self.binary = binary
        self.ollama_url = ollama_url
        self.model = model
        self.api_key = api_key

    def run(self, codebase: str, user_story: str) -> AnalyzerResult:
        if self.api_key:
            cmd = [self.binary, codebase, self.api_key, user_story]
        else:
            cmd = [self.binary, codebase, self.ollama_url, self.model, user_story]

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f"Analyzer failed:\n{proc.stderr}")

        return self._parse(proc.stdout)

    # ── Output parsing ────────────────────────────────────────────────────────

    def _parse(self, output: str) -> AnalyzerResult:
        result = AnalyzerResult()

        # Files + pattern from first line
        m = re.search(r"Analysed (\d+) files\. Pattern: (\S+)", output)
        if m:
            result.files_analysed = int(m.group(1))
            result.pattern = m.group(2)

        # Generated prompt
        result.generated_prompt = self._extract_section(
            output, "Generated Prompt", "Calling Ollama|Generated Code|User Story Analysis"
        )

        # Generated code
        result.generated_code = self._extract_section(
            output, "Generated Code", "User Story Analysis|Code Analysis"
        )

        # User story scores
        for m in re.finditer(r"story\[([^\]]+)\] -> score: ([\d.]+)", output):
            result.story_scores[m.group(1)] = float(m.group(2))

        # Code analysis summary
        m = re.search(r"Language\s*:\s*(.+)", output)
        if m:
            result.language = m.group(1).strip()

        return result

    def _extract_section(self, text: str, start: str, stop_pattern: str) -> str:
        pattern = rf"=== {start} ===\n(.*?)(?:=== (?:{stop_pattern}) ===|$)"
        m = re.search(pattern, text, re.DOTALL)
        return m.group(1).strip() if m else ""
```

---

### Simple Standalone Script

Use this when you want one story → one code generation:

```python
# run_standalone.py
from agents.analyzer_agent import AnalyzerAgent

agent = AnalyzerAgent(
    ollama_url="http://192.168.50.153:11434",
    model="llama3.1:8b",
)

result = agent.run(
    codebase="/path/to/my/project",
    user_story="As a user I want to reset my password via email",
)

print(f"Language : {result.language}")
print(f"Pattern  : {result.pattern}")
print(f"Files    : {result.files_analysed}")
print(f"\n--- Generated Code ---\n{result.generated_code}")
```

Run it:

```bash
python run_standalone.py
```

---

### Multi-Agent Orchestrator

This example shows three agents working in a pipeline: one that scores stories, one
that generates code per story, and one that ranks the outputs.

```python
# orchestrator.py
import concurrent.futures
from agents.analyzer_agent import AnalyzerAgent, AnalyzerResult

CODEBASE = "/path/to/my/project"
OLLAMA   = "http://192.168.50.153:11434"
MODEL    = "llama3.1:8b"

# ── Backlog of user stories to process ───────────────────────────────────────
BACKLOG = [
    "As a user I want to reset my password via email",
    "As an admin I want to export all users as CSV",
    "As a user I want to see my login history",
    "As a developer I want an API health-check endpoint",
]

# ── Agent 1: Analyzer — runs deep_rl_agent for each story ────────────────────
def analyze_story(story: str) -> tuple[str, AnalyzerResult]:
    agent = AnalyzerAgent(ollama_url=OLLAMA, model=MODEL)
    result = agent.run(CODEBASE, story)
    return story, result

# ── Agent 2: Scorer — ranks generated outputs by story score ─────────────────
def score_result(story: str, result: AnalyzerResult) -> dict:
    avg_score = (
        sum(result.story_scores.values()) / len(result.story_scores)
        if result.story_scores else 0.0
    )
    code_lines = result.generated_code.count("\n")
    return {
        "story": story,
        "avg_score": avg_score,
        "code_lines": code_lines,
        "language": result.language,
        "pattern": result.pattern,
        "code": result.generated_code,
    }

# ── Agent 3: Reviewer — prints ranked summary ─────────────────────────────────
def review(ranked: list[dict]):
    print("\n=== Multi-Agent Review Summary ===\n")
    for i, entry in enumerate(ranked, 1):
        print(f"#{i}  Score: {entry['avg_score']:.2f}  "
              f"Lines: {entry['code_lines']:3d}  "
              f"Pattern: {entry['pattern']:<10}  "
              f"Story: {entry['story'][:60]}")

# ── Orchestrator ──────────────────────────────────────────────────────────────
def main():
    print(f"Processing {len(BACKLOG)} stories across {len(BACKLOG)} analyzer agents...\n")

    # Run all stories in parallel (one agent subprocess per story)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(analyze_story, s): s for s in BACKLOG}
        results = {}
        for future in concurrent.futures.as_completed(futures):
            story, result = future.result()
            results[story] = result
            print(f"  [done] {story[:60]}")

    # Score each result
    scored = [score_result(story, result) for story, result in results.items()]

    # Rank by average story score descending
    ranked = sorted(scored, key=lambda x: x["avg_score"], reverse=True)

    # Review
    review(ranked)

    # Save top result
    top = ranked[0]
    with open("top_generated.cpp", "w") as f:
        f.write(f"// Story: {top['story']}\n")
        f.write(top["code"])
    print(f"\nTop result saved to top_generated.cpp")

if __name__ == "__main__":
    main()
```

Run it:

```bash
python orchestrator.py
```

Expected output:

```
Processing 4 stories across 4 analyzer agents...

  [done] As a user I want to reset my password via email
  [done] As a developer I want an API health-check endpoint
  [done] As an admin I want to export all users as CSV
  [done] As a user I want to see my login history

=== Multi-Agent Review Summary ===

#1  Score: 0.80  Lines:  87  Pattern: MVC        Story: As a user I want to reset my password via email
#2  Score: 0.80  Lines:  63  Pattern: MVC        Story: As an admin I want to export all users as CSV
#3  Score: 0.80  Lines:  51  Pattern: MVC        Story: As a developer I want an API health-check endpoint
#4  Score: 0.80  Lines:  44  Pattern: MVC        Story: As a user I want to see my login history

Top result saved to top_generated.cpp
```

---

### Adding More Agents

The orchestrator is open-ended. Some patterns to extend it:

| Agent role | What it does |
| :--------- | :----------- |
| **Planner** | Calls an LLM to decompose a feature into user stories before passing to `AnalyzerAgent` |
| **Linter** | Runs `clang-format` or `flake8` on `generated_code` and feeds the result back as a reward signal |
| **Tester** | Writes the generated code to a temp file, compiles it, runs a test suite, and returns pass/fail |
| **Router** | Inspects `result.language` and `result.pattern` to pick the right model (e.g. `codellama` for C++, `deepseek-coder` for Python) |

Wire any of these into the `main()` pipeline between `analyze_story` and `review`.
