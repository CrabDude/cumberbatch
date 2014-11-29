var colors = require('colors');
var events = require('events');
var exec = require('child_process').exec;
var helpers = require('./helpers');
var util = require('util');
var _ = require('lodash');

var TaskState = require('./TaskState');
var TaskAction = require('./TaskAction');
var TaskFactory = require('./TaskFactory');

/**
 * Task runner which keeps track of task statuses and runs and reruns them
 * as needed. Listens to the cumberbatch watcher and hasher to determine when
 * tasks have changed and need to be reran.
 *
 * @constructor
 * @param {Object} options
 */
var TaskManager = function(options) {
    options = options || {};

    this._options = options;
    this._targets = options.targets;
    this._maxProcesses = options.maxProcesses;
    this._gruntCommand = options.gruntPath || 'grunt';

    this._runningProcesses = 0;

    this._delayedRegistrations = {};
    this._neededRegistrations = {};
    this._tasks = {};
    this._taskDependencies = {};
    this._reverseTaskDependencies = {};
    this._watcherListeners = [];

    this._bound_runNext = this._runNext.bind(this);
};
util.inherits(TaskManager, events.EventEmitter);

/**
 * Registers a grunt task with the specified options
 *
 * @param  {string} taskName
 * @param  {Object} options
 * @param  {boolean} force force adding this task immediately
 */
TaskManager.prototype.register = function(taskName, options, force) {
    if (this._targets && this._targets.indexOf(taskName) === -1 && !force) {
        this._delayedRegistrations[taskName] = options;
        return;
    }

    if (options && options.isParent) {
        this._registerParent(taskName, options, force);
        return;
    }

    delete this._neededRegistrations[taskName];

    options = options || {};
    var task = this._tasks[taskName] = TaskFactory.getGruntTask(taskName, options || {}, this._options);
    task.setState(TaskState.INITIALIZING);
    var deps = task.getConfig().deps || [];
    for (var i = 0; i < deps.length; i++) {
        var dep = deps[i];
        var config = this._delayedRegistrations[dep];

        if (config) {
            delete this._delayedRegistrations[dep];
            this.register(dep, config, true);
        } else {
            this._neededRegistrations[dep] = true;
        }
    }

    var buildWhen = task.getConfig().buildWhen || [
        'fileChanged'
    ];
    if (buildWhen.indexOf('fileChanged') !== -1) {
        var globData = task.getWatchedGlobs();
        var self = this;

        _.forEach(globData, function(data) {
            var callback = self._trigger.bind(self, taskName,
                TaskAction.CHANGED);
            self._watcherListeners.push(self._options.watcher.on(
                data.src, callback));
            self._options.hasher.on(data.src, callback);
        });
    }
};

/**
 * Starts the task manager by waiting for the watcher or hasher to be ready
 * and immediately running the next pending task.
 */
TaskManager.prototype.start = function() {
    this._buildDependencyMap();
    this._buildReverseDependencyMap();

    var started = false;
    var self = this;

    var onReady = function() {
        if (self._options.verbose) {
            console.log('watcher started');
        }

        if (!started) {
            self._runNext();
            started = true;
        }
    };

    this._options.watcher.onReady(onReady);

    this._options.hasher.onReady(onReady);
    this._options.hasher.onReady(this._detachWatcher.bind(this));
};

/**
 * Registers a parent / container task internally. Parent tasks proxy through
 * their options to their children tasks and have a isDependency / dependencyBuilt
 * mapping around the children.
 *
 * @private
 * @param {string} taskName
 * @param {Object} options
 */
