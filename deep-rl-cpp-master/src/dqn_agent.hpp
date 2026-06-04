#pragma once
#include "neural_network.hpp"
#include "replay_buffer.hpp"
#include <algorithm>
#include <iostream>

class DQNAgent {
public:
    int state_size;
    int action_size;

    // ── Hyperparameters ───────────────────────────────────────────────────────
    double gamma;          // discount factor
    double epsilon;        // exploration rate
    double epsilon_min;
    double epsilon_decay;
    size_t batch_size;
    int    target_update_freq;  // steps between target network syncs
    int    step_count = 0;

    // ── Networks ──────────────────────────────────────────────────────────────
    NeuralNetwork online_net;   // trained every step
    NeuralNetwork target_net;   // updated periodically (stable Q-targets)

    ReplayBuffer memory;
    std::mt19937 rng;

    // ─────────────────────────────────────────────────────────────────────────
    DQNAgent(int state_sz, int action_sz,
             double lr              = 1e-3,
             double gamma_          = 0.99,
             double eps_start       = 1.0,
             double eps_min         = 0.01,
             double eps_decay       = 0.995,
             size_t batch           = 64,
             size_t buf_capacity    = 10000,
             int    tgt_upd_freq    = 100)
        : state_size(state_sz),
          action_size(action_sz),
          gamma(gamma_),
          epsilon(eps_start),
          epsilon_min(eps_min),
          epsilon_decay(eps_decay),
          batch_size(batch),
          target_update_freq(tgt_upd_freq),
          online_net({state_sz, 128, 128, action_sz}, lr),
          target_net({state_sz, 128, 128, action_sz}, lr),
          memory(buf_capacity),
          rng(std::random_device{}())
    {
        // Start target net as a copy of online net
        online_net.copy_weights_to(target_net);
    }

    // ── Q-value query ─────────────────────────────────────────────────────────
    // Returns Q(state, *) — one value per action
    Vector get_q_values(const Vector& state) {
        return online_net.forward(state);
    }

    // Returns Q(state, action) — scalar
    double get_q_value(const Vector& state, int action) {
        auto q_vals = get_q_values(state);
        return q_vals[action];
    }

    // ── Action selection (ε-greedy) ───────────────────────────────────────────
    int select_action(const Vector& state) {
        std::uniform_real_distribution<double> prob(0.0, 1.0);
        if (prob(rng) < epsilon) {
            // Explore: random action
            std::uniform_int_distribution<int> action_dist(0, action_size - 1);
            return action_dist(rng);
        }
        // Exploit: action with highest Q-value
        auto q_vals = get_q_values(state);
        return (int)(std::max_element(q_vals.begin(), q_vals.end()) - q_vals.begin());
    }

    // ── Store experience ──────────────────────────────────────────────────────
    void remember(const Vector& state, int action, double reward,
                  const Vector& next_state, bool done) {
        memory.push({state, action, reward, next_state, done});
    }

    // ── Core DQN training step ────────────────────────────────────────────────
    double train_step() {
        if (!memory.ready(batch_size)) return 0.0;

        auto batch = memory.sample(batch_size);
        double total_loss = 0.0;

        for (auto& exp : batch) {
            // ── 1. Compute TD target using the TARGET network ─────────────────
            double td_target;
            if (exp.done) {
                td_target = exp.reward;
            } else {
                // Q*(s', a') from stable target net
                auto next_q = target_net.forward(exp.next_state);
                double max_next_q = *std::max_element(next_q.begin(), next_q.end());
                td_target = exp.reward + gamma * max_next_q;
            }

            // ── 2. Get current Q-values from ONLINE network ───────────────────
            auto current_q = online_net.forward(exp.state);
            double predicted_q = current_q[exp.action];

            // ── 3. Compute MSE loss on the chosen action's Q-value ────────────
            double error = td_target - predicted_q;
            double loss  = error * error;
            total_loss  += loss;

            // ── 4. Build loss gradient (zero for non-chosen actions) ──────────
            Vector loss_grad(action_size, 0.0);
            loss_grad[exp.action] = -2.0 * error;  // d(MSE)/d(Q_pred)

            // ── 5. Backprop through online network ────────────────────────────
            online_net.backward(loss_grad);
        }

        // ── 6. Decay exploration rate ─────────────────────────────────────────
        epsilon = std::max(epsilon_min, epsilon * epsilon_decay);

        // ── 7. Periodically sync target network ───────────────────────────────
        if (++step_count % target_update_freq == 0) {
            online_net.copy_weights_to(target_net);
            std::cout << "[Target net synced at step " << step_count << "]\n";
        }

        return total_loss / batch_size;
    }
};
