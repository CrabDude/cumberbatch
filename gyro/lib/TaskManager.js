var events = require('events');
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

    this._runningProcesses = 0;

    this._delayedRegistrations = {};
    this._neededRegistrations = {};
    this._tasks = {};
    this._watcherListeners = [];

    this._bound_runNext = this._runNext.bind(this);
    this._bound_runTask = this._runTask.bind(this);
    this._bound_sortTasksByDependencies = this._sortTasksByDependencies.bind(this);
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
    var i;

    if (!options.taskType) options.taskType = 'grunt';

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
    var task = this._tasks[taskName] = TaskFactory.getTask(taskName, options || {}, this._options);
    task.setState(TaskState.INITIALIZING);
    var deps = task.getConfig().deps || [];
    for (i = 0; i < deps.length; i++) {
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
            var watcherCallback = self._trigger.bind(self, taskName,
                TaskAction.CHANGED);
            var hasherCallback = watcherCallback;

            if (self._options.verboseTasks && Array.isArray(self._options.verboseTasks)) {
                for (i = 0; i < self._options.verboseTasks.length; i++) {
                    var verboseTask = self._options.verboseTasks[i];
                    if (taskName.indexOf(verboseTask) !== -1) {

                        console.log('Task: ' + taskName, ' is listening to: ', data.src);
                        
                        var originalWatcherCallback = watcherCallback;

                        watcherCallback = function(){
                            console.log('Watcher of: ', taskName, ' called with: ', arguments[0]);
                        };

                        hasherCallback = function() {
                            console.log('Hasher of: ', taskName, ' called with: ', arguments[0]);
                            return originalWatcherCallback.apply(this, arguments);
                        };
                        break;
                    }
                }
            }
            self._watcherListeners.push(self._options.watcher.on(
                data.src, watcherCallback));
            self._options.hasher.on(data.src, hasherCallback);
        });
    }
};

/**
 * Recursively calculates priorities for all tasks
 *
 */
TaskManager.prototype._calculatePriorities = function() {
    var self = this;
    var priorities = {};
    var tasksPending;
    do {
        tasksPending = [];
        _.forEach(this._tasks, function(task, taskName) {
            var currentPriority = task.getPriority();
            var deps = task.getDependents();
            for (var i = 0; i < deps.length; i++) {
                var dep = deps[i];

                if (priorities[dep] === undefined) {
                    // wait for the dependent task to set its own priority
                    tasksPending.push(dep);
                    return;
                }

                if (priorities[dep] > currentPriority) {
                    // dependent priority is higher, boost priority
                    currentPriority = priorities[dep];
                }
            }

            task.setPriority(currentPriority);
            priorities[taskName] = currentPriority;
        });
    } while (tasksPending.length);
};

/**
 * Starts the task manager by waiting for the watcher or hasher to be ready
 * and immediately running the next pending task.
 */
