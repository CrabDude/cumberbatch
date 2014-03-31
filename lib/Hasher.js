var chokidar = require('chokidar');
var crypto = require('crypto');
var exec = require('child_process').exec;
var fs = require('fs');
var minimatch = require('minimatch');
var oid = require('oid');
var path = require('path');
var util = require('util');

var GlobEmitter = require('./GlobEmitter.js');
var Q = require('kew');

process.on('uncaughtException', function (err) {
    console.error(err, err.stack);
});

var Hasher = function (watcher, options) {
    GlobEmitter.call(this, options);

    var self = this;
    this._watcher = watcher;

    this._queue = [];
    this._pathHashes = {};
    this._mtimeCache = {};
    this._hashChanged = false;
    this._platform = process.platform;
    this._runners = 0;

    if (typeof this._options.parallelProcesses !== 'number') {
        this._options.parallelProcesses = 50;
    }

    if (this._options.cacheFile) {
        try {
            this._mtimeCache = JSON.parse(fs.readFileSync(this._options.cacheFile));
        } catch (e) {}

        setInterval(function () {
            if (!self._hashChanged) return;

            if (self._options.debug) {
                console.log('writing to cache file ' + self._options.cacheFile);
            }
            self._hashChanged = false;

            fs.writeFile(
                self._options.cacheFile,
                JSON.stringify(self._mtimeCache),
                {},
                function () {}
            );
        }, 10000);
    }

    this._readyPromises = [];
    this._onReady = null;
    this._bound_recalculateHashes = this._recalculateHashes.bind(this);
    this._bound_handleNext = this._handleNext.bind(this);
};
util.inherits(Hasher, GlobEmitter);

Hasher.prototype.onReady = function (callback) {
    if (!this._onReady) {
        this._onReady = Q.all(this._readyPromises);
    }
    this._onReady.then(callback);
};

Hasher.prototype.on = function (globs, callback) {
    GlobEmitter.prototype.on.call(this, globs, callback);
    if (!Array.isArray(globs)) globs = [globs];

    var self = this;

    this._watcher.on(globs, this._bound_recalculateHashes);

    var defer = Q.defer();
    this._watcher.onReady(function () {
        var promises = [];
        for (var i = 0; i < globs.length; i++) {
            promises.push(self._prefetchGlob(globs[i]));
        }
        defer.resolve(Q.all(promises));
    });
    this._readyPromises.push(defer);
};

Hasher.prototype.calculate = function (globs) {
    var defer = Q.defer();
    var self = this;

    if (!Array.isArray(globs)) globs = [globs];

    self.onReady(function () {
        var promises = [];
        var matchedFiles = {};

        for (var filename in self._pathHashes) {
            var matched = false;
            for (var i = 0; !matched && i < globs.length; i++) {
                if (minimatch(filename, globs[i])) {
                    matched = true;
                }
            }

            if (matched && !matchedFiles[filename]) {
                promises.push(self._pathHashes[filename]);
                matchedFiles[filename] = true;
            }
        }

        defer.resolve(Q.all(promises).then(function (hashes) {
            hashes.sort();
            var md5sum = crypto.createHash('md5');
            md5sum.update(hashes.join('|'));
            var hash = md5sum.digest('hex');
            return hash;
        }));
    });

    return defer.promise;
};

Hasher.prototype._prefetchGlob = function (glob) {
    var promises = [];
    var globData = this._watcher.find(glob);
    for (var filename in globData) {
        promises.push(this._calculateHash(filename, globData[filename]));
    }
    return Q.all(promises);
};

Hasher.prototype._recalculateHashes = function (globData) {
    var self = this;

    for (var key in globData) {
        var currentHash = this._pathHashes[key];
        delete this._pathHashes[key];

        var newHash = this._calculateHash(key, globData[key]);

        Q.all([key, currentHash, newHash])
            .then(function (vals) {
                if (vals[1] !== vals[2]) {
                    var event = {};
                    event[vals[0]] = vals[2];
                    self.trigger(event);
                }
            });
    }
};

Hasher.prototype._enqueue = function (fn) {
    this._queue.push(fn);
    if (this._runners < this._options.parallelProcesses) {
        this._runners++;
        this._handleNext();
    }
};

Hasher.prototype._handleNext = function () {
    if (!this._queue.length) {
        this._runners--;
        return;
    }

    var nextFn = this._queue.shift();
    nextFn(this._bound_handleNext);
};

Hasher.prototype._calculateHash = function (filename, stat) {
    var self = this;
    var cache = this._mtimeCache[filename];

    if (!this._pathHashes[filename]) {
        if (stat && stat.isDirectory()) {
            this._pathHashes[filename] = Q.resolve(null);
        } else if (stat && cache && Date.parse(stat.mtime) === cache.mtime) {
            this._pathHashes[filename] = Q.resolve(cache.hash);
        } else {
            this._pathHashes[filename] = this._getMD5ForFile(filename);
        }

        this._pathHashes[filename].then(function (hash) {
            self._mtimeCache[filename] = {
                mtime: Date.parse(stat.mtime),
                hash: hash
            };
            self._hashChanged = true;
            return hash;
        });
    }

    return this._pathHashes[filename];
};

Hasher.prototype._getMD5ForFile = function (filename) {
    var self = this;
    var defer = Q.defer();

    this._enqueue(function (callback) {
        if (self._platform === 'linux') {
            exec('md5sum ' + filename, function (err, stdout, stderr) {
                if (err || !stdout) defer.resolve(null);
                else defer.resolve(stdout.split(' ')[0]);
                callback();
            });
        } else {
            exec('md5 ' + filename, function (err, stdout, stderr) {
                if (err || !stdout) defer.resolve(null);
                else defer.resolve(stdout.split(' = ')[1].trim());
                callback();
            });
        }
    });

    return defer.promise;
};

Hasher.prototype._isDir = function (path) {
    return !!this._dirs[path];
};

module.exports = Hasher;