TaskManager.prototype._registerParent = function(taskName, options) {
    var config = this._options.gruntConfig[taskName] || {};
    var deps = [];

    var configKeys = Object.keys(config);
    for (var i = 0; i < configKeys.length; i++) {
        var childOptions = _.clone(options);
        delete childOptions.isParent;
        var targetName = configKeys[i];
        if (!/^_|^options$/.test(targetName) && typeof config[targetName] !==
            'function') {
            var fullTaskName = taskName + ':' + targetName;
            deps.push(fullTaskName);
            this.register(
                fullTaskName,
                childOptions,
                true
            );
        }
    }

    var task = this._tasks[taskName] = TaskFactory.getGruntTask(taskName, {
        buildWhen: ['isDependency', 'dependencyBuilt'],
        deps: deps
    }, this._options);
    task.setEmpty(true);
    task.setState(TaskState.INITIALIZING);
};

/**
 * Builds the map of all tasks to their dependencies recursively.
 *
 * @private
 */
TaskManager.prototype._buildDependencyMap = function() {
    var self = this;

    // create the true dependency map
    this._taskDependencies = {};

    // initialize all of the task dependencies
    var initializedTask;

    do {
        initializedTask = false;
        iters = 0;

        // loop through all of the tasks and build a dependency array for
        // each based on recursive dependencies
        _.forEach(this._tasks, function(task, taskName) {
            if (task.getState() !== TaskState.INITIALIZING) return;
            var taskConfig = task.getConfig();
            var deps = taskConfig.deps || [];

            // check to see if any dependencies haven't resolved yet
            var hasPendingDeps = _.some(deps, function(dep) {
                return self._tasks[dep].getState() !==
                    TaskState.PENDING;
            });
            if (hasPendingDeps) {
                return;
            }

            // flatten all recursive dependencies
            self._taskDependencies[taskName] = [].concat(deps);
            _.forEach(deps, function(dep) {
                self._taskDependencies[taskName] =
                    self._taskDependencies[taskName].concat(
                        self._taskDependencies[dep]
                    );
            });

            // initialize the task state
            self._tasks[taskName].setState(TaskState.PENDING);
            initializedTask = true;
        });
    } while (initializedTask);
};

/**
 * Builds the map of all tasks to their reverse dependencies recursively
 *
 * @private
 */
TaskManager.prototype._buildReverseDependencyMap = function() {
    var reverseDeps = {};
    var self = this;

    for (var key in self._tasks) {
        var deps = self._tasks[key].getConfig().deps || [];
        for (var i = 0; i < deps.length; i++) {
            if (typeof self._tasks[deps[i]].getConfig() === 'undefined') {
                throw new Error('Dependency ' + deps[i].yellow +
                    ' does not exist');
            }
        }
    }

    _.forEach(this._taskDependencies, function(deps, taskName) {
        _.forEach(deps, function(dep) {
            if (!reverseDeps[dep]) {
                reverseDeps[dep] = {};
            }
            reverseDeps[dep][taskName] = true;
        });
    });

    this._reverseTaskDependencies = {};
    _.forEach(reverseDeps, function(depMap, taskName) {
        self._reverseTaskDependencies[taskName] = Object.keys(
            depMap);
    });
};

/**
 * Runs the next task if any tasks need to be ran
 *
 * @private
 */
