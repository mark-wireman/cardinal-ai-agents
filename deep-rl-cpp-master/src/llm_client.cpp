#include "llm_client.hpp"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <stdexcept>

using json = nlohmann::json;

namespace {
    size_t write_callback(char* ptr, size_t size, size_t nmemb, std::string* data) {
        data->append(ptr, size * nmemb);
        return size * nmemb;
    }
}

std::string LLMClient::generate(const std::string& prompt) {
    CURL* curl = curl_easy_init();
    if (!curl)
        throw std::runtime_error("Failed to initialise libcurl");

    std::string response_body;

    json payload = {
        {"model",      model_name},
        {"max_tokens", 4096},
        {"messages",   {{ {"role", "user"}, {"content", prompt} }}}
    };
    std::string body = payload.dump();

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, ("x-api-key: " + api_key).c_str());
    headers = curl_slist_append(headers, "anthropic-version: 2023-06-01");
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL,           endpoint.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,    headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,    body.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,     &response_body);

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);

    if (res != CURLE_OK)
        throw std::runtime_error(std::string("curl error: ") + curl_easy_strerror(res));

    auto resp = json::parse(response_body);
    if (resp.contains("error"))
        throw std::runtime_error("API error: " + resp["error"]["message"].get<std::string>());

    return resp["content"][0]["text"].get<std::string>();
}

std::string OllamaClient::generate(const std::string& prompt) {
    CURL* curl = curl_easy_init();
    if (!curl)
        throw std::runtime_error("Failed to initialise libcurl");

    std::string response_body;

    json payload = {
        {"model",    model_name},
        {"stream",   false},
        {"messages", {{ {"role", "user"}, {"content", prompt} }}}
    };
    std::string body = payload.dump();

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    curl_easy_setopt(curl, CURLOPT_URL,           endpoint.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,    headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,    body.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,     &response_body);

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);

    if (res != CURLE_OK)
        throw std::runtime_error(std::string("curl error: ") + curl_easy_strerror(res));

    auto resp = json::parse(response_body);
    if (resp.contains("error"))
        throw std::runtime_error("Ollama error: " + resp["error"].get<std::string>());

    return resp["message"]["content"].get<std::string>();
}

std::string GenericLLMClient::generate(const std::string& prompt) {
    CURL* curl = curl_easy_init();
    if (!curl)
        throw std::runtime_error("Failed to initialise libcurl");

    std::string response_body;
    std::string actual_url = endpoint;

    const bool is_gemini = endpoint.find("googleapis.com") != std::string::npos;
    const bool is_azure  = endpoint.find("openai.azure.com") != std::string::npos;

    // ── Build headers ─────────────────────────────────────────────────────────
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");

    if (is_gemini) {
        // Gemini auth: append key as query param
        if (!token.empty())
            actual_url += (actual_url.find('?') == std::string::npos ? "?key=" : "&key=")
                          + token;
    } else if (is_azure) {
        // Azure auth: api-key header
        if (!token.empty())
            headers = curl_slist_append(headers, ("api-key: " + token).c_str());
    } else {
        // Generic OpenAI-compatible: Bearer token
        if (!token.empty())
            headers = curl_slist_append(headers,
                          ("Authorization: Bearer " + token).c_str());
    }

    // ── Build request body ────────────────────────────────────────────────────
    json payload;
    if (is_gemini) {
        payload = {
            {"contents", {{{"parts", {{{"text", prompt}}}}}}}
        };
    } else {
        payload = {
            {"messages", {{{"role", "user"}, {"content", prompt}}}},
            {"max_tokens", 4096}
        };
        if (!model_name.empty())
            payload["model"] = model_name;
    }
    std::string body = payload.dump();

    curl_easy_setopt(curl, CURLOPT_URL,           actual_url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER,    headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS,    body.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA,     &response_body);

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    curl_slist_free_all(headers);

    if (res != CURLE_OK)
        throw std::runtime_error(std::string("curl error: ") + curl_easy_strerror(res));

    auto resp = json::parse(response_body);
    if (resp.contains("error"))
        throw std::runtime_error("API error: " + resp["error"]["message"].get<std::string>());

    // ── Parse response ────────────────────────────────────────────────────────
    if (is_gemini)
        return resp["candidates"][0]["content"]["parts"][0]["text"].get<std::string>();
    return resp["choices"][0]["message"]["content"].get<std::string>();
}
