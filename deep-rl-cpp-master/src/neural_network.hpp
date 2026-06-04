#pragma once
#include <vector>
#include <random>
#include <cmath>
#include <cassert>
#include <stdexcept>

using Matrix = std::vector<std::vector<double>>;
using Vector = std::vector<double>;

// ── Activation functions ──────────────────────────────────────────────────────
inline double relu(double x)        { return x > 0.0 ? x : 0.0; }
inline double relu_grad(double x)   { return x > 0.0 ? 1.0 : 0.0; }

// ── Single fully-connected layer ──────────────────────────────────────────────
struct Layer {
    Matrix weights;   // [out_size][in_size]
    Vector biases;    // [out_size]
    Matrix dW;        // weight gradients
    Vector db;        // bias gradients
    Vector input;     // cached for backprop
    Vector output;    // cached for backprop

    int in_size, out_size;

    Layer(int in, int out) : in_size(in), out_size(out) {
        // He initialization (good for ReLU)
        std::mt19937 rng(std::random_device{}());
        double std_dev = std::sqrt(2.0 / in);
        std::normal_distribution<double> dist(0.0, std_dev);

        weights.assign(out, Vector(in));
        biases.assign(out, 0.0);
        dW.assign(out, Vector(in, 0.0));
        db.assign(out, 0.0);

        for (auto& row : weights)
            for (auto& w : row)
                w = dist(rng);
    }

    // Forward pass — ReLU on all layers except the final one
    Vector forward(const Vector& in, bool use_relu = true) {
        assert((int)in.size() == in_size);
        input = in;
        output.resize(out_size);

        for (int i = 0; i < out_size; ++i) {
            double sum = biases[i];
            for (int j = 0; j < in_size; ++j)
                sum += weights[i][j] * in[j];
            output[i] = use_relu ? relu(sum) : sum;
        }
        return output;
    }

    // Backward pass — returns gradient w.r.t. input
    Vector backward(const Vector& grad_out, bool use_relu = true) {
        assert((int)grad_out.size() == out_size);
        Vector grad_in(in_size, 0.0);

        for (int i = 0; i < out_size; ++i) {
            double delta = grad_out[i];
            if (use_relu) delta *= relu_grad(output[i]);

            db[i] += delta;
            for (int j = 0; j < in_size; ++j) {
                dW[i][j]  += delta * input[j];
                grad_in[j] += delta * weights[i][j];
            }
        }
        return grad_in;
    }
};

// ── Multi-layer neural network ────────────────────────────────────────────────
class NeuralNetwork {
public:
    std::vector<Layer> layers;
    double lr;  // learning rate

    // topology: {state_size, hidden1, hidden2, action_size}
    NeuralNetwork(const std::vector<int>& topology, double learning_rate = 1e-3)
        : lr(learning_rate)
    {
        for (size_t i = 0; i + 1 < topology.size(); ++i)
            layers.emplace_back(topology[i], topology[i + 1]);
    }

    // Forward pass — last layer has NO activation (raw Q-values)
    Vector forward(const Vector& state) {
        Vector x = state;
        for (size_t i = 0; i < layers.size(); ++i)
            x = layers[i].forward(x, /*use_relu=*/ i + 1 < layers.size());
        return x;  // shape: [num_actions]
    }

    // Backprop + SGD update
    void backward(const Vector& loss_grad) {
        Vector grad = loss_grad;
        for (int i = (int)layers.size() - 1; i >= 0; --i)
            grad = layers[i].backward(grad, /*use_relu=*/ i + 1 < (int)layers.size());
        apply_gradients();
    }

    // SGD step and gradient reset
    void apply_gradients() {
        for (auto& layer : layers) {
            for (int i = 0; i < layer.out_size; ++i) {
                layer.biases[i] -= lr * layer.db[i];
                layer.db[i] = 0.0;
                for (int j = 0; j < layer.in_size; ++j) {
                    layer.weights[i][j] -= lr * layer.dW[i][j];
                    layer.dW[i][j] = 0.0;
                }
            }
        }
    }

    // Hard copy weights → target network
    void copy_weights_to(NeuralNetwork& target) const {
        assert(layers.size() == target.layers.size());
        for (size_t i = 0; i < layers.size(); ++i) {
            target.layers[i].weights = layers[i].weights;
            target.layers[i].biases  = layers[i].biases;
        }
    }
};
