#pragma once
#include <map>
#include <string>
#include <vector>

class Service {
public:
    virtual ~Service() = default;
};

class ServiceController {
public:
    virtual ~ServiceController() = default;
};
