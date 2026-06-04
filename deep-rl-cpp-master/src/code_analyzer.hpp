#pragma once
#include <string>
#include <vector>
#include <map>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;

// ── Represents one file's structural fingerprint ─────────────────────────────
struct FileFeatures {
    std::string path;
    std::string layer;           // "controller", "service", "model", "repo", etc.
    std::vector<std::string> imports;
    std::vector<std::string> exports;
    std::vector<std::string> function_names;
    std::vector<std::string> class_names;
    std::string naming_convention; // "camel", "snake", "pascal"
    std::string error_handling;    // "exceptions", "result_type", "error_codes"
    int avg_function_length = 0;
};

// ── Represents the full codebase as a graph ───────────────────────────────────
struct CodebaseGraph {
    std::vector<FileFeatures> files;
    std::map<std::string, std::vector<std::string>> dependency_graph;
    std::map<std::string, std::string> layer_map;   // file → layer
    std::string dominant_pattern;   // "MVC", "layered", "microservice"
    std::string dominant_language;
};

class CodeAnalyzer {
public:
    CodebaseGraph analyze(const std::string& root_path) {
        CodebaseGraph graph;

        for (auto& entry : fs::recursive_directory_iterator(root_path)) {
            if (!entry.is_regular_file()) continue;
            auto ext = entry.path().extension().string();

            if (ext == ".cpp" || ext == ".hpp" ||
                ext == ".ts"  || ext == ".py"  || ext == ".java") {
                auto features = extract_features(entry.path().string());
                graph.files.push_back(features);
                graph.layer_map[features.path] = features.layer;
            }
        }

        graph.dependency_graph  = build_dependency_graph(graph.files);
        graph.dominant_pattern  = infer_architecture(graph.files);
        graph.dominant_language = infer_language(root_path);
        return graph;
    }

private:
    FileFeatures extract_features(const std::string& path) {
        FileFeatures f;
        f.path = path;

        std::ifstream file(path);
        std::string content((std::istreambuf_iterator<char>(file)),
                             std::istreambuf_iterator<char>());

        f.layer             = infer_layer(path, content);
        f.imports           = extract_imports(content);
        f.function_names    = extract_functions(content);
        f.class_names       = extract_classes(content);
        f.naming_convention = detect_naming_convention(f.function_names);
        f.error_handling    = detect_error_handling(content);
        return f;
    }

    std::string infer_layer(const std::string& path, [[maybe_unused]] const std::string& content) {
        if (path.find("controller") != std::string::npos) return "controller";
        if (path.find("service")    != std::string::npos) return "service";
        if (path.find("repository") != std::string::npos) return "repository";
        if (path.find("model")      != std::string::npos) return "model";
        if (path.find("middleware") != std::string::npos) return "middleware";
        if (path.find("util")       != std::string::npos) return "utility";
        return "unknown";
    }

    std::string detect_naming_convention(const std::vector<std::string>& names) {
        int camel = 0, snake = 0, pascal = 0;
        for (auto& n : names) {
            if (n.find('_') != std::string::npos)             ++snake;
            else if (std::isupper(n[0]))                      ++pascal;
            else if (std::any_of(n.begin(), n.end(), ::isupper)) ++camel;
        }
        if (snake > camel && snake > pascal) return "snake_case";
        if (pascal > camel)                  return "PascalCase";
        return "camelCase";
    }

    std::string detect_error_handling(const std::string& content) {
        if (content.find("try")    != std::string::npos &&
            content.find("catch")  != std::string::npos) return "exceptions";
        if (content.find("Result") != std::string::npos ||
            content.find("Either") != std::string::npos) return "result_type";
        if (content.find("errno")  != std::string::npos) return "error_codes";
        return "unknown";
    }

    std::vector<std::string> extract_imports(const std::string& content) {
        std::vector<std::string> imports;
        std::regex import_re(R"(#include\s+[<\"](.+?)[>\"]|import\s+(.+?);|from\s+(.+?)\s+import)");
        std::sregex_iterator it(content.begin(), content.end(), import_re);
        for (; it != std::sregex_iterator(); ++it)
            imports.push_back((*it)[1].str());
        return imports;
    }

    std::vector<std::string> extract_functions(const std::string& content) {
        std::vector<std::string> names;
        std::regex fn_re(R"(\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\()");
        std::sregex_iterator it(content.begin(), content.end(), fn_re);
        for (; it != std::sregex_iterator(); ++it)
            names.push_back((*it)[1].str());
        return names;
    }

    std::vector<std::string> extract_classes(const std::string& content) {
        std::vector<std::string> names;
        std::regex cls_re(R"(class\s+([A-Za-z_][A-Za-z0-9_]*))");
        std::sregex_iterator it(content.begin(), content.end(), cls_re);
        for (; it != std::sregex_iterator(); ++it)
            names.push_back((*it)[1].str());
        return names;
    }

    std::map<std::string, std::vector<std::string>>
    build_dependency_graph(const std::vector<FileFeatures>& files) {
        std::map<std::string, std::vector<std::string>> graph;
        for (auto& f : files)
            graph[f.path] = f.imports;
        return graph;
    }

    std::string infer_language(const std::string& root_path) {
        std::map<std::string, int> ext_counts;
        for (auto& entry : fs::recursive_directory_iterator(root_path)) {
            if (!entry.is_regular_file()) continue;
            ext_counts[entry.path().extension().string()]++;
        }
        // Pick the most common source extension
        static const std::map<std::string, std::string> ext_to_lang = {
            {".cpp", "C++"}, {".hpp", "C++"}, {".cc", "C++"}, {".h", "C++"},
            {".py",  "Python"},
            {".ts",  "TypeScript"}, {".tsx", "TypeScript"},
            {".js",  "JavaScript"}, {".jsx", "JavaScript"},
            {".java","Java"},
            {".rs",  "Rust"},
            {".go",  "Go"},
        };
        std::string best_lang;
        int best_count = 0;
        for (auto& [ext, count] : ext_counts) {
            auto it = ext_to_lang.find(ext);
            if (it != ext_to_lang.end() && count > best_count) {
                best_count = count;
                best_lang  = it->second;
            }
        }
        return best_lang.empty() ? "unknown" : best_lang;
    }

    std::string infer_architecture(const std::vector<FileFeatures>& files) {
        std::map<std::string, int> layer_counts;
        for (auto& f : files) layer_counts[f.layer]++;
        if (layer_counts["controller"] > 0 && layer_counts["model"] > 0)
            return "MVC";
        if (layer_counts["service"] > 0 && layer_counts["repository"] > 0)
            return "layered";
        return "unknown";
    }
};
