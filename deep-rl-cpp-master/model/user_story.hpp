#ifndef MODEL_USER_STORY_HPP
#define MODEL_USER_STORY_HPP

#include <string>
#include "id_generator.hpp"

class UserStory {
public:
    UserStory(const std::string& id, const std::string& title);
    ~UserStory();

    std::string getId() const;
    std::string getContent() const;
private:
    IdGenerator idGen_;
    std::string storyId_;
    std::string content_;
};

#endif // MODEL_USER_STORY_HPP