#pragma once
#include <string>
#include <vector>
#include <map>

// Each action = one prompt construction decision
enum class PromptAction {
    // Architectural context
    INCLUDE_ARCH_OVERVIEW     = 0,
    INCLUDE_LAYER_PATTERN     = 1,
    INCLUDE_DEPENDENCY_GRAPH  = 2,

    // Style guidance
    INCLUDE_NAMING_CONVENTION = 3,
    INCLUDE_ERROR_HANDLING    = 4,
    INCLUDE_FILE_STRUCTURE    = 5,

    // Code examples
    INCLUDE_SIMILAR_FILE      = 6,
    INCLUDE_INTERFACE_DEF     = 7,
    INCLUDE_TEST_EXAMPLE      = 8,

    // Scope control
    GENERATE_CONTROLLER_ONLY  = 9,
    GENERATE_FULL_STACK       = 10,
    GENERATE_WITH_TESTS       = 11,

    ACTION_COUNT              = 12
};

struct PromptDecisions {
    std::vector<PromptAction> selected_actions;
    std::string architecture_pattern;
    std::string naming_convention;
    std::string error_handling_style;
    std::vector<std::string> example_files;
    bool include_tests = false;
    bool full_stack    = false;
};