TaskManager.prototype._runNext = function() {
    var self = this;
    var foundDelayedTasks = false;

    // create a list of all the task names to be run
    var pendingTasks = _.filter(Object.keys(this._tasks), function(taskName) {
        var state = self._tasks[taskName].getState();

        // verify the task isn't running
        if (state !== TaskState.PENDING) {
            return false;
        }

        if (typeof self._tasks[taskName].getNextRunMs() !== 'undefined') {
            // if running of the task is delayed, only run if the specified timestamp
            // has been passed
            if (Date.now() < self._tasks[taskName].getNextRunMs()) {
                foundDelayedTasks = true;
                return false;
            }
        }

        // verify that all dependencies are in a good state
        var deps = self._taskDependencies[taskName];
        var hasPendingDeps = _.some(deps, function(dep) {
            return self._tasks[dep].getState() !==
                TaskState.SUCCEEDED;
        });
        if (hasPendingDeps) {
            return false;
        }

        return true;
    });

    // build a list of downstream dependencies for tasks to be run
    var pendingTaskReverseDependencies = [];
    _.forEach(pendingTasks, function(taskName) {
        var reverseDeps = self._reverseTaskDependencies[taskName] || [];
        pendingTaskReverseDependencies =
            pendingTaskReverseDependencies.concat(reverseDeps);
    });

    // filter to only tasks which have no inter-dependencies
    var tasksToRun = _.filter(pendingTasks, function(taskName) {
        return pendingTaskReverseDependencies.indexOf(taskName) ===
            -1;
    });

    // filter out any tasks which have downstream dependencies running to prevent
    // weird race conditions
    tasksToRun = _.filter(tasksToRun, function(taskName) {
        var reverseDeps = self._reverseTaskDependencies[taskName] || [];
        for (var i = 0; i < reverseDeps.length; i++) {
            var depState = self._tasks[reverseDeps[i]].getState();
            if (depState === TaskState.IN_PROGRESS ||
                depState === TaskState.IN_PROGRESS_MUST_RERUN) {
                // don't run if any downstream dependencies are running
                return false;
            }
        }
        return true;
    });

    if (typeof this._maxProcesses !== 'undefined') {
        var runnersAvailable = this._maxProcesses - this._runningProcesses;
        if (tasksToRun.length > runnersAvailable) {
            // if we have limited task runners available, prioritize by number of
            // downstream tasks
            tasksToRun.sort(function(a, b) {
                var aDeps = self._reverseTaskDependencies[a] || [];
                var bDeps = self._reverseTaskDependencies[b] || [];
                return bDeps.length - aDeps.length;
            });

            // reduce to the number of runners
            tasksToRun = tasksToRun.slice(0, runnersAvailable);
        }
    }

    // run each task that needs to be ran
    _.forEach(tasksToRun, function(taskName) {
        self._tasks[taskName].setNextRunMs(undefined);

        // mark the task as in progress
        self._trigger(taskName, TaskAction.RUNNING);

        // build the command to run and fold in the decorator as needed
        var taskConfig = self._tasks[taskName].getConfig();

        // if the task is a pass through, immediately trigger success
        if (self._tasks[taskName].isEmpty()) {
            self._trigger(taskName, TaskAction.SUCCEEDED);
            return;
        }

        var taskCommand = self._gruntCommand + ' ' + (
            taskConfig.decorator ? taskConfig.decorator + ':' :
            ''
        ) + taskName + (self._options.gruntOptions || '');

        // actually spawn the process
        var startTime = Date.now();
        self._runningProcesses++;
        self._tasks[taskName].setProcess(exec(taskCommand, function(
            err, stdout,
            stderr) {
            self._runningProcesses--;
            self._tasks[taskName].setLastDuration(Date.now() -
                startTime);

            self._tasks[taskName].setProcess(undefined);
            if (err) {
                self._tasks[taskName].setError(stderr,
                    stdout);
            } else {
                self._tasks[taskName].setError(
                    undefined);
            }
            self._trigger(taskName, (!!err) ?
                TaskAction.FAILED : TaskAction.SUCCEEDED
            );
        }));

        self._tasks[taskName].getProcess().stdout.pipe(process.stdout);
        self._tasks[taskName].getProcess().stderr.pipe(process.stderr);
    });

    if (foundDelayedTasks) {
        // some tasks are delayed, try again in 200ms
        setTimeout(this._bound_runNext, 200);
    }
};

TaskManager.prototype.getTaskStates = function() {
    var tasksData = {};

    for (var taskName in this._tasks) {
        var task = this._tasks[taskName];
        if (task.isEmpty()) continue;

        tasksData[taskName] = {
            dependencies: this._taskDependencies[taskName] || [],
            errorData: task.getError(),
            lastRunMs: task.getLastDuration(),
            state: task.getState(),
            tags: task.getTags()
        };
    }
    return tasksData;
};

/**
 * Triggers a change event for a particular task
 *
 * @private
 * @param {string} taskName
 * @param {TaskAction} action
 */
