var cluster = require('cluster');
var exec = require('child_process').exec;
var fs = require('fs');
var http = require('http');
var minimatch = require('minimatch');
var path = require('path');
var querystring = require('querystring');
var util = require('util');

var FileHash = require('./FileHash');
var GlobEmitter = require('./GlobEmitter.js');
var PairingHeap = require('./PairingHeap.js');
var Q = require('kew');
var XXHash = require('xxhash');

// priorities for enqueued tasks, lower is retrieved first
var Priorities = {
  PREFETCH:      10000,
  RECALCULATION:  9999,
  REQUEST: 0
};

process.on('uncaughtException', function (err) {
    console.error(err, err.stack);
});

var Hasher = function (watcher, options) {
    GlobEmitter.call(this, options);

    var self = this;
    this._watcher = watcher;

    this._queue = new PairingHeap();
    this._enqueuedFiles = {};
    this._pathHashes = {};
    this._mtimeCache = {};
    this._hashChanged = false;
    this._platform = process.platform;
    this._runners = 0;
    this._numRequests = 0;
    this._workerCallbacks = {};

    this._bound_writeCacheFile = this._writeCacheFile.bind(this);

    if (typeof this._options.parallelHashers !== 'number') {
        this._options.parallelHashers = 20;
    }

    this._hasherProcesses = [];
    this._hasherProcessesPendingFiles = [];
    if (cluster.isMaster && this._options.clusterProcesses > 0) {
      cluster.setupMaster({
        exec: path.join(__dirname, 'HasherWorker.js')
      });

      for (var i = 0; i < this._options.clusterProcesses; i++) {
        cluster.fork();
      }
      console.log('SPAWNED', this._options.clusterProcesses, 'HASHER WORKERS');

      cluster.on('online', function(worker) {
        var workerIdx = self._hasherProcesses.length;
        self._hasherProcesses.push(worker);
        self._hasherProcessesPendingFiles[workerIdx] = 0;

        worker.on('message', function(msg) {
          if (msg.pong === true) {
            // make another slot on the worker available
            self._markWorkerProcessingFileComplete(workerIdx);
          } else {
            var callback = self._workerCallbacks[msg.filename];
            if (typeof callback === 'undefined') return;
            delete self._workerCallbacks[msg.filename];

            callback(msg.hash);
          }
        });

        var sendPing = function() {
          worker.send({ping: true});
        };
        setInterval(sendPing, 5000);
        sendPing();
      });
    }

    if (this._options.cacheFile) {
        try {
            this._mtimeCache = JSON.parse(fs.readFileSync(this._options.cacheFile));
        } catch (e) {
            console.error(e);
        }
    }

    var httpClientConfig = this._options.httpClient;
    if (httpClientConfig) {
        var host = httpClientConfig.host || '127.0.0.1';
        // proxies the default methods through as http requests
        this.calculateFileHashes = this._createHttpRequest.bind(
            this, 'calculateFileHashes', host, httpClientConfig.port);
        this.calculateGlobFileHashes = this._createHttpRequest.bind(
            this, 'calculateGlobFileHashes', host, httpClientConfig.port);
        this.calculateGlobHash = this._createHttpRequest.bind(
            this, 'calculateGlobHash', host, httpClientConfig.port);

    } else {
        var httpServerConfig = this._options.httpServer;
        if (httpServerConfig) {
            var host = httpServerConfig.host || '127.0.0.1';
            var port = httpServerConfig.port;
            http.createServer(this._handleHttpRequest.bind(this)).listen(port, host);
            console.log('Started hasher http server at ' + host + ':' + port);
        }

        this._readyPromises = [];
        this._onReady = null;
        this._bound_recalculateHashes = this._recalculateHashes.bind(this);
        this._bound_handleNext = this._handleNext.bind(this);
    }
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
        var negations = [];
        for (var i = 0; i < globs.length; i++) {
            var glob = globs[i];
            try {
                if (glob.indexOf('!') === 0) {
                    negations.push(glob);
                } else {
                    promises.push(self._prefetchGlob(glob));
                }
            } catch (e) {
                console.error(e);
            }
        }
        defer.resolve(Q.all(promises));
    });
    this._readyPromises.push(defer.promise);
    return defer.promise;
};

