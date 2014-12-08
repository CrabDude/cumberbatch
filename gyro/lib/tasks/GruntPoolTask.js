var fork = require('child_process').fork;
var _ = require('lodash');

if (process.env.NODE_IS_CHILD) {
    var grunt = require('grunt');

    var initialized = false;

    process.on('message', function(msg) {
        if (msg.gruntFile && !initialized) {
            require(msg.gruntFile)(grunt);
            initialized = true;
        }

        if (msg.task) {
            grunt.tasks([msg.task], {}, function() {
                process.exit();
            });
        }
    })
} else {
    var gruntHelpers = require('../gruntHelpers');
    var tasks = {};
    var util = require('util');

    var createTask = function(gruntConfigPath) {
        var task = {};

        task.process = fork(__dirname + '/GruntPoolTask.js', {
            env: _.extend({}, process.env, {
                NODE_IS_CHILD: 'true'
            }),
            silent:true
        });

        task.out = '';
        task.err = '';

        task.process.stdout.on('data', function (data) {
            var strData = data.toString();
            task.out += strData + '\n';
            console.log(strData);
        });

        task.process.stderr.on('data', function (data) {
            var strErr = data.toString();
            task.err += strErr + '\n';
            console.error(strErr);
        });

        task.process.send({gruntFile:gruntConfigPath});

        return task;
    };

    var getTask = function(gruntConfigPath) {
        if (!tasks[gruntConfigPath]) {
            tasks[gruntConfigPath] = [];
        }
        return tasks[gruntConfigPath].length ? tasks[gruntConfigPath].shift() : createTask(gruntConfigPath);
    };

    var Task = require('../Task.js');

    var GruntPoolTask = function(taskName, config, gyroConfig) {
        Task.apply(this, arguments);

        this._gruntCommand = gyroConfig.gruntPath || 'grunt';
    };
    util.inherits(GruntPoolTask, Task);

    GruntPoolTask.prototype.getWatchedGlobs = function() {
        return gruntHelpers.getGlobsForTarget(this._taskName, this._gyroConfig.gruntConfig);
    };

    GruntPoolTask.prototype.run = function(callback) {
        var gruntCommand = (
            this._config.decorator ? this._config.decorator + ':' :
            ''
        ) + this._taskName;

        var task = getTask(this._gyroConfig.gruntConfigPath);
        task.process.on('exit', function (code) {
            if (code !== 0) {
                task.err = task.out;
                task.out = '';
            }

            if (task.err.length) {
                this.setError(task.err, task.out);
            } else {
                this.setError(undefined);
            }
            callback(this.getError());
        }.bind(this));

        task.process.send({gruntFile:this._gyroConfig.gruntConfigPath, task:gruntCommand});
    };

    setInterval(function() {
        for (var gruntConfig in tasks) {
            while (tasks[gruntConfig].length < 10) {
                tasks[gruntConfig].push(createTask(gruntConfig));
            }
        }
    }, 1000);

    module.exports = GruntPoolTask;
}
