#include "user_story_analyzer_service.hpp"
#include "llm_client.hpp"
#include <algorithm>
#include <cctype>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// ── Helpers ────────────────────────────────────────────────────────────────────

static std::string to_lower(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c){ return std::tolower(c); });
    return out;
}

static bool contains(const std::string& haystack, const std::string& needle) {
    return haystack.find(needle) != std::string::npos;
}

// Split into meaningful words (strips punctuation, removes stop words).
static std::set<std::string> meaningful_words(const std::string& text) {
    static const std::set<std::string> stop = {
        "a","an","the","as","i","to","want","need","so","that","in","order",
        "and","or","for","with","my","of","is","be","can","would","like","am",
        "are","it","this","at","by","from","on","do","have","has","we","they"
    };
    std::set<std::string> words;
    std::string word;
    for (unsigned char c : text) {
        if (std::isalpha(c)) {
            word += std::tolower(c);
        } else if (!word.empty()) {
            if (!stop.count(word)) words.insert(word);
            word.clear();
        }
    }
    if (!word.empty() && !stop.count(word)) words.insert(word);
    return words;
}

// Keyword overlap score (intersection / union) between two texts.
static double keyword_overlap(const std::string& a, const std::string& b) {
    auto wa = meaningful_words(a);
    auto wb = meaningful_words(b);
    if (wa.empty() && wb.empty()) return 1.0;
    if (wa.empty() || wb.empty()) return 0.0;

    std::vector<std::string> isect, uni;
    std::set_intersection(wa.begin(), wa.end(), wb.begin(), wb.end(),
                          std::back_inserter(isect));
    std::set_union(wa.begin(), wa.end(), wb.begin(), wb.end(),
                   std::back_inserter(uni));
    return static_cast<double>(isect.size()) / static_cast<double>(uni.size());
}

// ── Service ────────────────────────────────────────────────────────────────────

UserStoryAnalyzerService::UserStoryAnalyzerService() {}
UserStoryAnalyzerService::~UserStoryAnalyzerService() {}

std::map<std::string, double> UserStoryAnalyzerService::analyze(const std::vector<UserStory>& userStories, const bool isCode) const {
    // For now, we'll just return some dummy data. In the future, this function can be implemented to actually analyze the code/user stories
    std::map<std::string, double> results;

    if (isCode) {
        // Analyze code here
        for (const UserStory& story : userStories) {
            results[story.getId()] = 0.5; // Replace with actual analysis logic
        }
    } else {
        // Analyze user stories here
        for (const UserStory& story : userStories) {
            results[story.getId()] = 0.8; // Replace with actual analysis logic
        }
    }

    return results;
}

std::map<std::string, StoryAnalysis>
UserStoryAnalyzerService::analyzeStoryOnly(
    const std::vector<UserStory>& stories,
    const std::string& requirement) const
{
    std::map<std::string, StoryAnalysis> results;

    for (const UserStory& story : stories) {
        const std::string content = story.getContent();
        const std::string lower   = to_lower(content);

        StoryAnalysis sa;

        // ── Format: "As a <role>, I want <goal> [so that <benefit>]" ──────────
        sa.has_role    = contains(lower, "as a") || contains(lower, "as an");
        sa.has_goal    = contains(lower, "i want") || contains(lower, "i need")
                      || contains(lower, "i would like");
        sa.has_benefit = contains(lower, "so that") || contains(lower, "in order to");

        sa.format_score = 0.0;
        if (sa.has_role)    sa.format_score += 0.40;
        if (sa.has_goal)    sa.format_score += 0.40;
        if (sa.has_benefit) sa.format_score += 0.15;
        if (content.size() >= 10) sa.format_score += 0.05;

        // ── Alignment: keyword overlap with the original requirement ──────────
        if (requirement.empty()) {
            sa.alignment_score = -1.0;
            sa.overall_score   = sa.format_score;
        } else {
            sa.alignment_score = keyword_overlap(content, requirement);
            sa.overall_score   = 0.65 * sa.format_score + 0.35 * sa.alignment_score;
        }

        // ── Feedback ──────────────────────────────────────────────────────────
        std::ostringstream fb;
        if (!sa.has_role)
            fb << "Missing actor: start with 'As a <role>'. ";
        if (!sa.has_goal)
            fb << "Missing goal: include 'I want' or 'I need'. ";
        if (!sa.has_benefit)
            fb << "Consider adding 'so that <benefit>' for acceptance context. ";
        if (sa.alignment_score >= 0.0 && sa.alignment_score < 0.25)
            fb << "Low keyword overlap with original requirement — story may not capture intent. ";
        if (fb.str().empty())
            fb << "Story is well-formed.";
        sa.feedback = fb.str();

        results[story.getId()] = sa;
    }

    return results;
}