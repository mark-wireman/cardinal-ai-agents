#pragma once
#include <vector>
#include <deque>
#include <random>
#include <algorithm>
#include <numeric>

struct Experience {
    std::vector<double> state;
    int                 action;
    double              reward;
    std::vector<double> next_state;
    bool                done;
};

class ReplayBuffer {
    std::deque<Experience> buffer;
    size_t capacity;
    std::mt19937 rng;

public:
    explicit ReplayBuffer(size_t cap = 10000)
        : capacity(cap), rng(std::random_device{}()) {}

    void push(const Experience& e) {
        if (buffer.size() >= capacity)
            buffer.pop_front();
        buffer.push_back(e);
    }

    // Random mini-batch sample
    std::vector<Experience> sample(size_t batch_size) {
        std::vector<Experience> batch;
        batch.reserve(batch_size);

        std::vector<size_t> indices(buffer.size());
        std::iota(indices.begin(), indices.end(), 0);
        std::shuffle(indices.begin(), indices.end(), rng);

        for (size_t i = 0; i < batch_size && i < indices.size(); ++i)
            batch.push_back(buffer[indices[i]]);
        return batch;
    }

    size_t size() const { return buffer.size(); }
    bool   ready(size_t batch_size) const { return buffer.size() >= batch_size; }
};
