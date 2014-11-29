var Task = function(taskName, config, gyroConfig) {
    this._config = config;
    this._dependencies = [];
    this._dependents = [];
    this._duration = undefined;
    this._error = undefined;
    this._gyroConfig = gyroConfig;
    this._isEmpty = false;
    this._nextRunMs = undefined;
    this._process = undefined;
    this._state = undefined;
    this._taskName = taskName;
};

Task.prototype.setDependents = function (deps) {
    this._dependents = deps;
};

Task.prototype.getDependents = function () {
    return this._dependents;
};

Task.prototype.setDependencies = function (deps) {
    this._dependencies = deps;
};

Task.prototype.getDependencies = function () {
    return this._dependencies;
};

Task.prototype.isEmpty = function() {
    return this._isEmpty;
};

Task.prototype.setEmpty = function(isEmpty) {
    this._isEmpty = isEmpty;
};

Task.prototype.setState = function(state) {
    this._state = state;
};

Task.prototype.getState = function() {
    return this._state;
};

Task.prototype.setNextRunMs = function(ms) {
    this._nextRunMs = ms;
};

Task.prototype.getNextRunMs = function() {
    return this._nextRunMs;
};

Task.prototype.setError = function(stderr, stdout) {
    if (typeof stderr === 'undefined') {
        delete this._error;
    } else {
        this._error = {
            stderr: stderr,
            stdout: stdout
        };
    }
};

Task.prototype.getError = function() {
    return this._error;
};

Task.prototype.setProcess = function(proc) {
    this._process = proc;
};

Task.prototype.getProcess = function() {
    return this._process;
};

Task.prototype.setLastDuration = function(duration) {
    this._duration = duration;
}

Task.prototype.getLastDuration = function() {
    return this._duration;
};

Task.prototype.getTags = function() {
    return this._config.tags || ['uncategorized'];
};

Task.prototype.getConfig = function() {
    return this._config;
};

module.exports = Task;
