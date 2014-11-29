var _ = require('lodash');
var colors = require('colors');

var TaskState = require('./TaskState');

module.exports.initDefaultListeners = function() {
    var taskManager = this;

    var renderTaskErrors = function() {
        var stateData = taskManager.getTaskStates();
        var taskNames = Object.keys(stateData);

        // for each task, log out any error data that's floating around
        for (var i = 0; i < taskNames.length; i++) {
            taskName = taskNames[i];
            var taskData = stateData[taskName];

            if (typeof taskData.errorData !== 'undefined') {
                console.log(('ERROR: ' + taskName + '\n').redBG.bold.black);
                if (taskData.errorData.stdout) {
                    console.log(('>>> stdout').yellowBG.bold.black);
                    console.log(taskData.errorData.stdout);
                }
                if (taskData.errorData.stderr) {
                    console.log(('>>> stderr').yellowBG.bold.black);
                    console.log(taskData.errorData.stderr);
                }
            }
        }
    }.bind(this);

    renderTaskErrors = _.throttle(renderTaskErrors, 5000, {
        'trailing': true
    });

    var renderTaskStates = (function() {
        var lastOutput = '';

        return function() {
            // retrieve the current task state
            var stateData = taskManager.getTaskStates();
            var taskNames = Object.keys(stateData);
            var tagOutputs = {};
            var tagStates = {};
            var tag;
            var hasErrors = false;
            var hasInProgress = false;

            // sort tasks by number of dependencies, this is an approximation of order ran
            taskNames.sort(function (a, b) {
                var aDeps = stateData[a].dependencies;
                var bDeps = stateData[b].dependencies;

                if (aDeps.indexOf(b) !== -1) return 1;
                if (bDeps.indexOf(a) !== -1) return -1;

                return aDeps.length - bDeps.length;
            });

            // for each task, create the renderable output and add to all appropriate tag buckets
            for (var i = 0; i < taskNames.length; i++) {
                taskName = taskNames[i];
                var taskData = stateData[taskName];

                var taskOutput = taskName;
                if (typeof taskData.lastRunMs !== 'undefined' && taskData.lastRunMs > 3000) {
                    // if the tag has a duration over 3 seconds, add it to the output
                    taskOutput += ' (' + taskData.lastRunMs + 'ms!!)';
                }

                // format the task output string based on state
                switch (taskData.state) {
                    case TaskState.INITIALIZING:
                    case TaskState.PENDING:
                        taskOutput = taskOutput.grey;
                        break;
                    case TaskState.IN_PROGRESS:
                    case TaskState.IN_PROGRESS_MUST_RERUN:
                        taskOutput = taskOutput.yellowBG.bold.black;
                        hasInProgress = true;
                        break;
                    case TaskState.FAILED:
                        taskOutput = taskOutput.redBG.bold.black;
                        break;
                    case TaskState.SUCCEEDED:
                        taskOutput = taskOutput.greenBG.bold.black;
                        break;
                }

                // add the task to each of the tag buckets
                for (var j = 0; j < taskData.tags.length; j++) {
                    tag = taskData.tags[j];

                    if (typeof tagOutputs[tag] === 'undefined') {
                        // if the tag hasn't been seen, set up the outputs array and mark
                        // it as initially successful
                        tagOutputs[tag] = [];
                        tagStates[tag] = TaskState.SUCCEEDED;
                    }

                    tagOutputs[tag].push(taskOutput);
                    if (taskData.state === TaskState.FAILED) {
                        // one failed state fails them all
                        tagStates[tag] = TaskState.FAILED;
                    } else if (taskData.state !== TaskState.SUCCEEDED) {
                        // any non-successful states mean the tasks for the tag are in progress
                        tagStates[tag] = TaskState.IN_PROGRESS;
                    }
                }

                if (typeof taskData.errorData !== 'undefined') {
                    hasErrors = true;
                }
            }

            var output = '';
            for (tag in tagOutputs) {
                var prefix = "---------" + tag.toUpperCase() + "---------";
                switch(tagStates[tag]) {
                    case TaskState.SUCCEEDED:
                        prefix = prefix.greenBG.black.bold;
                        break;
                    case TaskState.FAILED:
                        prefix = prefix.redBG.black.bold;
                        break;
                    default:
                        prefix = prefix.yellowBG.black.bold;
                }

                output += prefix + "\n".blackBG + tagOutputs[tag].join(' ') + "\n\n".blackBG;
            }

            if (output !== lastOutput) {
                console.log("\n\n" + output);
                lastOutput = output;
            }

            if (hasErrors === true && hasInProgress === false) {
                renderTaskErrors();
            }
        };
    })();

    renderTaskStates = _.throttle(renderTaskStates, 1000, {
        'trailing': true
    });

    this.on('taskStateChange', function (taskName, oldState, newState) {
        renderTaskStates();
    });
};
