#include "dqn_agent.hpp"
#include "code_analyzer.hpp"
#include "state_encoder.hpp"
#include "prompt_actions.hpp"
#include "prompt_builder.hpp"
#include "reward_evaluator.hpp"
#include "llm_client.hpp"
#include "user_story_analyzer_service.hpp"
#include "model/user_story.hpp"
#include <iostream>
#include <vector>
#include <string>
#include <cmath>

// ── Toy environment: balance a value near 0 ───────────────────────────────────
// State:  [position, velocity]
// Actions: 0 = push left (-1), 1 = push right (+1)
struct ToyEnv {
    double pos = 0.0, vel = 0.0;
    int steps = 0;

    Vector reset() {
        pos = ((double)rand() / RAND_MAX) * 0.1 - 0.05;
        vel = 0.0;
        steps = 0;
        return {pos, vel};
    }

    struct StepResult { Vector state; double reward; bool done; };

    StepResult step(int action) {
        double force = (action == 1) ? 1.0 : -1.0;
        vel = 0.9 * vel + 0.1 * force;
        pos += vel;
        steps++;

        double reward = -std::abs(pos);
        bool done = std::abs(pos) > 1.5 || steps >= 200;
        return {{pos, vel}, reward, done};
    }
};

// Returns true when a URL contains a meaningful path after the host:port,
// e.g. "https://api.example.com/v1/chat" → true
//      "http://192.168.1.1:11434"         → false
static bool url_has_path(const std::string& url) {
    auto scheme_end = url.find("://");
    if (scheme_end == std::string::npos) return false;
    auto slash = url.find('/', scheme_end + 3);
    return slash != std::string::npos && slash + 1 < url.size();
}

