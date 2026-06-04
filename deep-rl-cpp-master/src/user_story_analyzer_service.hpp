#ifndef USER_STORY_ANALYZER_SERVICE_HPP
#define USER_STORY_ANALYZER_SERVICE_HPP

#include "service/service.hpp"
#include "model/user_story.hpp"

struct StoryAnalysis {
    bool   has_role;
    bool   has_goal;
    bool   has_benefit;
    double format_score;      // 0-1: adherence to "As a / I want / so that" structure
    double alignment_score;   // 0-1: keyword overlap with original requirement; -1 if none provided
    double overall_score;     // weighted combination
    std::string feedback;
};

class UserStoryAnalyzerService : public Service {
public:
    UserStoryAnalyzerService();
    ~UserStoryAnalyzerService();

    std::map<std::string, double> analyze(const std::vector<UserStory>& userStories, const bool isCode = false) const;

    // Story-only analysis: evaluates structure and (optionally) alignment with the
    // original requirement that was used to generate the story.
    std::map<std::string, StoryAnalysis> analyzeStoryOnly(
        const std::vector<UserStory>& stories,
        const std::string& requirement = "") const;
};

#endif // USER_STORY_ANALYZER_SERVICE_HPP
