var exec = require('child_process').exec;
var gruntHelpers = require('../gruntHelpers');
var util = require('util');

var Task = require('../Task.js');

var GruntTask = function(taskName, config, gyroConfig) {
    Task.apply(this, arguments);

    this._gruntCommand = gyroConfig.gruntPath || 'grunt';
};
util.inherits(GruntTask, Task);

GruntTask.prototype.getWatchedGlobs = function() {
    return gruntHelpers.getGlobsForTarget(this._taskName, this._gyroConfig.gruntConfig);
};

GruntTask.prototype.run = function(callback) {
    var self = this;

    var taskCommand = this._gruntCommand + ' ' + (
        this._config.decorator ? this._config.decorator + ':' :
        ''
    ) + this._taskName + (this._gyroConfig.gruntOptions || '');

    var proc = exec(taskCommand, function(err, stdout, stderr) {
        self.setProcess(undefined);

        if (err) {
            self.setError(stderr, stdout);
        } else {
            self.setError(undefined);
        }

        callback(self.getError());
    });
    self.setProcess(proc);

    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
};

module.exports = GruntTask;
