var fs = require('fs');
var minimatch = require('minimatch');
var path = require('path');
var util = require('util');

var GlobEmitter = require('./GlobEmitter');
var Q = require('kew');
var WarmingLRU = require('./WarmingLRU');

var Watcher = function(baseDir, options) {
    GlobEmitter.call(this, options);
    var self = this;

    if (typeof this._options.debug !== 'boolean') {
        this._options.debug = false;
    }

    if (typeof this._options.usePolling !== 'boolean') {
        this._options.usePolling = false;
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

    // Temporarily support old polling mechanism
    // TODO: Remove support for polling once transition is finished.
    if (this._options.usePolling) {
      // Use our modified chokidar version.
      // Which is based on a now older chokidar version (0.8)
      this._chokidar = require('./chokidar');
      if (this._options.debug) {
        console.log('Using Polling');
      }
    } else {
      // Use the new version of chokidar which
      // has fixed some bugs related to polling
      // and that has improved support for non-polling.
      this._chokidar = require('chokidar');
      if (this._options.debug) {
        console.log('Not using Polling');
      }
    }

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
          persistent: true,
          alwaysStat: true,
          usePolling: !!this._options.usePolling
        };

        if (this._options.usePolling) {
          var hotInterval = this._options.hotFileInterval || 100;
          var warmInterval = this._options.warmFileInterval || 2000;
          var coldInterval = this._options.coldFileInterval || 4000;

          var maxHotFiles = this._options.maxHotFiles || 100;
          var maxWarmFiles = this._options.maxWarmFiles || 500;

          var hotFileFilter = this._options.hotFileFilter;

          options.interval = coldInterval;
        }

        if (self._options.ignored) {
          options.ignored = self._options.ignored;
        }

        if (self._options.binaryInterval) {
          options.binaryInterval = self._options.binaryInterval;
        }

        var fsWatcher = this._chokidar.watch(dir, options);

        if (this._options.usePolling) {
          var fileLru = self._fileLru = new WarmingLRU({
            maxHot: maxHotFiles,
            maxWarm: maxWarmFiles
          });

          fileLru.on('filesChanged', function(files) {
            for(var filename in files) {
              var heat = files[filename];
              var interval;
              switch (heat) {
                case 'hot':
                  interval = hotInterval;
                  break;
                case 'warm':
                  interval = warmInterval;
                  break;
                default:
                  interval = coldInterval;
                  break;
              }
              fsWatcher.setInterval(filename, interval);
            }
          });
        }

        var isReady = false;
        var allTimes = [];

        // with fs.watch we only need to attach a watcher to the root
        fsWatcher.on('all', function (ev, filename, stat) {
            if (self._options.usePolling) {
              if (hotFileFilter && hotFileFilter(filename)) {
                if (stat) {
                  if (!isReady) {
                    allTimes.push({'filename':filename, 'mtime':stat.mtime.getTime()/1000});
                  } else {
                    fileLru.set(filename, stat.mtime);
                  }
                } else {
                  fileLru.del(filename);
                }
              }
            }

            self._checkPath(filename, stat);
        });

        fsWatcher.on('ready', function () {
          if (self._options.usePolling) {
            allTimes.sort(function (a, b) {
                return b.mtime - a.mtime;
            });
            var end = Math.min(allTimes.length - 1, maxHotFiles + maxWarmFiles - 1);
            for (var i = end; i >= 0; i--) {
                var time = allTimes[i];
                fileLru.set(time.filename, time.mtime);
                if (i < maxHotFiles) {
                  fileLru.set(time.filename, time.mtime);
                }
            }
            allTimes = undefined;
          }
          isReady = true;

          if (!self._isReady) {
            self._isReady = true;
            self._pathsAreSorted = false;
            self._onReady.resolve(true);
          }
        });

        self._dirWatchers[dir] = fsWatcher;
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
