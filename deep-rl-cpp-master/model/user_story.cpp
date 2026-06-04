#include "user_story.hpp"
#include "id_generator.hpp"

UserStory::UserStory(const std::string& /*id*/, const std::string& title)
    : storyId_(idGen_.generateId(title)), content_(title) {}
UserStory::~UserStory() {}

std::string UserStory::getId() const {
    return storyId_;
}

std::string UserStory::getContent() const {
    return content_;
}