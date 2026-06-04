#pragma once
#include "code_analyzer.hpp"
#include <vector>
#include <map>
#include <algorithm>

class StateEncoder {
public:
    // Encode the full codebase graph into a flat float vector the RL agent reads
    std::vector<double> encode(const CodebaseGraph& graph,
                               const std::string& user_story_keywords) {
        std::vector<double> state;

        // ── Architectural features (10 dims) ─────────────────────────────────
        state.push_back(one_hot_pattern(graph.dominant_pattern));
        state.push_back(layer_coverage(graph, "controller"));
        state.push_back(layer_coverage(graph, "service"));
        state.push_back(layer_coverage(graph, "repository"));
        state.push_back(layer_coverage(graph, "model"));
        state.push_back((double)graph.files.size() / 100.0);
        state.push_back(avg_file_complexity(graph));
        state.push_back(dependency_depth(graph));
        state.push_back(naming_consistency_score(graph));
        state.push_back(error_handling_score(graph));

        // ── User story context (10 dims) ──────────────────────────────────────
        auto kw = encode_keywords(user_story_keywords);
        state.insert(state.end(), kw.begin(), kw.end());

        return state;  // 20-dimensional state vector
    }

private:
    double one_hot_pattern(const std::string& pattern) {
        if (pattern == "MVC")          return 1.0;
        if (pattern == "layered")      return 0.5;
        if (pattern == "microservice") return 0.25;
        return 0.0;
    }

    double layer_coverage(const CodebaseGraph& g, const std::string& layer) {
        int count = 0;
        for (auto& f : g.files)
            if (f.layer == layer) ++count;
        return (double)count / std::max((int)g.files.size(), 1);
    }

    double avg_file_complexity(const CodebaseGraph& g) {
        double total = 0;
        for (auto& f : g.files) total += f.function_names.size();
        return (total / std::max(g.files.size(), (size_t)1)) / 20.0;
    }

    double dependency_depth(const CodebaseGraph& g) {
        return std::min((double)g.dependency_graph.size() / 50.0, 1.0);
    }

    double naming_consistency_score(const CodebaseGraph& g) {
        std::map<std::string, int> counts;
        for (auto& f : g.files) counts[f.naming_convention]++;
        auto max_it = std::max_element(counts.begin(), counts.end(),
            [](auto& a, auto& b){ return a.second < b.second; });
        return max_it != counts.end()
            ? (double)max_it->second / g.files.size() : 0.0;
    }

    double error_handling_score(const CodebaseGraph& g) {
        std::map<std::string, int> counts;
        for (auto& f : g.files) counts[f.error_handling]++;
        if (counts["exceptions"]  > 0) return 1.0;
        if (counts["result_type"] > 0) return 0.75;
        if (counts["error_codes"] > 0) return 0.5;
        return 0.0;
    }

    // Keyword matching against known domain terms (10-dim one-hot)
    std::vector<double> encode_keywords(const std::string& story) {
        std::vector<std::string> known = {
            "create", "update", "delete", "fetch", "list",
            "auth",   "notify", "report", "upload", "search"
        };
        std::vector<double> vec(known.size(), 0.0);
        for (size_t i = 0; i < known.size(); ++i)
            if (story.find(known[i]) != std::string::npos)
                vec[i] = 1.0;
        return vec;
    }
};
