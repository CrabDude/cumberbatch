var grunt = require('grunt');
var path = require('path');
var _ = require('lodash');

/**
 * Get a normalized set of globs for a task config
 *
 * @return {Array.<{src:Array.<string>,dest:string,orig:}>}
 */
module.exports.getGlobsForTarget = function (target, config) {
    var targetParts = target.split(':');
    var taskConfig = config;
    var inputGlobsGetter;
    for (var i = 0; i < targetParts.length; i++) {
        if (['newer', 'changed-only', 'changed-all'].indexOf(targetParts[i]) === -
            1 &&
            taskConfig[targetParts[i]]) {
            taskConfig = taskConfig[targetParts[i]];
            if (taskConfig._getInputGlobs) {
              inputGlobsGetter = taskConfig._getInputGlobs;
            } else if (taskConfig.options && taskConfig.options._getInputGlobs) {
              inputGlobsGetter = taskConfig.options._getInputGlobs;
            }
        }
    }
    taskConfig = _.clone(taskConfig);

    if (typeof inputGlobsGetter !== 'undefined') {
      return [{src: inputGlobsGetter(taskConfig)}];
    }

    // copying files to src
    if (typeof taskConfig.files === 'string') {
        taskConfig.src = [taskConfig.files];
        delete taskConfig.files;
    } else if (Array.isArray(taskConfig.files) && typeof taskConfig.files[0] ===
        'string') {
        taskConfig.src = taskConfig.files;
        delete taskConfig.files;
    }

    return normalizeMultiTaskFiles(taskConfig);
};

/**
 * Converts stupid grunt tasks to a consistent format
 *
 * @param {*} data
 * @return {Array.<{src:Array.<string>,dest:string}>}
 */
function normalizeMultiTaskFiles(data) {
    var prop, obj;
    var files = [];
    if (grunt.util.kindOf(data) === 'object') {
        if ('src' in data || 'dest' in data) {
            obj = {};
            for (prop in data) {
                if (prop !== 'options') {
                    obj[prop] = data[prop];
                }
            }
            files.push(obj);
        } else if (grunt.util.kindOf(data.files) === 'object') {
            for (prop in data.files) {
                files.push({
                    src: data.files[prop],
                    dest: grunt.config.process(prop)
                });
            }
        } else if (Array.isArray(data.files)) {
            grunt.util._.flatten(data.files).forEach(function(obj) {
                var prop;
                if ('src' in obj || 'dest' in obj) {
                    files.push(obj);
                } else {
                    for (prop in obj) {
                        files.push({
                            src: obj[prop],
                            dest: grunt.config.process(prop)
                        });
                    }
                }
            });
        }
    }

    // If no src/dest or files were specified, return an empty files array.
    if (files.length === 0) {
        grunt.verbose.writeln('File: ' + '[no files]'.yellow);
        return [];
    }

    // Process all normalized file objects.
    files = grunt.util._(files).chain().forEach(function(obj) {
        if (!('src' in obj) || !obj.src) {
            return;
        }
        // Normalize .src properties to flattened array.
        if (Array.isArray(obj.src)) {
            obj.src = grunt.util._.flatten(obj.src);
        } else {
            obj.src = [obj.src];
        }
    }).map(function(obj) {
        // Build options object, removing unwanted properties.
        var expandOptions = grunt.util._.extend({}, obj);
        delete expandOptions.src;
        delete expandOptions.dest;

        // Expand file mappings.
        if (obj.expand) {
            var newObj = {};
            newObj.src = [];
            newObj.dest = obj.dest;

            if (obj.src) {
                for (var i = 0; i < obj.src.length; i++) {
                    newObj.src.push(obj.cwd ? path.join(obj.cwd, obj.src[i]) :
                        obj.src[i]);
                }
            }

            obj = newObj;
        }

        // Copy obj properties to result, adding an .orig property.
        var result = grunt.util._.extend({}, obj);

        if ('src' in result) {
            // Expose an expand-on-demand getter method as .src.
            Object.defineProperty(result, 'src', {
                enumerable: true,
                get: function fn() {
                    var src;
                    if (!('result' in fn)) {
                        src = obj.src;
                        // If src is an array, flatten it. Otherwise, make it into an array.
                        src = Array.isArray(src) ? grunt.util._.flatten(
                            src) : [src];
                    }
                    return src;
                }
            });
        }

        if ('dest' in result) {
            result.dest = obj.dest;
        }

        return result;
    }).flatten().value();

    return files;
}
