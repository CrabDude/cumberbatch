var events = require('events');
var util = require('util');

var LRU = require('lru-cache');

var WarmingLRU = function(options) {
  this._hotLru = LRU({
    max: options.maxHot,
    dispose: this.fileChanged.bind(this)
  });

  this._warmLru = LRU({
    max: options.maxWarm + options.maxHot,
    dispose: this.fileChanged.bind(this)
  });

  this._pendingFiles = {};
  this._pendingTimeout = undefined;
  this._bound_pendingHandler = this._pendingHandler.bind(this);
};
util.inherits(WarmingLRU, events.EventEmitter);

WarmingLRU.prototype.set = function (key, val) {
  var inHot = this._hotLru.has(key),
      inWarm = this._warmLru.has(key);

  if (inHot || inWarm) {
    this._hotLru.set(key, val);
    this._warmLru.set(key, val);
    this.fileChanged(key);
  } else {
    this._warmLru.set(key, val);
    this.fileChanged(key);
  }
};

WarmingLRU.prototype.del = function (key) {
  if (this._hotLru.has(key)) {
    this._hotLru.del(key);
    this._warmLru.del(key);
  } else if (this._warmLru.has(key)) {
    this._warmLru.del(key);
  }
  delete this._pendingFiles[key];
};

WarmingLRU.prototype._pendingHandler = function () {
  var pendingFiles = Object.keys(this._pendingFiles);
  this._pendingFiles = {};

  var heatMap = {};
  for (var i = 0; i < pendingFiles.length; i++) {
    var filename = pendingFiles[i];
    if (this._hotLru.has(filename)) {
      heatMap[filename] = 'hot';
    } else if (this._warmLru.has(filename)) {
      heatMap[filename] = 'warm';
    } else {
      heatMap[filename] = 'cold';
    }
  }

  this.emit('filesChanged', heatMap);
};

WarmingLRU.prototype.fileChanged = function (key) {
  this._pendingFiles[key] = true;
  if (this._pendingTimeout) {
    clearTimeout(this._pendingTimeout);
  }
  this._pendingTimeout = setTimeout(this._bound_pendingHandler, 20);
};

module.exports = WarmingLRU;