Hasher.prototype.calculateFileHashes = function (files) {
    var promises = [];
    // requests should have different priorities, this will loop around every 10,000 requests
    // but it should be hardly noticeable
    var priority = Priorities.REQUEST + (++this._numRequests % 9999);
    for (var i = 0; i < files.length; i++) {
        promises.push(this._calculateHash(files[i], undefined, priority));
    }
    return Q.all(promises).then(function (hashes) {
        var map = {};
        for (var i = 0; i < hashes.length; i++) {
            map[files[i]] = hashes[i];
        }
        return map;
    });
};

Hasher.prototype.calculateGlobFileHashes = function (globs) {
    var defer = Q.defer();
    var self = this;

    if (!Array.isArray(globs)) globs = [globs];

    self.onReady(function () {
        var files = [];
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
                files.push(filename);
                matchedFiles[filename] = true;
            }
        }

        defer.resolve(self.calculateFileHashes(files));
    });

    return defer.promise;
};

Hasher.prototype.calculateGlobHash = function (globs) {
    return this.calculateGlobFileHashes(globs)
        .then(function (map) {
            var hashes = [];
            for (var key in map) {
                hashes.push(map[key]);
            }
            hashes.sort();

            var hasher = new XXHash(0x01234ABC);
            for (var i = 0; i < hashes.length; i++) {
                hasher.update(hashes[i]);
                hasher.update('|');
            }
            return hasher.digest();
        })
}

Hasher.prototype._forceUpdateCacheFile = function () {
    if (!this._options.cacheFile) return;
    this._hashChanged = true;

    if (this._cacheFileTimer) {
        clearTimeout(this._cacheFileTimer);
    }

    this._cacheFileTimer = setTimeout(this._bound_writeCacheFile, 5000);
};

Hasher.prototype._writeCacheFile = function () {
    delete this._cacheFileTimer;
    if (!this._options.cacheFile) return;

    if (this._options.debug) {
        console.log('writing to cache file ' + this._options.cacheFile);
    }
    this._hashChanged = false;

    fs.writeFile(
        this._options.cacheFile,
        JSON.stringify(this._mtimeCache),
        {},
        function () {}
    );
};

Hasher.prototype._encodeHttpData = function (data) {
    return querystring.stringify({body:JSON.stringify(data)});
};

Hasher.prototype._decodeHttpData = function (body) {
    var dataObj = querystring.parse(body);
    return JSON.parse(dataObj.body);
};

Hasher.prototype._createHttpRequest = function (method, host, port, var_args) {
    var data = this._encodeHttpData({
        args: Array.prototype.slice.call(arguments, 3)
    });

    var options = {
        host: host,
        port: port,
        path: '/' + method,
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': data.length
        }
    };

    var defer = Q.defer();
    var req = http.request(options, function (res) {
        var data = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            data += chunk;
        });
        res.on('end', function () {
            defer.resolve(JSON.parse(data));
        });
    });
    req.write(data);
    req.end();

    return defer.promise;
};

Hasher.prototype._handleHttpRequest = function (req, res) {
    req.setEncoding('utf8');
    var self = this;
    var data = '';

    req.on('data', function (chunk) {
        data += chunk;
    });

    req.on('end', function() {
        self.onReady(function() {
            try {
                var dataObj = self._decodeHttpData(data);;
                var qIndex = req.url.indexOf('?');
                var method = qIndex >= 0 ? req.url.substr(1, qIndex - 1) : req.url.substr(1);

                self[method].apply(self, dataObj.args)
                    .then(function (response) {
                        res.writeHead(200, {'Content-Type': 'text/plain'});
                        res.end(JSON.stringify(response, null, 2));
                    })
                    .fail(function (e) {
                        console.error(e);
                    })
            } catch (e) {
                console.error(e);
            }
        });
    })
};

Hasher.prototype._prefetchGlob = function (glob) {
    var promises = [];
    var globData = this._watcher.find(glob);
    for (var filename in globData) {
        // calculating the hash during prefetching gets a low priority to make
        // room for explicit requests
        promises.push(this._calculateHash(filename, globData[filename], Priorities.PREFETCH));
    }
    return Q.all(promises);
};

