var util = require('util');

var Task = require('../Task.js');

var GruntTask = function() {
    Task.apply(this, arguments);
};
util.inherits(GruntTask, Task);

module.exports = GruntTask;
