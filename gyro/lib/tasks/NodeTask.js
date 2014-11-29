var exec = require('child_process').exec;
var gruntHelpers = require('../gruntHelpers');
var util = require('util');

var Task = require('../Task.js');

var NodeTask = function(taskName, config, gyroConfig) {
    Task.apply(this, arguments);
};
util.inherits(NodeTask, Task);

NodeTask.prototype.getWatchedGlobs = function() {
    return gruntHelpers.getGlobsForTarget(this._taskName, this._gyroConfig.gruntConfig);
};

NodeTask.prototype.run = function(callback) {
    var self = this;

    this._config._run(this._config, this._gyroConfig, function(err, data) {
        if (err) {
            self.setError(err.stack + '', '');
        } else {
            self.setError(undefined);
        }
        callback(self.getError());
    });
};

module.exports = NodeTask;