TaskManager.prototype.start = function() {
    this._buildDependencyMap();
    this._buildDependentMap();
    this._calculatePriorities();

    var started = false;
    var self = this;

    var onReady = function() {
        if (!started) {
            self._runNext();
            started = true;
        }
    };

    var onWatcherReady = function() {
        if (self._options.verbose) {
            console.log('Watcher started');
        }
        onReady();
    };

    var onHasherReady = function() {
        if (self._options.verbose) {
            console.log('Hasher started');
        }
        onReady();
    };

    this._options.watcher.onReady(onWatcherReady);
    this._options.hasher.onReady(onHasherReady);

    if (!Array.isArray(self._options.verboseTasks)) {
        this._options.hasher.onReady(this._detachWatcher.bind(this));
    }
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
        if (options.collapseChildren) {
            childOptions.groupAs = taskName;
        }
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

    var task = this._tasks[taskName] = TaskFactory.getTask(taskName, {
        buildWhen: ['isDependency', 'dependencyBuilt'],
        tags: options.tags,
        deps: deps,
        taskType: 'generic'
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

    // initialize all of the task dependencies
    var initializedTask;

    do {
        initializedTask = false;

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
            var newDeps = [].concat(deps);
            _.forEach(deps, function(dep) {
                newDeps = newDeps.concat(self._tasks[dep].getDependencies());
            });
            self._tasks[taskName].setDependencies(_.uniq(newDeps));

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
TaskManager.prototype._buildDependentMap = function() {
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

    _.forEach(this._tasks, function(task, taskName) {
        var deps = task.getDependencies();

        _.forEach(deps, function(dep) {
            if (!reverseDeps[dep]) {
                reverseDeps[dep] = {};
            }
            reverseDeps[dep][taskName] = true;
        });
    });

    _.forEach(reverseDeps, function(depMap, taskName) {
        self._tasks[taskName].setDependents(Object.keys(depMap));
    });
};

TaskManager.prototype._hasPendingDeps = function (taskName) {
    var deps = this._tasks[taskName].getDependencies();

    for (var i = 0; i < deps.length; i++) {
        if (this._tasks[deps[i]].getState() !== TaskState.SUCCEEDED) {
            return true;
        }
    }

    return false;
};

TaskManager.prototype._sortTasksByDependencies = function(a, b) {
    var aTask = this._tasks[a];
    var bTask = this._tasks[b];

    var aPriority = aTask.getPriority();
    var bPriority = bTask.getPriority();

    if (aPriority !== bPriority) {
        return bPriority - aPriority;
    }

    var aDeps = aTask || [];
    var bDeps = bTask || [];
    return bDeps.length - aDeps.length;
};

/**
 * Runs the next task if any tasks need to be ran
 *
 * @private
 */
TaskManager.prototype._runNext = function() {
    var deps;
    var i;
    var taskName;
    var task;
    var nearestDelayMs = -1;
    var pendingTasks = [];
    var pendingTaskDependentMap = {};

    // find all pending tasks to run
    for (taskName in this._tasks) {
        task = this._tasks[taskName];

        if (task.getState() !== TaskState.PENDING) {
            // task isn't in a pending state
            continue;
        }

        if (this._hasPendingDeps(taskName)) {
            // task has non-successful dependencies
            continue;
        }

        var nextRunMs = task.getNextRunMs();
        if (nextRunMs && nextRunMs > Date.now()) {
            // task has a next run time, set the next time to run
            nearestDelayMs = nearestDelayMs === -1 ? nextRunMs : Math.min(nearestDelayMs, nextRunMs);

        } else {
            // task is safe to run, stash all dependencies in a map for ordering reasons
            pendingTasks.push(taskName);
            deps = task.getDependents();
            for (i = 0; i < deps.length; i++) {
                pendingTaskDependentMap[[deps[i]]] = true;
            }
        }
    }

    // reduce the list of tasks based on cross-dependencies
    var tasksToRun = [];
    for (i = 0; i < pendingTasks.length; i++) {
        taskName = pendingTasks[i];
        if (pendingTaskDependentMap[taskName] !== true) {
            // if 2 tasks need to run, don't run the dependency
            deps = this._tasks[taskName].getDependents();

            var hasDependenciesInProgress = false;

            // if 2 tasks need to run, don't run the dependency
            deps = this._tasks[taskName].getDependents();
            for (j = 0; j < deps.length; j++) {
                var depState = this._tasks[deps[j]].getState();
                if (depState === TaskState.IN_PROGRESS ||
                    depState === TaskState.IN_PROGRESS_MUST_RERUN) {
                    // if the task has dependents running, wait for them to finish
                    hasDependenciesInProgress = true;
                    break;
                }
            }

            if (hasDependenciesInProgress === false) {
                tasksToRun.push(taskName);
            }

        }
    }

    if (typeof this._maxProcesses !== 'undefined') {
        /* Certain tasks with a process multiplier may cause runningProcesses to exceed maxProcesses
            temporarily. This must be allowed to avoid deadlock. */
        var runnersAvailable = Math.max(this._maxProcesses - this._runningProcesses, 0);
        if (tasksToRun.length > runnersAvailable) {
            // if we have limited task runners available, prioritize by number of
            // downstream tasks
            tasksToRun.sort(this._bound_sortTasksByDependencies);

            // reduce to the number of runners
            tasksToRun = tasksToRun.slice(0, runnersAvailable);
        }
    }

    // run each task that needs to be ran
    _.forEach(tasksToRun, this._bound_runTask);

    if (nearestDelayMs !== -1) {
        // some tasks are delayed, try again in 200ms
        setTimeout(this._bound_runNext, nearestDelayMs - Date.now());
    }
};

TaskManager.prototype._runTask = function(taskName) {
    var task = this._tasks[taskName];

    task.setNextRunMs(undefined);

    // mark the task as in progress
    this._trigger(taskName, TaskAction.RUNNING);

    // build the command to run and fold in the decorator as needed
    var taskConfig = task.getConfig();

    // if the task is a pass through, immediately trigger success
    if (task.isEmpty()) {
        this._trigger(taskName, TaskAction.SUCCEEDED);
        return;
    }

    // actually spawn the process
    var startTime = Date.now();
    var self = this;

    /* Some tasks spawn their own processes. Use config.processesUsed
        to represent the number of processes a task might spawn. */
    var taskConfig = task.getConfig() || {};
    var processesUsed = parseInt(taskConfig['processesUsed'] || 1);

    /* This may exceed maxProcesses temporarily.
       Allow this to avoid deadlock
       (where processesUsed > maxProcesses) */
    this._runningProcesses += processesUsed;

    task.run(function (err) {
        task.setLastDuration(Date.now() - startTime);
        self._runningProcesses -= processesUsed;
        self._trigger(taskName, !!err ? TaskAction.FAILED : TaskAction.SUCCEEDED);
    });
};

TaskManager.prototype.getTaskStates = function() {
    var tasksData = {};

    for (var taskName in this._tasks) {
        var task = this._tasks[taskName];
        if (task.isEmpty()) continue;

        tasksData[taskName] = {
            dependencies: task.getDependencies(),
            errorData: task.getError(),
            groupAs: task.getConfig().groupAs,
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

            _.forEach(this._tasks[taskName].getDependents(), function(dep) {
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
    helpers.initDefaultListeners.apply(this, arguments);
};

module.exports = TaskManager;
