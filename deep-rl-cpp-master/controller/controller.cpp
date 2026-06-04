#include "controller/controller.hpp"
#include "user_story_analyzer_service.hpp"
#include <iostream>

Controller::Controller() {}
Controller::~Controller() {}

void Controller::displayAnalyzerMenu() const {
    std::cout << "Select analysis type:" << std::endl;
    std::cout << "1. Code" << std::endl;
    std::cout << "2. User stories" << std::endl;

    int choice;
    std::cin >> choice;

    if (choice == 1) {
        analyzeUserStories(true);
    } else if (choice == 2) {
        analyzeUserStories(false);
    }
}

std::map<std::string, double> Controller::analyzeUserStories(const bool isCode) const {
    UserStoryAnalyzerService userStoryAnalyzerService;

    std::vector<UserStory> userStories;
    // Assume we have a list of user stories available

    return userStoryAnalyzerService.analyze(userStories, isCode);
}