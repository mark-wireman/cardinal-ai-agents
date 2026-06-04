#pragma once
#include <string>
#include <stdexcept>

// Note: Requires libcurl and nlohmann/json
// Install: apt-get install libcurl4-openssl-dev
//          vcpkg install nlohmann-json
//
// Link flags: -lcurl

// Forward declarations to avoid header dependency in this file
// Include <curl/curl.h> and <nlohmann/json.hpp> in your .cpp

class LLMClient {
    std::string api_key;
    std::string endpoint;
    std::string model_name;

public:
    LLMClient(const std::string& key,
              const std::string& url   = "https://api.anthropic.com/v1/messages",
              const std::string& model = "claude-sonnet-4-20250514")
        : api_key(key), endpoint(url), model_name(model)
    {
        if (key.empty())
            throw std::invalid_argument("An Anthropic API key is required.");
    }

    // Send prompt to Claude, return generated text.
    // Implementation lives in llm_client.cpp to avoid pulling curl into every TU.
    std::string generate(const std::string& prompt);

    const std::string& get_model()    const { return model_name; }
    const std::string& get_endpoint() const { return endpoint;   }
};

// Ollama client — no API key required; runs against a local Ollama server.
// Default endpoint: http://localhost:11434/api/chat
class OllamaClient {
    std::string endpoint;
    std::string model_name;

public:
    OllamaClient(const std::string& model = "llama3",
                 const std::string& url   = "http://localhost:11434/api/chat")
        : endpoint(url), model_name(model) {}

    // Send prompt to Ollama, return generated text.
    std::string generate(const std::string& prompt);

    const std::string& get_model()    const { return model_name; }
    const std::string& get_endpoint() const { return endpoint;   }
};

// Generic LLM client — accepts any model endpoint URL and an optional auth token.
//
// Supported endpoint families (auto-detected from the URL):
//   Azure OpenAI  — url contains "openai.azure.com"
//                   auth header:  api-key: <token>
//                   request body: OpenAI messages format
//                   response:     choices[0].message.content
//
//   Google Gemini — url contains "googleapis.com"
//                   auth:         ?key=<token> appended to URL
//                   request body: Gemini contents/parts format
//                   response:     candidates[0].content.parts[0].text
//
//   Generic       — any other URL (OpenAI-compatible APIs, custom endpoints)
//                   auth header:  Authorization: Bearer <token>  (omitted if token is empty)
//                   request body: OpenAI messages format
//                   response:     choices[0].message.content
//
// The token defaults to an empty string (anonymous access).
// An optional model name is included in the request body when provided.
class GenericLLMClient {
    std::string endpoint;
    std::string token;
    std::string model_name;

public:
    GenericLLMClient(const std::string& url,
                     const std::string& tok   = "",
                     const std::string& model = "")
        : endpoint(url), token(tok), model_name(model) {}

    // Send prompt to the configured endpoint, return generated text.
    std::string generate(const std::string& prompt);

    const std::string& get_endpoint() const { return endpoint;   }
    const std::string& get_token()    const { return token;      }
    const std::string& get_model()    const { return model_name; }
};
