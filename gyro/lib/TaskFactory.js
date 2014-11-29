var GruntTask = require('./tasks/GruntTask.js');

var TaskFactory = function() {};

TaskFactory.prototype.getGruntTask = function(taskName, taskConfig, gyroConfig) {
    return new GruntTask(taskName, taskConfig, gyroConfig);
};

TaskFactory.prototype.getExecTask = function() {

};

TaskFactory.prototype.getNodeTask = function() {

};

module.exports = new TaskFactory();
