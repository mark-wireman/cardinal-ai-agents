#pragma once
#include "code_analyzer.hpp"
#include <string>
#include <vector>
#include <regex>
#include <map>
#include <set>
#include <algorithm>

struct GenerationResult {
    std::string generated_code;
    bool        compiled_successfully;
    bool        tests_passed;
    double      style_match_score;     // 0..1
    double      architecture_score;    // 0..1
    std::string human_feedback;        // "good" / "bad" / "partial"
};

class RewardEvaluator {
public:
    double compute_reward(const GenerationResult& result,
                          [[maybe_unused]] const CodebaseGraph& graph) {
        double reward = 0.0;

        // ── Compilation / syntax (most important signal) ──────────────────────
        if (result.compiled_successfully) reward += 3.0;
        else                              reward -= 5.0;

        // ── Test passage ──────────────────────────────────────────────────────
        if (result.tests_passed) reward += 2.0;
        else                     reward -= 1.0;

        // ── Style match: naming, conventions, patterns ────────────────────────
        reward += result.style_match_score * 2.0;

        // ── Architectural correctness ─────────────────────────────────────────
        reward += result.architecture_score * 2.0;

        // ── Human feedback (optional online learning) ─────────────────────────
        if (result.human_feedback == "good")    reward += 3.0;
        if (result.human_feedback == "partial") reward += 0.5;
        if (result.human_feedback == "bad")     reward -= 3.0;

        // ── Prompt efficiency penalty ─────────────────────────────────────────
        reward -= 0.1;

        return reward;
    }

    // Automatically score style match against codebase
    double score_style_match(const std::string& generated,
                              const CodebaseGraph& graph) {
        double score = 0.0;
        int    checks = 0;

        auto dominant_naming = get_dominant_naming(graph);
        score += naming_matches(generated, dominant_naming) ? 1.0 : 0.0;
        ++checks;

        auto dominant_errors = get_dominant_error_style(graph);
        score += error_style_matches(generated, dominant_errors) ? 1.0 : 0.0;
        ++checks;

        score += import_validity_score(generated, graph);
        ++checks;

        return score / checks;
    }

private:
    std::string get_dominant_naming(const CodebaseGraph& g) {
        std::map<std::string, int> counts;
        for (auto& f : g.files) counts[f.naming_convention]++;
        return std::max_element(counts.begin(), counts.end(),
            [](auto& a, auto& b){ return a.second < b.second; })->first;
    }

    std::string get_dominant_error_style(const CodebaseGraph& g) {
        std::map<std::string, int> counts;
        for (auto& f : g.files) counts[f.error_handling]++;
        return std::max_element(counts.begin(), counts.end(),
            [](auto& a, auto& b){ return a.second < b.second; })->first;
    }

    bool naming_matches(const std::string& code, const std::string& convention) {
        if (convention == "snake_case") {
            std::regex snake(R"(\b[a-z][a-z0-9_]+\b)");
            return std::regex_search(code, snake);
        }
        if (convention == "camelCase") {
            std::regex camel(R"(\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b)");
            return std::regex_search(code, camel);
        }
        return true;
    }

    bool error_style_matches(const std::string& code, const std::string& style) {
        if (style == "exceptions") return code.find("throw") != std::string::npos;
        if (style == "result_type") return code.find("Result") != std::string::npos;
        return false;
    }

    double import_validity_score(const std::string& code, const CodebaseGraph& g) {
        std::set<std::string> known_files;
        for (auto& f : g.files)
            known_files.insert(fs::path(f.path).filename().string());

        std::regex inc(R"(#include\s+\"(.+?)\")");
        int valid = 0, total = 0;
        std::sregex_iterator it(code.begin(), code.end(), inc);
        for (; it != std::sregex_iterator(); ++it, ++total)
            if (known_files.count((*it)[1].str())) ++valid;

        return total > 0 ? (double)valid / total : 1.0;
    }
};
