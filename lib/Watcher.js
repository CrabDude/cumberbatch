var chokidar = require('chokidar');
var fs = require('fs');
var minimatch = require('minimatch');
var oid = require('oid');
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

    this._bound_checkReady = this._checkReady.bind(this);
    this._isReady = false;
    this._lastUpdate = Date.now();
    this._watchDir(baseDir, true);

    this._onReady = Q.defer();
    this._checkReady();
};
util.inherits(Watcher, GlobEmitter);

Watcher.prototype.on = function (glob, callback) {
    var self = this;

    this.onReady(function () {
        GlobEmitter.prototype.on.call(self, glob, callback);
    });
};

Watcher.prototype.find = function (glob) {
    var globPaths = {};

    for (var path in this._paths) {
        if (minimatch(path, glob)) {
            globPaths[path] = this._paths[path];
        }
    }

    return globPaths;
};

Watcher.prototype.onReady = function (callback) {
    this._onReady.promise.then(function () {
        callback();
    });
};

Watcher.prototype._checkReady = function () {
    if (Date.now() - this._lastUpdate >= 3000) {
        this._isReady = true;
        this._onReady.resolve(true);
    } else {
        setTimeout(this._bound_checkReady, 1000);
    }
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
    var defer = Q.defer();

    if (!stat) {
        self._onDeleted(filename);
        defer.resolve(true);
    } else {
        if (self._paths[filename]) {
            self._onChanged(filename, stat);
            defer.resolve(true);
        } else {
            self._onAdded(filename, stat);
            if (stat.isDirectory()) {
                defer.resolve(self._watchDir(filename));
            } else {
                defer.resolve(true);
            }
        }
        }

    return defer.promise;
};

Watcher.prototype._watchDir = function (dir, isRoot) {
    var self = this;
    if (dir in self._dirs) return self._dirs[dir];

    if (isRoot) {
        // with fs.watch we only need to attach a watcher to the root
        self._dirWatchers[dir] = chokidar.watch(dir, {
            ignored: /(\.|\.git\/.*|node_modules\/.*|\.pyc)$/,
            ignoreInitial: false,
            persistent: true
        });
        self._dirWatchers[dir].on('all', function (ev, filename, stat) {
            self._checkPath(filename, stat);
        });
    }

    var defer = Q.resolve(true);

    self._dirs[dir] = defer.promise;
    return self._dirs[dir];
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

    var event = {};
    event[path] = stat;
    this.trigger(event);
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
        console.log('deleted ' + deleted.join(', '));
    }

    this.trigger(deleted);
};

Watcher.prototype._onChanged = function (path, stat) {
    this._lastUpdate = Date.now();
    if (this._options.changed) {
        console.log('changed ' + path);
    }

    this._paths[path] = stat;
    var event = {};
    event[path] = stat;
    this.trigger(event);
};


module.exports = Watcher;
