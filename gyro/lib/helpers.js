var _ = require('lodash');
var colors = require('colors');

var TaskState = require('./TaskState');

module.exports.initDefaultListeners = function(anchorFn) {
    var taskManager = this;
    if (anchorFn === undefined) {
        anchorFn = console.log.bind(console);
    }

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
            var i;

            // sort tasks by number of dependencies, this is an approximation of order ran
            taskNames.sort(function (a, b) {
                var aDeps = stateData[a].dependencies;
                var bDeps = stateData[b].dependencies;

                if (aDeps.indexOf(b) !== -1) return 1;
                if (bDeps.indexOf(a) !== -1) return -1;

                return aDeps.length - bDeps.length;
            });

            var taskGroupings = [];
            var taskGroupingMap = {};
            for (i = 0; i < taskNames.length; i++) {
                var taskName = taskNames[i];
                var taskData = stateData[taskName];
                var taskGroup = taskData.groupAs || taskName;

                if (taskGroupingMap[taskGroup] === undefined) {
                    taskGroupingMap[taskGroup] = taskGroupings.length;
                    taskGroupings.push({
                        name: taskGroup,
                        data: []
                    });
                }

                var taskGroupData = taskGroupings[taskGroupingMap[taskGroup]];
                taskGroupData.data.push(taskData);
            }

            // for each task, create the renderable output and add to all appropriate tag buckets
            for (i = 0; i < taskGroupings.length; i++) {
                var taskGroupData = taskGroupings[i];
                var taskState, taskLastRunMs, taskTags;

                for (var j = 0; j < taskGroupData.data.length; j++) {
                    var taskData = taskGroupData.data[j];

                    // set state
                    if (taskState === undefined ||
                            taskState !== TaskState.IN_PROGRESS ||
                            taskState !== TaskState.IN_PROGRESS_MUST_RERUN ||
                            taskState !== TaskState.FAILED) {
                        taskState = taskData.state;
                    }

                    // set max run ms
                    if (taskLastRunMs === undefined ||
                            (taskData.lastRunMs !== undefined && taskData.lastRunMs > taskLastRunMs)) {
                        taskLastRunMs = taskData.lastRunMs;
                    }

                    // set tags
                    taskTags = taskData.tags;

                    if (typeof taskData.errorData !== 'undefined') {
                        hasErrors = true;
                    }
                }

                var taskOutput = taskGroupData.name;
                if (typeof taskLastRunMs !== 'undefined' && taskLastRunMs >= 0) {
                    // if the tag has a duration over 3 seconds, add it to the output
                    taskOutput += ' (' + taskLastRunMs + 'ms!!)';
                }

                // format the task output string based on state
                switch (taskState) {
                    case TaskState.INITIALIZING:
                    case TaskState.PENDING:
                        taskOutput = taskOutput.grey;
                        break;
                    case TaskState.IN_PROGRESS:
                    case TaskState.IN_PROGRESS_MUST_RERUN:
                        taskOutput = taskOutput.blueBG.bold.white;
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
                for (var j = 0; j < taskTags.length; j++) {
                    tag = taskTags;

                    if (typeof tagOutputs[tag] === 'undefined') {
                        // if the tag hasn't been seen, set up the outputs array and mark
                        // it as initially successful
                        tagOutputs[tag] = [];
                        tagStates[tag] = TaskState.SUCCEEDED;
                    }

                    tagOutputs[tag].push(taskOutput);
                    if (taskState === TaskState.FAILED) {
                        // one failed state fails them all
                        tagStates[tag] = TaskState.FAILED;
                    } else if (taskState !== TaskState.SUCCEEDED) {
                        // any non-successful states mean the tasks for the tag are in progress
                        tagStates[tag] = TaskState.IN_PROGRESS;
                    }
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
                anchorFn("\n" + output);
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
