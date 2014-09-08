var oid = require('oid');

var MinimatchTree = require('minimagic').MinimatchTree;

var GlobEmitter = function(options) {
  this._options = options || {};
  this._nextEvent = null;
  this._globListeners = {};
  this._hashLookup = {};
  this._patternTree = new MinimatchTree();

  if (typeof this._options.debounceMs !== 'number') {
    this._options.debounceMs = 50;
  }

  this._bound_emitEvent = this._emitEvent.bind(this);
};

GlobEmitter.prototype.off = function(hash) {
  var globs = this._hashLookup[hash];
  if (!globs) return;

  for (var i = 0; i < globs.length; i++) {
    var glob = globs[i];
    var listeners = this._globListeners[glob]
    if (!listeners) continue;

    for (var j = 0; j < listeners.length; j++) {
      if (listeners[j].hash === hash) {
        this._patternTree.remove(glob, listeners[j]);
        this._globListeners[glob].splice(j, 1);
        j--;
      }
    }
  }
};

GlobEmitter.prototype.on = function(globs, callback) {
  if (!Array.isArray(globs)) globs = [globs];
  var listener = {
    fn: callback
  };
  listener.hash = oid.hash(listener);

  for (var i = 0; i < globs.length; i++) {
    var glob = globs[i];

    if (!this._globListeners[glob]) {
      this._globListeners[glob] = [];
    }

    this._globListeners[glob].push(listener);
    this._patternTree.add(glob, listener);
  }

  this._hashLookup[listener.hash] = globs;

  return listener.hash;
};

GlobEmitter.prototype.trigger = function(globData) {
  if (!this._nextEvent) {
    this._nextEvent = {
      globs: {}
    };
  } else {
    clearTimeout(this._nextEvent.timeout);
  }

  for (var key in globData) {
    this._nextEvent.globs[key] = globData[key];
  }

  this._nextEvent.timeout = setTimeout(this._bound_emitEvent, this._options.debounceMs);
};

GlobEmitter.prototype._emitEvent = function() {
  var globData = this._nextEvent.globs;
  var paths = Object.keys(globData);
  this._nextEvent = null;

  var calls = this._patternTree.find(paths);
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i];
    var callData = {};
    for (var j = 0; j < call.files.length; j++) {
      callData[call.files[j]] = globData[call.files[j]];
    }

    try {
      call.data.fn(callData);
    } catch (e) {
      console.error(e, e.stack);
    }
  }
};

module.exports = GlobEmitter;
