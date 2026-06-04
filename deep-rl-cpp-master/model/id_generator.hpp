#pragma once
#include <functional>
#include <string>

class IdGenerator {
public:
    std::string generateId(const std::string& title) {
        return std::to_string(std::hash<std::string>{}(title));
    }
};
