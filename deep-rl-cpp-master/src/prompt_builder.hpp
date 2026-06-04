#pragma once
#include "code_analyzer.hpp"
#include "prompt_actions.hpp"
#include <sstream>
#include <fstream>
#include <map>

class PromptBuilder {
public:
    // Convert agent's decisions + codebase knowledge → final LLM prompt
    std::string build(const std::string&    user_story,
                      const PromptDecisions& decisions,
                      const CodebaseGraph&   graph) {
        std::ostringstream prompt;

        const std::string& lang = graph.dominant_language.empty()
                                      ? "the project's language"
                                      : graph.dominant_language;

        prompt << "You are a " << lang << " code generation assistant"
               << " embedded in a real software project.\n\n";

        // ── 1. User story ─────────────────────────────────────────────────────
        prompt << "## User Story\n" << user_story << "\n\n";

        // ── 2. Language & libraries ───────────────────────────────────────────
        prompt << "## Language\n"
               << "Write **" << lang << "** only. "
               << "Do not switch languages.\n\n";

        auto libs = collect_libraries(graph);
        if (!libs.empty()) {
            prompt << "## Libraries Already in Use\n";
            for (auto& lib : libs)
                prompt << "- " << lib << "\n";
            prompt << "Do not introduce dependencies not listed above.\n\n";
        }

        // ── 3. Conditionally added sections based on agent decisions ──────────
        for (auto action : decisions.selected_actions) {
            switch (action) {

            case PromptAction::INCLUDE_ARCH_OVERVIEW:
                prompt << "## Architecture\n"
                       << "This codebase follows the **" << graph.dominant_pattern
                       << "** pattern.\n"
                       << "Layers present: controller, service, repository, model.\n\n";
                break;

            case PromptAction::INCLUDE_LAYER_PATTERN:
                prompt << "## Layer Responsibilities\n"
                       << "- **Controller**: Handles HTTP requests, validates input, delegates to service\n"
                       << "- **Service**: Business logic, orchestrates repositories\n"
                       << "- **Repository**: Data access only, no business logic\n"
                       << "- **Model**: Data structures and schema definitions\n\n";
                break;

            case PromptAction::INCLUDE_NAMING_CONVENTION:
                prompt << "## Naming Conventions\n"
                       << "Use **" << decisions.naming_convention << "** for all identifiers.\n"
                       << "Classes: PascalCase. Files: match class name.\n\n";
                break;

            case PromptAction::INCLUDE_ERROR_HANDLING:
                prompt << "## Error Handling\n"
                       << "This codebase uses **" << decisions.error_handling_style << "**.\n"
                       << generate_error_example(decisions.error_handling_style)
                       << "\n\n";
                break;

            case PromptAction::INCLUDE_SIMILAR_FILE:
                prompt << "## Reference Implementation\n"
                       << "Here is a representative file from the same layer:\n"
                       << "```\n"
                       << load_example_file(decisions.example_files, graph)
                       << "```\n\n";
                break;

            case PromptAction::INCLUDE_FILE_STRUCTURE:
                prompt << "## Expected File Structure\n"
                       << generate_file_tree(graph)
                       << "\n\n";
                break;

            case PromptAction::GENERATE_FULL_STACK:
                prompt << "## Scope\n"
                       << "Generate ALL layers: controller, service, repository, and model.\n"
                       << "Each file should be clearly separated with filename comments.\n\n";
                break;

            case PromptAction::GENERATE_WITH_TESTS:
                prompt << "## Tests Required\n"
                       << "Include unit tests for the service layer using the project's test framework.\n\n";
                break;

            default: break;
            }
        }

        // ── 4. Final instruction ──────────────────────────────────────────────
        prompt << "## Task\n"
               << "Generate production-ready **" << lang << "** code for the user story above.\n"
               << "Match the project's style exactly. Do not add libraries not already used.\n"
               << "Output only code with minimal inline comments.\n";

        return prompt.str();
    }

private:
    std::string generate_error_example(const std::string& style) {
        if (style == "exceptions")
            return "```cpp\nthrow std::runtime_error(\"Descriptive error message\");\n```";
        if (style == "result_type")
            return "```cpp\nreturn Result<T>::error(\"Descriptive error message\");\n```";
        return "```cpp\nreturn ErrorCode::INVALID_INPUT;\n```";
    }

    // Collect unique top-level library/header names from all files in the graph
    std::vector<std::string> collect_libraries(const CodebaseGraph& graph) {
        std::map<std::string, int> freq;
        for (auto& f : graph.files)
            for (auto& imp : f.imports)
                if (!imp.empty()) freq[imp]++;
        // Return those seen in more than one file (i.e. project-wide dependencies)
        std::vector<std::string> libs;
        for (auto& [lib, count] : freq)
            if (count > 1) libs.push_back(lib);
        return libs;
    }

    std::string load_example_file(const std::vector<std::string>& candidates,
                                  [[maybe_unused]] const CodebaseGraph& graph) {
        for (auto& path : candidates) {
            std::ifstream f(path);
            if (f.is_open()) {
                std::string content((std::istreambuf_iterator<char>(f)),
                                     std::istreambuf_iterator<char>());
                if (content.size() < 3000) return content;
            }
        }
        return "// No suitable reference found";
    }

    std::string generate_file_tree(const CodebaseGraph& graph) {
        std::map<std::string, int> layers;
        for (auto& f : graph.files) layers[f.layer]++;
        std::ostringstream tree;
        tree << "```\nsrc/\n";
        for (auto& [layer, count] : layers)
            tree << "  ├── " << layer << "/   (" << count << " files)\n";
        tree << "```";
        return tree.str();
    }
};
