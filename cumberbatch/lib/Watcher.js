var chokidar = require('./chokidar');
var fs = require('fs');
var minimatch = require('minimatch');
var path = require('path');
var util = require('util');

var GlobEmitter = require('./GlobEmitter');
var Q = require('kew');

var Watcher = function(baseDir, options) {
    GlobEmitter.call(this, options);
    var self = this;

    if (typeof this._options.debug !== 'boolean') {
        this._options.debug = false;
    }

    this._runners = 0;
    this._queue = [];
    this._listeners = {};
    this._dirs = {};
    this._dirWatchers = {};
    this._paths = {};
    this._sortedPaths = [];
    this._pathsAreSorted = false;

    this._isReady = false;
    this._lastUpdate = Date.now();
    this._watchDir(baseDir, true);

    this._onReady = Q.defer();
};
util.inherits(Watcher, GlobEmitter);

Watcher.prototype.find = function (glob) {
    if (!this._pathsAreSorted) {
      this._generateSortedPaths();
    }

    var globPaths = {};
    var globParts = glob.split(/\*|\{/);
    var globRoot;
    var matches;
    if (globParts.length === 0) {
      globRoot = globParts[0]
    } else if (matches = globParts[0].match(/^(.*)\/[^\/]*$/)) {
      globRoot = matches[1];
    } else {
      throw new Error(glob + ' must be an absolute path');
    }
    var startIdx;

    if (globRoot.length > 0) {
      // binary search to find the first pattern that starts with the root
      var min = 0;
      var max = this._sortedPaths.length - 1;
      while (min <= max) {
        var curr = (min + max) / 2 | 0;
        var path = this._sortedPaths[curr];

        if (path < globRoot) {
            min = curr + 1;
        } else if (path > globRoot) {
            max = curr - 1;
        } else {
            startIdx = curr;
            break;
        }
      }

      if (typeof startIdx === 'undefined') {
        return globPaths;
      }

    }

    for (var i = startIdx || 0; i < this._sortedPaths.length; i++) {
      var path = this._sortedPaths[i];

      if (typeof startIdx === 'undefined' && path.indexOf(globRoot) === 0) {
        startIdx = i;
      }

      if (typeof startIdx !== 'undefined' && minimatch(path, glob)) {
        globPaths[path] = this._paths[path];
      } else if (startIdx > 0 && path.indexOf(globRoot) !== 0){
        break;
      }
    }

    return globPaths;
};

Watcher.prototype.onReady = function (callback) {
    this._onReady.promise.then(function () {
        callback();
    });
};

Watcher.prototype._generateSortedPaths = function () {
    this._sortedPaths = Object.keys(this._paths);
    this._sortedPaths.sort();
    this._pathsAreSorted = true;
};

Watcher.prototype._handleNext = function () {
    if (!this._queue.length) {
        this._runners--;
        return;
    }

    var nextFn = this._queue.shift();
    nextFn(this._bound_handleNext);
};

Watcher.prototype._checkPath = function (filename, stat) {
    var self = this;

    if (!stat) {
        self._onDeleted(filename);
    } else {
        if (self._paths[filename]) {
            self._onChanged(filename, stat);
        } else {
            self._onAdded(filename, stat);
            if (stat.isDirectory()) {
                self._watchDir(filename);
            }
        }
    }
};

Watcher.prototype._watchDir = function (dir, isRoot) {
    var self = this;
    if (dir in self._dirs) return self._dirs[dir];

    if (isRoot) {
        var options = {
          ignoreInitial: false,
          persistent: true
        };

        if (self._options.ignored) {
          options.ignored = self._options.ignored;
        }

        // with fs.watch we only need to attach a watcher to the root
        self._dirWatchers[dir] = chokidar.watch(dir, options);
        self._dirWatchers[dir].on('all', function (ev, filename, stat) {
            self._checkPath(filename, stat);
        });
        self._dirWatchers[dir].on('ready', function () {
          if (!self._isReady) {
            self._isReady = true;
            self._pathsAreSorted = false;
            self._onReady.resolve(true);
          }
        });
    }

    self._dirs[dir] = true;
};

Watcher.prototype._unwatchDir = function (dir) {
    if (this._dirWatchers[dir]) {
        try {
            this._dirWatchers[dir].close();
        } catch (e) {}
        delete this._dirWatchers[dir];
    }
    delete this._dirs[dir];
};

Watcher.prototype._isDir = function (path) {
    return !!this._dirs[path];
};

Watcher.prototype._onAdded = function (path, stat) {
    this._lastUpdate = Date.now();
    if (this._options.debug) {
        console.log('added ' + path);
    }
    this._paths[path] = stat;

    if (this._isReady) {
      this._pathsAreSorted = false;

      var event = {};
      event[path] = stat;
      this.trigger(event);
    }
};

Watcher.prototype._onDeleted = function (path) {
    this._lastUpdate = Date.now();
    var key;
    var deleted = {};

    for (key in this._paths) {
        if (key.length >= path.length && key.substr(0, path.length) === path) {
            if (this._isDir(this._paths[key])) {
                this._unwatchDir(this._paths[key]);
            }
            delete this._paths[key];
            deleted[key] = null;
        }
    }

    if (this._options.debug) {
        console.log('deleted ' + Object.keys(deleted).join(', '));
    }

    if (this._isReady) {
      this._pathsAreSorted = false;

      this.trigger(deleted);
    }
};

Watcher.prototype._onChanged = function (path, stat) {
    this._lastUpdate = Date.now();
    if (this._options.debug) {
        console.log('changed ' + path);
    }

    if (this._isReady) {
      this._paths[path] = stat;
      var event = {};
      event[path] = stat;
      this.trigger(event);
    }
};


module.exports = Watcher;