// ─────────────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    const int STATE_SIZE  = 20;
    const int ACTION_SIZE = 2;    // toy env: push left / push right
    const int EPISODES    = 500;

    // ── 1. Story-only analysis (no codebase) ─────────────────────────────────
    // Detected when argv[1] contains a space — it is a sentence, not a file path.
    // Usage:
    //   Story only:                ./deep_rl_agent "<user story>"
    //   Story + requirement context: ./deep_rl_agent "<user story>" "<requirement>"
    if (argc >= 2 && std::string(argv[1]).find(' ') != std::string::npos) {
        std::string user_story   = argv[1];
        std::string requirement  = (argc >= 3) ? argv[2] : "";

        UserStoryAnalyzerService svc;
        std::vector<UserStory> stories = { UserStory("", user_story) };
        auto analyses = svc.analyzeStoryOnly(stories, requirement);

        std::cout << "\n=== User Story Analysis (Story-Only Mode) ===\n";
        if (!requirement.empty())
            std::cout << "  Requirement : " << requirement << "\n";
        std::cout << "  Story       : " << user_story << "\n\n";

        for (auto& [id, sa] : analyses) {
            std::cout << "  story[" << id.substr(0, 8) << "...]\n";
            std::cout << "    Role present    : " << (sa.has_role    ? "yes" : "no") << "\n";
            std::cout << "    Goal present    : " << (sa.has_goal    ? "yes" : "no") << "\n";
            std::cout << "    Benefit present : " << (sa.has_benefit ? "yes" : "no") << "\n";
            std::cout << "    Format score    : " << sa.format_score  << "\n";
            if (sa.alignment_score >= 0.0)
                std::cout << "    Alignment score : " << sa.alignment_score << "\n";
            std::cout << "    Overall score   : " << sa.overall_score << "\n";
            std::cout << "    Feedback        : " << sa.feedback      << "\n";
        }

        return 0;
    }

    // ── 2. Code-aware pipeline (optional – requires real codebase path) ───────
    // Usage:
    //   Anthropic: ./deep_rl_agent <codebase> <api_key> [story]
    //   Ollama:    ./deep_rl_agent <codebase> <http_base_url> <model> [story]
    //              (base URL = no path component, e.g. http://host:11434)
    //   Generic:   ./deep_rl_agent <codebase> <https://endpoint/path> [token] [story]
    //              (detected when URL has a path; token defaults to "")
    //              Supports: Azure OpenAI, Google Gemini, any OpenAI-compatible API
    if (argc > 1) {
        std::string codebase_path = argv[1];

        const std::string default_story = "As a user I want to upload a profile picture";

        bool        use_ollama  = false;
        bool        use_generic = false;
        std::string ollama_url, ollama_model;
        std::string generic_endpoint, generic_token, generic_model;
        std::string api_key, user_story;

        if (argc > 2) {
            std::string arg2 = argv[2];
            if (arg2.rfind("http", 0) == 0) {
                if (url_has_path(arg2)) {
                    // Generic endpoint (Azure, Gemini, OpenAI-compatible, etc.)
                    use_generic      = true;
                    generic_endpoint = arg2;
                    // arg[3]: token (no spaces) or story (has spaces)
                    if (argc > 3) {
                        std::string arg3 = argv[3];
                        if (arg3.find(' ') == std::string::npos) {
                            generic_token = arg3;          // token
                            user_story    = (argc > 4) ? argv[4] : default_story;
                        } else {
                            user_story = arg3;             // story, no token
                        }
                    } else {
                        user_story = default_story;
                    }
                } else {
                    // Ollama: base URL with no path
                    use_ollama   = true;
                    std::string base = arg2;
                    if (!base.empty() && base.back() == '/') base.pop_back();
                    ollama_url   = base + "/api/chat";
                    ollama_model = (argc > 3) ? argv[3] : "llama3";
                    user_story   = (argc > 4) ? argv[4] : default_story;
                }
            } else {
                // Anthropic API key
                api_key    = arg2;
                user_story = (argc > 3) ? argv[3] : default_story;
            }
        } else {
            user_story = default_story;
        }

        CodeAnalyzer  analyzer;
        StateEncoder  encoder;
        PromptBuilder builder;
        [[maybe_unused]] RewardEvaluator evaluator;

        auto graph = analyzer.analyze(codebase_path);
        std::cout << "Analysed " << graph.files.size() << " files. "
                  << "Pattern: " << graph.dominant_pattern << "\n";

        const int CODE_STATE  = 20;
        const int CODE_ACTION = (int)PromptAction::ACTION_COUNT;

        DQNAgent code_agent(CODE_STATE, CODE_ACTION,
            /*lr=*/1e-3, /*gamma=*/0.95,
            /*eps_start=*/1.0, /*eps_min=*/0.05, /*eps_decay=*/0.99,
            /*batch=*/16, /*buf=*/5000, /*tgt_upd=*/50);

        std::vector<std::string> training_stories = {
            "As a user I want to create a new account with email and password",
            "As an admin I want to list all users with pagination",
            "As a user I want to update my profile information",
            "As a system I want to send email notifications on signup"
        };

        for (int ep = 0; ep < 200; ++ep) {
            auto& story = training_stories[ep % training_stories.size()];
            auto  state = encoder.encode(graph, story);
            int   action = code_agent.select_action(state);

            PromptDecisions decisions;
            decisions.selected_actions.push_back(static_cast<PromptAction>(action));
            decisions.naming_convention    = "camelCase";
            decisions.error_handling_style = "exceptions";

            // Mock reward for demo (replace with real LLM call + evaluator)
            double reward = (action < 6) ? 1.0 : -0.5;

            code_agent.remember(state, action, reward, state, true);
            double loss = code_agent.train_step();

            if (ep % 50 == 0)
                std::cout << "Code Agent Ep " << ep
                          << " | Reward: " << reward
                          << " | Loss: "   << loss
                          << " | Eps: "    << code_agent.epsilon << "\n";
        }

        // Inference
        code_agent.epsilon = 0.0;
        auto inf_state   = encoder.encode(graph, user_story);
        int  best_action = code_agent.select_action(inf_state);

        PromptDecisions final_decisions;
        final_decisions.selected_actions.push_back(
            static_cast<PromptAction>(best_action));
        final_decisions.naming_convention    = "camelCase";
        final_decisions.error_handling_style = "exceptions";

        std::string prompt = builder.build(user_story, final_decisions, graph);
        std::cout << "\n=== Generated Prompt ===\n" << prompt << "\n";

        if (use_generic) {
            std::cout << "Calling generic endpoint (" << generic_endpoint << ")...\n";
            GenericLLMClient llm(generic_endpoint, generic_token, generic_model);
            auto code = llm.generate(prompt);
            std::cout << "\n=== Generated Code ===\n" << code << "\n";
        } else if (use_ollama) {
            std::cout << "Calling Ollama (" << ollama_model
                      << " @ " << ollama_url << ")...\n";
            OllamaClient llm(ollama_model, ollama_url);
            auto code = llm.generate(prompt);
            std::cout << "\n=== Generated Code ===\n" << code << "\n";
        } else if (!api_key.empty()) {
            LLMClient llm(api_key);
            auto code = llm.generate(prompt);
            std::cout << "\n=== Generated Code ===\n" << code << "\n";
        }

        // ── User Story Analyzer demo ──────────────────────────────────────────
        std::cout << "\n=== User Story Analysis ===\n";
        UserStoryAnalyzerService svc;
        std::vector<UserStory> stories = {
            UserStory("", user_story),
            UserStory("", "As an admin I want to see system metrics"),
            UserStory("", "As a developer I want CI to run tests automatically"),
        };
        auto story_scores = svc.analyze(stories, /*isCode=*/false);
        for (auto& [id, score] : story_scores)
            std::cout << "  story[" << id.substr(0, 8) << "...] -> score: " << score << "\n";

        std::cout << "\n=== Code Analysis ===\n";
        std::cout << "  Language : " << graph.dominant_language << "\n";
        std::cout << "  Pattern  : " << graph.dominant_pattern  << "\n";
        std::cout << "  Files    : " << graph.files.size()      << "\n";

        return 0;
    }

    // ── 2. Standalone DQN demo (toy balancing environment) ────────────────────
    std::cout << "Running standalone DQN demo (toy balancing env)...\n\n";

    DQNAgent agent(STATE_SIZE, ACTION_SIZE,
        /*lr=*/1e-3, /*gamma=*/0.99,
        /*eps_start=*/1.0, /*eps_min=*/0.01, /*eps_decay=*/0.995,
        /*batch=*/32, /*buf=*/5000, /*tgt_upd=*/50);

    ToyEnv env;

    for (int ep = 0; ep < EPISODES; ++ep) {
        Vector state = env.reset();
        double total_reward = 0.0;
        double avg_loss     = 0.0;
        int    num_steps    = 0;
        bool   done         = false;

        while (!done) {
            int action = agent.select_action(state);
            auto [next_state, reward, is_done] = env.step(action);
            agent.remember(state, action, reward, next_state, is_done);
            double loss = agent.train_step();

            total_reward += reward;
            avg_loss     += loss;
            state         = next_state;
            done          = is_done;
            ++num_steps;
        }

        if (ep % 50 == 0) {
            auto q_vals = agent.get_q_values(state);
            std::cout << "Episode " << ep
                      << " | Steps: "    << num_steps
                      << " | Reward: "   << total_reward
                      << " | AvgLoss: "  << avg_loss / num_steps
                      << " | Eps: "      << agent.epsilon
                      << " | Q[L]: "     << q_vals[0]
                      << " | Q[R]: "     << q_vals[1]
                      << "\n";
        }
    }

    return 0;
}
