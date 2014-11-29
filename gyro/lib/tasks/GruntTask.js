var gruntHelpers = require('../gruntHelpers');
var util = require('util');

var Task = require('../Task.js');

var GruntTask = function(taskName, config, gyroConfig) {
    Task.apply(this, arguments);
};
util.inherits(GruntTask, Task);

GruntTask.prototype.getWatchedGlobs = function() {
    return gruntHelpers.getGlobsForTarget(this._taskName, this._gyroConfig.gruntConfig);
};

module.exports = GruntTask;
