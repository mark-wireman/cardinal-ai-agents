#ifndef CONTROLLER_CONTROLLER_HPP
#define CONTROLLER_CONTROLLER_HPP

#include "service/service.hpp"
#include "model/user_story.hpp"

class Controller : public ServiceController {
public:
    Controller();
    ~Controller();

    void displayAnalyzerMenu() const;
    std::map<std::string, double> analyzeUserStories(const bool isCode) const;

private:
};

#endif // CONTROLLER_CONTROLLER_HPP