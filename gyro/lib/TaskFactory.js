var GruntPoolTask = require('./tasks/GruntPoolTask.js');
var GruntTask = require('./tasks/GruntTask.js');
var NodeTask = require('./tasks/NodeTask.js');

var TaskFactory = function() {};

TaskFactory.prototype.getGruntTask = function(taskName, taskConfig, gyroConfig) {
    return new GruntTask(taskName, taskConfig, gyroConfig);
};

TaskFactory.prototype.getGruntPoolTask = function(taskName, taskConfig, gyroConfig) {
    return new GruntPoolTask(taskName, taskConfig, gyroConfig);
};

TaskFactory.prototype.getNodeTask = function(taskName, taskConfig, gyroConfig) {
    return new NodeTask(taskName, taskConfig, gyroConfig);
};

TaskFactory.prototype.getTask = function (taskName, taskConfig, gyroConfig) {
    switch (taskConfig.taskType) {
        case "grunt":
            return this.getGruntTask(taskName, taskConfig, gyroConfig);
        case "gruntPool":
            return this.getGruntPoolTask(taskName, taskConfig, gyroConfig);
        case "node":
            return this.getNodeTask(taskName, taskConfig, gyroConfig);
        default:
            throw new Error('Unknown task type: ' + taskConfig.taskType);
    }
}

module.exports = new TaskFactory();