TaskManager.prototype._trigger = function(taskName, action) {
    var self = this;
    var task = this._tasks[taskName];
    var currentState = task.getState();

    switch (action) {
        case TaskAction.RUNNING:
            // starting to run the task, mark it as in progress
            task.setState(TaskState.IN_PROGRESS);
            break;

        case TaskAction.CHANGED:
            if (currentState !== TaskState.PENDING) {
                // an input file has changed or an input file for a reverse dependency
                // has changed, recursively mark dependencies as CHANGED if they have
                // the isDependency buildWhen state. Then roll into running
                _.forEach(task.getConfig().deps || [],
                    function(dep) {
                        var depConfig = self._tasks[dep].getConfig();
                        var buildWhen = depConfig.buildWhen || [];
                        if (!Array.isArray(buildWhen)) buildWhen = [
                            buildWhen
                        ];

                        if (buildWhen.indexOf('isDependency') !== -1) {
                            self._trigger(dep, TaskAction.CHANGED);
                        }
                    });
            }

        case TaskAction.RUN:
            // the task was triggered, attempt to mark it as pending along with
            // any children tasks

            if (currentState === TaskState.PENDING) {
                // not doing anything with this task as it's in a good state.
                // might trigger dependency tasks below though

            } else if (currentState !== TaskState.IN_PROGRESS &&
                currentState !==
                TaskState.IN_PROGRESS_MUST_RERUN) {
                // task is not running, mark it as pending
                task.setState(TaskState.PENDING);

            } else {
                // task is in progress, check whether we should kill the running
                // process and set the task to rerun
                var taskConfig = task.getConfig();
                var ifRunning = taskConfig.ifRunning || 'wait';

                task.setState(TaskState.IN_PROGRESS_MUST_RERUN);

                if (ifRunning === 'kill') {
                    if (task.getProcess()) {
                        task.getProcess().kill();
                        task.setProcess(undefined);
                    }
                }
            }
            break;

        case TaskAction.SUCCEEDED:
            // the task succeeded move to a success state and potentially rerun
            task.setState(TaskState.SUCCEEDED);
            if (currentState === TaskState.IN_PROGRESS_MUST_RERUN) {
                this._trigger(taskName, TaskAction.RUN);
            }

            _.forEach(this._reverseTaskDependencies[taskName], function(dep) {
                var buildWhen = self._tasks[dep].getConfig().buildWhen || [];
                var deps = self._tasks[dep].getConfig().deps || [];
                if (!Array.isArray(buildWhen)) buildWhen = [
                    buildWhen
                ];

                if (buildWhen.indexOf('dependencyBuilt') !== -1 &&
                    deps.indexOf(taskName) !== -1) {
                    // adding a 200ms delay because of filesystem lag. this gives the
                    // reverse dependency a chance to receive file changed events before
                    // running
                    self._tasks[taskName].setNextRunMs(Date.now() + 200);
                    self._trigger(dep, TaskAction.RUN);
                }
            });
            break;

        case TaskAction.FAILED:
            // the task failed move to a failure state and potentially rerun
            task.setState(TaskState.FAILED);
            if (currentState === TaskState.IN_PROGRESS_MUST_RERUN) {
                this._trigger(taskName, TaskAction.RUN);
            }
            break;
    }

    if (task.getState() !== currentState) {
        process.nextTick(this._bound_runNext);
        this.emit('taskStateChange', taskName, currentState, this._tasks[
            taskName].getState());
    }
};

/**
 * Detaches all listeners from the watcher
 *
 * @private
 */
TaskManager.prototype._detachWatcher = function() {
    for (var i = 0; i < this._watcherListeners.length; i++) {
        this._options.watcher.off(this._watcherListeners[i]);
    }
};

/**
 * Sets up default event listeners for rendering output
 */
TaskManager.prototype.initDefaultListeners = function() {
    helpers.initDefaultListeners.call(this);
};

module.exports = TaskManager;
