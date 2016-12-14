var exec = require('child_process').exec;
var util = require('util');
var fs = require('fs');

var Task = require('../Task.js');

var ExecTask = function(taskName, config, gyroConfig) {
    Task.apply(this, arguments);
};
util.inherits(ExecTask, Task);

ExecTask.prototype.getWatchedGlobs = function() {
    return this._config.watchedGlobs.map(function(path) {
        return { src: path };
    }) || [];
};

ExecTask.prototype.run = function(callback) {
    var self = this;

    var taskCommand = this._config.command;

    var options = {
        cwd: this._config.cwd,
        logFile: this._config.logFile,
        logOnlyOnFail: this._config.logOnlyOnFail
    };

    console.warn('About to execute: ' + taskCommand);

    var proc = exec(taskCommand, options, function(err, stdout, stderr) {
        console.warn('Finished executing: ' + taskCommand);
        self.setProcess(undefined);

        if (err) {
            self.setError(stderr, stdout);
        } else {
            // if we logged to a file and there were no errors
            if (options.logFile && options.logOnlyOnFail) {
                fs.unlinkSync(options.logFile);
            }
            self.setError(undefined);
        }

        callback(self.getError());
    });
    self.setProcess(proc);

    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
    
    if (options.logFile) {
        var writeStream = fs.createWriteStream(options.logFile);
        proc.stdout.pipe(writeStream);
        proc.stderr.pipe(writeStream);
    }
};

module.exports = ExecTask;
