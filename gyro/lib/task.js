var colors = require('colors');
var events = require('events');
var exec = require('child_process').exec;
var gruntUtils = require('./grunt');
var util = require('util');
var _ = require('lodash');

/**
 * @enum {number}
 */
var TaskState = {
  INITIALIZING: 1,
  PENDING: 2,
  IN_PROGRESS: 3,
  IN_PROGRESS_MUST_RERUN: 4,
  FAILED: 5,
  SUCCEEDED: 6
};
module.exports.TaskState = TaskState;

/**
 * @enum {number}
 */
var TaskAction = {
  SUCCEEDED: 1,
  FAILED: 2,
  RUN: 3,
  RUNNING: 4,
  CHANGED: 5
};
module.exports.TaskAction = TaskAction;

/**
 * Task runner which keeps track of task statuses and runs and reruns them
 * as needed. Listens to the cumberbatch watcher and hasher to determine when
 * tasks have changed and need to be reran.
 *
 * @constructor
 * @param {Object} options
 */
var TaskManager = function(options) {
  this._options = options || {};
  this._targets = this._options.targets;
  this._maxProcesses = this._options.maxProcesses;
  this._runningProcesses = 0;
  this._delayedRegistrations = {};
  this._neededRegistrations = {};
  this._taskStates = {};
  this._taskConfig = {};
  this._taskErrors = {};
  this._taskTimes = {};
  this._taskProcesses = {};
  this._taskDependencies = {};
  this._reverseTaskDependencies = {};
  this._watcherListeners = [];
  this._gruntCommand = options.gruntPath || 'grunt';
  this._taskDelays = {};

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

  this._taskStates[taskName] = TaskState.INITIALIZING;
  this._taskConfig[taskName] = options || {};
  var deps = this._taskConfig[taskName].deps || [];
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

  var buildWhen = this._taskConfig[taskName].buildWhen || ['fileChanged'];
  if (buildWhen.indexOf('fileChanged') !== -1) {
    var self = this;
    var globData = gruntUtils.getGlobsForTarget(taskName, this._options.gruntConfig);
    _.forEach(globData, function(data) {
      var callback = self._trigger.bind(self, taskName, TaskAction.CHANGED);
      self._watcherListeners.push(self._options.watcher.on(data.src, callback));
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

  this._options.watcher.onReady(function () {
    if (self._options.verbose) {
        console.log('watcher started');
    }

    if (!started) {
      self._runNext();
      started = true;
    }
  });

  this._options.hasher.onReady(function () {
    if (self._options.verbose) {
        console.log('hasher started');
    }

    self._detachWatcher();
    if (!started) {
      self._runNext();
      started = true;
    }
  });
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
TaskManager.prototype._registerParent = function (taskName, options) {
  var config = this._options.gruntConfig[taskName] || {};
  var deps = [];

  var configKeys = Object.keys(config);
  for (var i = 0; i < configKeys.length; i++) {
      var childOptions = _.clone(options);
      delete childOptions.isParent;
      var targetName = configKeys[i];
      if (!/^_|^options$/.test(targetName) && typeof config[targetName] !== 'function') {
          var fullTaskName = taskName + ':' + targetName;
          deps.push(fullTaskName);
          this.register(
            fullTaskName,
            childOptions,
            true
          );
      }
  }

  this._taskStates[taskName] = TaskState.INITIALIZING;
  this._taskConfig[taskName] = {
    buildWhen: ['isDependency', 'dependencyBuilt'],
    isEmpty: true,
    deps: deps
  };
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
    _.forEach(this._taskConfig, function(taskConfig, taskName) {
      if (self._taskStates[taskName] !== TaskState.INITIALIZING) return;
      var deps = taskConfig.deps || [];

      // check to see if any dependencies haven't resolved yet
      var hasPendingDeps = _.some(deps, function(dep) {
        return self._taskStates[dep] !== TaskState.PENDING;
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
      self._taskStates[taskName] = TaskState.PENDING;      initializedTask = true;
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

  for (var key in self._taskConfig) {
    var deps = self._taskConfig[key].deps || [];
    for (var i = 0; i < deps.length; i++) {
      if (typeof self._taskConfig[deps[i]] === 'undefined') {
        throw new Error('Dependency ' + deps[i].yellow + ' does not exist');
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
    self._reverseTaskDependencies[taskName] = Object.keys(depMap);
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
  var pendingTasks = _.filter(Object.keys(this._taskStates), function(taskName) {
    var state = self._taskStates[taskName];

    // verify the task isn't running
    if (state !== TaskState.PENDING) {
        return false;
    }

    if (typeof self._taskDelays[taskName] !== 'undefined') {
        // if running of the task is delayed, only run if the specified timestamp
        // has been passed
        if (Date.now() < self._taskDelays[taskName]) {
            foundDelayedTasks = true;
            return false;
        }
    }

    // verify that all dependencies are in a good state
    var deps = self._taskDependencies[taskName];
    var hasPendingDeps = _.some(deps, function(dep) {
      return self._taskStates[dep] !== TaskState.SUCCEEDED;
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
    pendingTaskReverseDependencies = pendingTaskReverseDependencies.concat(reverseDeps);
  });

  // filter to only tasks which have no inter-dependencies
  var tasksToRun = _.filter(pendingTasks, function (taskName) {
      return pendingTaskReverseDependencies.indexOf(taskName) === -1;
  });

  // filter out any tasks which have downstream dependencies running to prevent
  // weird race conditions
  tasksToRun = _.filter(tasksToRun, function (taskName) {
      var reverseDeps = self._reverseTaskDependencies[taskName] || [];
      for (var i = 0; i < reverseDeps.length; i++) {
          var depState = self._taskStates[reverseDeps[i]];
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
          tasksToRun.sort(function (a, b) {
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
    delete self._taskDelays[taskName];

    // mark the task as in progress
    self._trigger(taskName, TaskAction.RUNNING);

    // build the command to run and fold in the decorator as needed
    var taskConfig = self._taskConfig[taskName];

    // if the task is a pass through, immediately trigger success
    if (taskConfig.isEmpty) {
      self._trigger(taskName, TaskAction.SUCCEEDED);
      return;
    }

    var taskCommand = self._gruntCommand + ' ' + (
      taskConfig.decorator ? taskConfig.decorator + ':' : ''
    ) + taskName + (self._options.gruntOptions || '');

    // actually spawn the process
    var startTime = Date.now();
    self._runningProcesses++;
    self._taskProcesses[taskName] = exec(taskCommand, function(err, stdout,
      stderr) {
      self._runningProcesses--;
      self._taskTimes[taskName] = Date.now() - startTime;

      delete self._taskProcesses[taskName];
      if (err) {
        self._taskErrors[taskName] = {
          stderr: stderr,
          stdout: stdout
        };
      } else {
        delete self._taskErrors[taskName];
      }
      self._trigger(taskName, (!!err) ? TaskAction.FAILED : TaskAction.SUCCEEDED);
    });

    self._taskProcesses[taskName].stdout.pipe(process.stdout);
    self._taskProcesses[taskName].stderr.pipe(process.stderr);
  });

  if (foundDelayedTasks) {
    // some tasks are delayed, try again in 200ms
    setTimeout(this._bound_runNext, 200);
  }
};

TaskManager.prototype.getTaskStates = function () {
    var tasksData = {};
    for (var taskName in this._taskStates) {
        if (this._taskConfig[taskName].isEmpty) continue;

        var taskData = {};
        taskData.dependencies = this._taskDependencies[taskName] || [];
        taskData.state = this._taskStates[taskName];
        taskData.lastRunMs = this._taskTimes[taskName];
        taskData.errorData = this._taskErrors[taskName];
        taskData.tags = this._taskConfig[taskName].tags || ['uncategorized'];

        tasksData[taskName] = taskData;
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
  var currentState = this._taskStates[taskName];

  switch (action) {
    case TaskAction.RUNNING:
      // starting to run the task, mark it as in progress
      this._taskStates[taskName] = TaskState.IN_PROGRESS;
      break;

    case TaskAction.CHANGED:
      if (currentState !== TaskState.PENDING) {
        // an input file has changed or an input file for a reverse dependency
        // has changed, recursively mark dependencies as CHANGED if they have
        // the isDependency buildWhen state. Then roll into running
        _.forEach(this._taskConfig[taskName].deps || [], function(dep) {
          var depConfig = self._taskConfig[dep];
          var buildWhen = depConfig.buildWhen || [];
          if (!Array.isArray(buildWhen)) buildWhen = [buildWhen];

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

      } else if (currentState !== TaskState.IN_PROGRESS && currentState !==
        TaskState.IN_PROGRESS_MUST_RERUN) {
        // task is not running, mark it as pending
        this._taskStates[taskName] = TaskState.PENDING;

      } else {
        // task is in progress, check whether we should kill the running
        // process and set the task to rerun
        var taskConfig = this._taskConfig[taskName];
        var ifRunning = taskConfig.ifRunning || 'wait';

        this._taskStates[taskName] = TaskState.IN_PROGRESS_MUST_RERUN;

        if (ifRunning === 'kill') {
          if (this._taskProcesses[taskName]) {
            this._taskProcesses[taskName].kill();
            delete this._taskProcesses[taskName];
          }
        }
      }
      break;

    case TaskAction.SUCCEEDED:
      // the task succeeded move to a success state and potentially rerun
      this._taskStates[taskName] = TaskState.SUCCEEDED;
      if (currentState === TaskState.IN_PROGRESS_MUST_RERUN) {
        this._trigger(taskName, TaskAction.RUN);
      }

      _.forEach(this._reverseTaskDependencies[taskName], function(dep) {
        var buildWhen = self._taskConfig[dep].buildWhen || [];
        var deps = self._taskConfig[dep].deps || [];
        if (!Array.isArray(buildWhen)) buildWhen = [buildWhen];

        if (buildWhen.indexOf('dependencyBuilt') !== -1
            && deps.indexOf(taskName) !== -1) {
          // adding a 200ms delay because of filesystem lag. this gives the
          // reverse dependency a chance to receive file changed events before
          // running
          self._taskDelays[taskName] = Date.now() + 200;
          self._trigger(dep, TaskAction.RUN);
        }
      });
      break;

    case TaskAction.FAILED:
      // the task failed move to a failure state and potentially rerun
      this._taskStates[taskName] = TaskState.FAILED;
      if (currentState === TaskState.IN_PROGRESS_MUST_RERUN) {
        this._trigger(taskName, TaskAction.RUN);
      }
      break;
  }

  if (this._taskStates[taskName] !== currentState) {
      process.nextTick(this._bound_runNext);
      this.emit('taskStateChange', taskName, currentState, this._taskStates[taskName]);
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

module.exports.TaskManager = TaskManager;
