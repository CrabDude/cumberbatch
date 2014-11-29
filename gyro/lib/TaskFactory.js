var GruntTask = require('./tasks/GruntTask.js');

var TaskFactory = function() {};

TaskFactory.prototype.getGruntTask = function(options) {
    return new GruntTask(options);
};

TaskFactory.prototype.getExecTask = function() {

};

TaskFactory.prototype.getNodeTask = function() {

};

module.exports = new TaskFactory();
