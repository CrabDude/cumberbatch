var _ = require('lodash');
var colors = require('colors');

var TaskState = require('./TaskState');

module.exports.initDefaultListeners = function(options) {
    var taskManager = this;
    var startTime = new Date().getTime();
    var hasCompleted = false;
    var tasksRunTimesInCurrentBuild = [];
    var lastSlowestTasksOutput = '';
    var runTimes = [];
    var humanReadableRunTimes = [];
    var anchorFn;

    if (!options) {
        options = {};
    }

    if (options.anchorFn === undefined) {
        anchorFn = console.log.bind(console);
    } else {
        anchorFn = options.anchorFn;
    }

    var getHumanReadableTime = function(timeInMs) {
        var oneSecond = 1000;
        var sixtySeconds = 60 * oneSecond;
        if (timeInMs > sixtySeconds) {
            var seconds = Math.floor((timeInMs % sixtySeconds) / 1000);
            var minutes = Math.floor(timeInMs / sixtySeconds);
            return minutes + 'm ' + seconds + 's';
        } else if (timeInMs > oneSecond) {
            return ((timeInMs / oneSecond).toFixed(1)) + 's';
        } else {
            return timeInMs + 'ms';
        }
    };

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

    var getSlowestTasksOutput = function(tasksRunTimesInCurrentBuild) {
        var maxPercentageOfTimeToInclude = 1;
        var tasksThatTakeTopPercent = [];
        var currentTimeSum = 0;
        var maxNumberOfTasksToShowTimeFor = 6;

        if (tasksRunTimesInCurrentBuild.length === 0) {
            // No tasks currently running.
            return lastSlowestTasksOutput;
        }

        tasksRunTimesInCurrentBuild.sort(function(a, b) { 
            return b.time - a.time 
        });

        var totalParallelTime = 0;
        for (var i = 0; i < tasksRunTimesInCurrentBuild.length; i++ ) {
            totalParallelTime += tasksRunTimesInCurrentBuild[i].time;
        }
        var topPercentOfTime = totalParallelTime * maxPercentageOfTimeToInclude;

        for (var i = 0; i < tasksRunTimesInCurrentBuild.length; i++ ) {
            tasksThatTakeTopPercent.push(tasksRunTimesInCurrentBuild[i]);
            currentTimeSum += tasksRunTimesInCurrentBuild[i].time;
            if (currentTimeSum >= topPercentOfTime || 
                tasksThatTakeTopPercent.length === maxNumberOfTasksToShowTimeFor) {
                break;
            }
        }
        var topPercentOfTimeStrings = tasksThatTakeTopPercent.map(function(taskAndTime) {
            var percentage = ((taskAndTime.time / totalParallelTime) * 100).toFixed(2);
            var time = getHumanReadableTime(taskAndTime.time);
            return percentage + '% ' + time + ' ' + taskAndTime.taskName;
        });
        var totalPercentage = Math.floor((currentTimeSum / totalParallelTime) * 100);
        return (' | Slowest ' + maxNumberOfTasksToShowTimeFor + ' tasks, using ' + 
            totalPercentage + '% of parallel time = ' + topPercentOfTimeStrings.join(' | '));
    };

    renderTaskErrors = _.throttle(renderTaskErrors, 5000, {
        'trailing': true
    });

    var renderTaskStates = (function() {
        var lastOutput = '';

        return function(stateData) {
            // retrieve the current task state
            var taskNames = Object.keys(stateData);
            var tagOutputs = {};
            var tagStates = {};
            var tag;
            var hasErrors = false;
            var i;
            var numTasksPending = 0;
            var numTasksProcessing = 0;
            var numTasksFailed = 0;
            var numTasksSucceded = 0;

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
                var taskState = undefined, taskLastRunMs = undefined, taskTags = undefined;

                for (var j = 0; j < taskGroupData.data.length; j++) {
                    var taskData = taskGroupData.data[j];

                    // set state
                    if (taskState === undefined ||
                            [TaskState.IN_PROGRESS, TaskState.IN_PROGRESS_MUST_RERUN, TaskState.FAILED].indexOf(taskState) === -1) {
                        taskState = taskData.state;
                    }

                    // set max run ms
                    if (taskLastRunMs === undefined ||
                            (taskData.lastRunMs !== undefined && taskData.lastRunMs > taskLastRunMs)) {
                        taskLastRunMs = taskData.lastRunMs;
                    }

                    // set tags
                    taskTags = (taskData.tags || []).filter(function(tag) {
                        // Exclude tags begining in underscore.
                        return tag[0] !== '_';
                    });

                    if (typeof taskData.errorData !== 'undefined') {
                        hasErrors = true;
                    }
                }

                var taskOutput = taskGroupData.name;
                // Check whether to show time elapsed per task
                // As in slow machines, like 4 cores, it always shows this and looks cluttered,
                // we should probably instead report it to some api endpoint and collect metrics.
                if (options.showTimeElapsedPerTask) {
                    if (typeof taskLastRunMs !== 'undefined' && taskLastRunMs >= 0) {
                        // if the tag has a duration over 3 seconds, add it to the output
                        taskOutput += ' (' + taskLastRunMs + 'ms!!)';
                    }
                }

                taskOutput = taskOutput.split(':').join(' ');

                // format the task output string based on state
                switch (taskState) {
                    case TaskState.INITIALIZING:
                    case TaskState.PENDING:
                        taskOutput = taskOutput.grey;
                        numTasksPending++;
                        break;
                    case TaskState.IN_PROGRESS:
                    case TaskState.IN_PROGRESS_MUST_RERUN:
                        taskOutput = taskOutput.bold.blue;
                        numTasksProcessing++;
                        break;
                    case TaskState.FAILED:
                        taskOutput = taskOutput.bold.red;
                        numTasksFailed++;
                        break;
                    case TaskState.SUCCEEDED:
                        taskOutput = taskOutput.bold.green;
                        numTasksSucceded++;
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

            // Intermittently the state will be nothing in progress and a couple pending for an instant
            // thus check also pending to prevent multiple repeated final error outputs.
            newHasCompleted = numTasksProcessing === 0 && numTasksPending === 0;

            var weHaveJustCompletedARun = false;
            if (hasCompleted && !newHasCompleted) {
                // We've just started again!
                startTime = new Date().getTime();
            } else if (!hasCompleted && newHasCompleted) {
                // We've finished!
                var elapsedTime = new Date().getTime() - startTime;
                runTimes.push(elapsedTime);
                humanReadableRunTimes.push(getHumanReadableTime(elapsedTime));
                weHaveJustCompletedARun = true;
            }

            hasCompleted = newHasCompleted;

            var output = '';

            // Progress bar
            var completionRatio = numTasksSucceded / ((numTasksSucceded + numTasksProcessing + numTasksPending) || 1);
            var length = 80;
            var completionUnits = Math.floor(length * completionRatio);
            var progresBar = Array(completionUnits + 1).join("+");
            var pendingBar = Array(length - completionUnits + 1).join("-");
            var line;
            if (hasCompleted) {
                line = (progresBar.green + pendingBar.green + '\n').bold;
            } else {
                line = (progresBar.cyan + pendingBar.blue + '\n').bold;
            }
            output += line;

            for (tag in tagOutputs) {
                var prefix = tag.toUpperCase() + " TASKS: ";
                switch(tagStates[tag]) {
                    case TaskState.SUCCEEDED:
                        prefix = prefix.bold.green;
                        break;
                    case TaskState.FAILED:
                        prefix = prefix.bold.red;
                        break;
                    default:
                        prefix = prefix.bold.blue;
                }

	           output += prefix + tagOutputs[tag].join(', ') + "\n";
            }

            var status = '';
            if (numTasksFailed > 0) {
                status = ('FAILED (' + numTasksFailed + ' tasks failed)').bold.red;
            } else if (numTasksProcessing > 0) {
                status = ('IN PROCESS (' + numTasksProcessing + ' tasks processing, ' + numTasksPending + ' tasks pending)').bold.blue;
            } else if (numTasksPending > 0) {
                status = ('INCOMPLETE (' + numTasksPending + ' tasks pending)').bold.blue;
            } else {
                status = ('SUCCESSFULLY COMPLETE (' + numTasksSucceded + ' tasks done)').bold.green;
            }
            var lastRunTime;
            if (!newHasCompleted) {
                var elapsedTime = new Date().getTime() - startTime;
                lastRunTime = elapsedTime;
            } else if (runTimes.length > 0) {
                lastRunTime = runTimes[ runTimes.length - 1 ];
            }

            var slowestTasksOutput = getSlowestTasksOutput(tasksRunTimesInCurrentBuild);
            output += 'BUILD STATUS: '.bold.white + status + 
                ' | Run Time: ' + getHumanReadableTime(lastRunTime).bold.white + 
                slowestTasksOutput;

            if (humanReadableRunTimes.length > 0 && options.showTotalBuildRunTimes) {
                output += ('RUN TIMES: ' + humanReadableRunTimes.join(', ')).bold.white  + '\n';
            }

            if (!newHasCompleted && options.showCurrentBuildElapsedTime) {
                var elapsedTime = new Date().getTime() - startTime;
                output += ('CURRENT BUILD ELAPSED TIME: ' + getHumanReadableTime(elapsedTime)).bold.white  + '\n';
            }

            if (output !== lastOutput) {
                anchorFn("\n" + output);
                lastOutput = output;
            }

            if (weHaveJustCompletedARun) {
                console.log("\nDone, all tasks finished running.\n".green.bold);
                lastSlowestTasksOutput = slowestTasksOutput;
                tasksRunTimesInCurrentBuild = [];
            }

            if (hasErrors === true && hasCompleted) {
                renderTaskErrors();
            }
        };
    })();

    renderTaskStates = _.throttle(renderTaskStates, 1000, {
        'trailing': true
    });

    var renderTaskStateChange = function(taskName, oldState, newState) {
        // TODO: Maybe move this out?
        var taskStateDescriptions = ['NONE', 'INITIALIZING', 'PENDING', 'IN_PROGRESS', 
            'IN_PROGRESS_MUST_RERUN', 'FAILED', 'SUCCEEDED'];

        if (oldState < taskStateDescriptions.length && newState < taskStateDescriptions.length) {
            var message = '( [' + taskName.split(':').join(' : ') + ' ]  ' + taskStateDescriptions[oldState] +
                ' -> ' + taskStateDescriptions[newState] + ')';
            var line = '\n================================================================================\n';

            if (newState == TaskState.SUCCEEDED) {
                console.log(('\n' + message).toLowerCase().grey);
                console.log(line.bold.green);
            } else {
                console.log((message + '\n').toLowerCase().grey);
            }
        }
    };

    var updateTaskRunTimesInCurrentBuild = function(stateData, taskName, newState) {
        if (newState == TaskState.SUCCEEDED && stateData[taskName]) {
            var taskAndTime = {
                taskName: taskName,
                time: stateData[taskName].lastRunMs
            };
            tasksRunTimesInCurrentBuild.push(taskAndTime);
        }
    };

    this.on('taskStateChange', function (taskName, oldState, newState) {
        var stateData = taskManager.getTaskStates();
        updateTaskRunTimesInCurrentBuild(stateData, taskName, newState);
        renderTaskStates(stateData);
        renderTaskStateChange(taskName, oldState, newState);
    });
};