Hasher.prototype._recalculateHashes = function (globData) {
    var self = this;

    for (var key in globData) {
        var currentHash = this._pathHashes[key];
        delete this._pathHashes[key];

        var newHash = this._calculateHash(key, globData[key], Priorities.RECALCULATION);

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

Hasher.prototype._enqueue = function (fn, priority) {
    var subHeap = new PairingHeap(priority || 0, fn);
    this._queue = this._queue.insertHeap(priority || 0, subHeap);
    if (this._runners < this._options.parallelHashers) {
        this._runners++;
        this._handleNext();
    }
    return subHeap;
};

Hasher.prototype._handleNext = function () {
    var nextFn = this._queue.getData();
    if (!nextFn) {
        this._runners--;
        return;
    }

    this._queue = this._queue.removeMin();
    nextFn(this._bound_handleNext);
};

Hasher.prototype._calculateHash = function (filename, stat, priority) {
    var self = this;
    var cache = this._mtimeCache[filename];

    if (!this._pathHashes[filename]) {
        if (stat && stat.isDirectory()) {
            this._pathHashes[filename] = Q.resolve(null);
        } else if (stat && cache && Date.parse(stat.mtime) === cache.mtime) {
            this._pathHashes[filename] = Q.resolve(cache.hash);
        } else {
            this._pathHashes[filename] = this._getHashForFile(filename, priority);
        }

        this._pathHashes[filename].then(function (hash) {
            if (stat) {
                self._mtimeCache[filename] = {
                    mtime: Date.parse(stat.mtime),
                    hash: hash
                };
                self._forceUpdateCacheFile();
            }
            return hash;
        });
    }

    return this._pathHashes[filename];
};

Hasher.prototype._markWorkerProcessingFileComplete = function(idx) {
  if (this._hasherProcessesPendingFiles[idx] > 0) {
    this._hasherProcessesPendingFiles[idx]--;
  }
};

Hasher.prototype._markWorkerProcessingFile = function(idx) {
  this._hasherProcessesPendingFiles[idx]++;
};

Hasher.prototype._workerIsAvailable = function (idx) {
  return this._hasherProcessesPendingFiles[idx] < this._options.parallelHashers;
};

Hasher.prototype._selectWorker = function () {
  if (this._hasherProcesses.length === 0) {
    return undefined;
  }

  for (var i = 0; i < 5; i++) {
    var workerIdx = Math.floor(Math.random() * this._hasherProcesses.length);
    if (this._workerIsAvailable(workerIdx)) {
      return workerIdx;
    }
  }

  return undefined;
};

Hasher.prototype._getHashForFile = function (filename, priority) {
    if (!this._enqueuedFiles[filename]) {
      // if the file isn't currently enqueued, enqueue it for hashing
      var self = this;
      var defer = Q.defer();

      var heap = this._enqueue(function (callback) {
          if (self._options.debug) {
              console.log('calculating hash for', filename, 'at priority', priority);
          }
          var workerIdx = self._selectWorker();
          var workerTimeout;
          var processed = false;

          var hasherCallback = function(hash) {
            if (processed === true) {
              return;
            }
            processed = true;

            if (workerTimeout !== undefined) {
              // worker finished before the timeout, mark this complete
              self._markWorkerProcessingFileComplete(workerIdx);
              clearTimeout(workerTimeout);
              workerTimeout = undefined;
            }

            delete self._enqueuedFiles[filename];
            defer.resolve(hash);
            callback();
          };

          var onTimeout = function() {
            clearTimeout(workerTimeout);
            workerTimeout = undefined;
            FileHash.generate(filename, hasherCallback);
          };

          if (workerIdx !== undefined) {
            self._markWorkerProcessingFile(workerIdx);
            var worker = self._hasherProcesses[workerIdx];
            self._workerCallbacks[filename] = hasherCallback;
            worker.send({filename: filename});

            workerTimeout = setTimeout(onTimeout, 5000);
          } else {
            FileHash.generate(filename, hasherCallback);
          }

      }, priority);

      this._enqueuedFiles[filename] = {
        promise: defer.promise,
        priority: priority,
        heap: heap
      };

    } else if (this._enqueuedFiles[filename].priority > priority) {
      // adjust the priority if a file is requested with a lower priority
      this._queue = this._queue.insertHeap(priority, this._enqueuedFiles[filename].heap);
    }

    return this._enqueuedFiles[filename].promise;
};

Hasher.prototype._isDir = function (path) {
    return !!this._dirs[path];
};

module.exports = Hasher;
