var Task = function(options) {
    this._duration = null;
    this._options = options;
    this._error = undefined;
};

Task.prototype.getWatchedGlobs = function () {

};

Task.prototype.run = function() {

};

Task.prototype.setState = function() {

};

Task.prototype.getState = function() {

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

Task.prototype.getProcessIds = function() {

};

Task.prototype.setLastDuration = function(duration) {
    this._duration = duration;
}

Task.prototype.getLastDuration = function() {
    return this._duration;
};

Task.prototype.getTags = function() {
    return this._options.tags || ['uncategorized'];
};

module.exports = Task;
