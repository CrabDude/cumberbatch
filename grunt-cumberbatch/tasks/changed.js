"use strict";
var cumberbatch = require('cumberbatch');
var exec = require('child_process').exec;
var fs = require('fs');
var mkdirp = require('mkdirp');
var path = require('path')
var Q = require('kew');

module.exports = function(grunt) {
    var _cleanupId = 0;
    var cleanupCache = {};

    var _hasher = null;

    /**
    * Get a cumberbatch hasher instance
    * @param {Cumberbatch.Hasher} config
    */
    var getHasher = function (config) {
        if (!_hasher) {
            _hasher = new cumberbatch.Hasher(null, config || {});
        }
        return _hasher;
    };

    /**
    * Runs all tasks for a given task name
    * @param  {string} prefix
    * @param  {string} taskName
    * @return {Object}
    */
    var runAllTasks = function (prefix, taskName) {
        try {
            var tasks = [];
            var config = grunt.config(taskName);
            if (!config) {
                return grunt.task.run(taskName);
            }

            var configKeys = Object.keys(config);
            for (var i = 0; i < configKeys.length; i++) {
                var targetName = configKeys[i];
                if (!/^_|^options$/.test(targetName) && typeof config[configKey] !== 'function') {
                    tasks.push(prefix + ':' + taskName + ':' + targetName);
                }
            }
            return grunt.task.run(tasks);
        } catch (e) {
            throw new Error('runAllTasks (' + taskName + ') ' + e.message);
        }
    }

    /**
    * Runs a specific task
    * @param  {Object} options
    * @param  {string} taskName
    * @param  {string} targetName
    */
    var runTask = function (options, taskName, targetName) {
        var config = grunt.config(this.name) || {};
        if (config.options) config = config.options;
        if (!config.cacheDir) {
            throw new Error('cacheDir must be provided to ' + this.name + ' to run');
        }

        if (!targetName) {
            return runAllTasks(this.name, taskName);
        }

        var done = this.async();

        // grab any arguments to the task
        var args = Array.prototype.slice.call(arguments, 3);
        var fullTaskName = taskName + ':' + targetName;
        var taskConfig = grunt.config.get([taskName, targetName]);
        if (!taskConfig) {
            console.warn('Unable to load config for ' + fullTaskName + ', running without ' + this.name);
            grunt.task.run(fullTaskName);
            return done();
        }
        var cleanupId = ++_cleanupId;
        var originalConfig = taskConfig;
        cleanupCache[cleanupId] = {config: taskConfig, cacheDir: config.cacheDir, fileHashes: {}};
        taskConfig = grunt.util._.clone(taskConfig);

        var inputGlobsGetter;
        if (taskConfig._getInputGlobs) {
            inputGlobsGetter = taskConfig._getInputGlobs;
        } else if (taskConfig.options && taskConfig.options._getInputGlobs) {
            inputGlobsGetter = taskConfig.options._getInputGlobs;
        }

        // copying files to src
        if (typeof taskConfig.files === 'string') {
            taskConfig.src = [taskConfig.files];
            delete taskConfig.files;
        } else if (Array.isArray(taskConfig.files) && typeof taskConfig.files[0] === 'string') {
            taskConfig.src = taskConfig.files;
            delete taskConfig.files;
        }

        var files, fileConfigs = [];
        if (typeof inputGlobsGetter !== 'undefined') {
            taskConfig.src = inputGlobsGetter(taskConfig);
        }
        files = grunt.task.normalizeMultiTaskFiles(taskConfig, targetName);

        // no files means we should just run the task normally
        if (!files.length) {
            console.warn('Task ' + fullTaskName + ' has no input files, running without ' + this.name);
            grunt.task.run(fullTaskName);
            return done();
        }

        // load the existing file hashes for this task from cache
        var cacheFile = path.join(config.cacheDir, '.' + taskName + '.' + targetName);
        var oldHashDefer = Q.defer();
        fs.readFile(cacheFile, 'utf8', function (err, data) {
            if (err) return oldHashDefer.reject(err);

            try {
                oldHashDefer.resolve(JSON.parse(data) || {});
            } catch (e) {
                oldHashDefer.reject(e);
            }
        });
        var oldHashPromise = oldHashDefer.promise.fail(function (err) {
            return {};
        });

        // build a single array of source files
        var promises = [];
        var sources = [];
        for (var i = 0; i < files.length; i++) {
            sources = sources.concat(files[i].src);
        }
        var newHashPromise = getHasher(config.hasher)
        .calculateFileHashes(sources);

        Q.all([oldHashPromise, newHashPromise])
        .then(function (response) {
            // split the filenames into unchanged, changed, and deleted files
            var oldHashes = response[0];
            var newHashes = response[1];
            var processedFiles = {};
            var unchangedFiles = {};
            var changedFiles = {};
            var deletedFiles = {};

            // concatenate the lists of old and new filenames and iterate
            // over each checking for changes / deletion
            var keys = Object.keys(oldHashes).concat(Object.keys(newHashes));
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (processedFiles[key]) continue;
                processedFiles[key] = true;

                if (oldHashes[key] && !newHashes[key]) {
                    deletedFiles[key] = oldHashes[key];
                } else if (newHashes[key] === oldHashes[key]) {
                    unchangedFiles[key] = newHashes[key];
                } else {
                    changedFiles[key] = newHashes[key];
                }
            }

            var fileCounts = {
                deleted: deletedFiles,
                changed: changedFiles,
                unchanged: unchangedFiles,
                current: newHashes
            };

            console.warn('FILE COUNTS FOR ' + fullTaskName + ': ' +
                Object.keys(fileCounts).map(function (key) {
                return key + ':' + Object.keys(fileCounts[key]).length;
            }).join(', '));

            return fileCounts;
        })
        .then(function (fileStatuses) {
            // reset the task config to an empty array
            taskConfig.files = [];

            var taskFiles = [];
            var numChangedFiles = Object.keys(fileStatuses.changed).length;
            var numDeletedFiles = Object.keys(fileStatuses.deleted).length;

            if (numDeletedFiles && taskConfig._onDelete) {
                taskConfig._onDelete(Object.keys(fileStatuses.deleted));
            }

            if (options.fileSelection === 'all') {
                if (numChangedFiles || numDeletedFiles) {
                    // if we want to trigger a full rebuild, do this super
                    // aggressively and rebuild if anything has been deleted
                    // or changed
                    taskConfig = originalConfig;
                }
            } else if (options.fileSelection === 'changed') {
                if (numChangedFiles) {
                    // if we want to trigger incremental builds, loop through
                    // each file mapping and reduce the src field to only
                    // the files that show up in the changed map. If no files
                    // from a src field are in the map, remove the map entirely
                    for (var i = 0; i < files.length; i++) {
                        var fileMap = grunt.util._.clone(files[i]);
                        var fileSources = fileMap.src;
                        var newSources = [];
                        for (var j = 0; j < fileSources.length; j++) {
                            if (fileStatuses.changed[fileSources[j]]) {
                                newSources.push(fileSources[j]);
                            }
                        }
                        if (newSources.length) {
                            fileMap.src = newSources;
                            taskConfig.files.push(fileMap);
                        }
                    }
                }

                delete taskConfig.src;
                delete taskConfig.dest;
            } else if (options.fileSelection === 'smart') {
                delete cleanupCache[cleanupId];

                var response = taskConfig._getChangeTasks(
                    Object.keys(fileStatuses.changed), Object.keys(fileStatuses.deleted));
                    var childTasks;

                    if (!response) {
                        // no response provided, run the child task without a decorator
                        childTasks = [fullTaskName];

                    } else if (Array.isArray(response)) {
                        // an array was returned, assume it's a list of tasks
                        childTasks = [].concat(response);

                    } else {
                        // a single task was returned, create an array from it
                        childTasks = [response];
                    }
                    //   console.log('RUNNING', childTasks);
                    grunt.task.run(childTasks);
                    done(true);
                    return;
                }

                grunt.config.set([taskName, targetName], taskConfig);
                var tasks = [];
                if (numChangedFiles || numDeletedFiles) {
                    // only run the target task if any inputs have changed
                    cleanupCache[cleanupId].required = fullTaskName;
                    tasks.push(fullTaskName);
                    cleanupCache[cleanupId].fileHashes[cacheFile] = JSON.stringify(fileStatuses.current);
                }
                tasks.push('changed-cleanup:' + fullTaskName + ':' + cleanupId);
                grunt.task.run(tasks);

                done();
            }).fail(function (e) {
                require('util').error(e.stack);
                done(false);
            });
        };


        grunt.registerTask(
            'changed-all',
            'Runs the subtask if any input files have changed (with all inputs)',
            function() {
                return runTask.apply(this, [{'fileSelection': 'all'}]
                .concat(Array.prototype.slice.call(arguments, 0)))
            }
        );

        grunt.registerTask(
            'changed-only',
            'Runs the subtask if any input files have changed (with all inputs)',
            function() {
                return runTask.apply(this, [{'fileSelection': 'changed'}]
                .concat(Array.prototype.slice.call(arguments, 0)))
            }
        );

        grunt.registerTask(
            'changed-smart',
            'Reruns the subtask with the specified prefix',
            function() {
                return runTask.apply(this, [{'fileSelection': 'smart'}]
                .concat(Array.prototype.slice.call(arguments, 0)))
            }
        );

        grunt.registerTask(
            'changed-cleanup',
            'Cleans up after the changed tasks have ran',
            function(taskName, targetName, cleanupId) {
                var done = this.async();
                var cache = cleanupCache[cleanupId];
                delete cleanupCache[cleanupId];

                // reset the config
                grunt.config.set([taskName, targetName], cache.config);

                if (cache.required) {
                    grunt.task.requires(cache.required);
                }

                mkdirp(cache.cacheDir, function(err) {
                    if (err) {
                        console.error('Unable to create directory', cache.cacheDir);
                        done(false);
                    }

                    for (var key in cache.fileHashes) {
                        try {
                            fs.writeFileSync(key, cache.fileHashes[key], {encoding:'utf8'});
                        } catch (e) {
                            console.error(e);
                        }
                    }

                    done(true);
                });
            }
        );

    };
    
