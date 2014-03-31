var minimatch = require('minimatch');
var oid = require('oid');

var GlobEmitter = function(options) {
    this._options = options || {};
    this._nextEvent = null;
    this._globListeners = {};

    if (typeof this._options.debounceMs !== 'number') {
        this._options.debounceMs = 50;
    }

    this._bound_emitEvent = this._emitEvent.bind(this);
};

GlobEmitter.prototype.on = function (globs, callback) {
    if (!Array.isArray(globs)) globs = [globs];
    var callbackHash = oid.hash(callback);

    for (var i = 0; i < globs.length; i++) {
        var glob = globs[i];

        if (!this._globListeners[glob]) {
            this._globListeners[glob] = [];
        }

        this._globListeners[glob].push(callback);
    }
};

GlobEmitter.prototype.trigger = function (globData) {
    if (!this._nextEvent) {
        this._nextEvent = {globs:{}};
    } else {
        clearTimeout(this._nextEvent.timeout);
    }

    for (var key in globData) {
        this._nextEvent.globs[key] = globData[key];
    }

    this._nextEvent.timeout = setTimeout(this._bound_emitEvent, this._options.debounceMs);
};

GlobEmitter.prototype._emitEvent = function () {
    var globData = this._nextEvent.globs;

    this._nextEvent = null;

    var callbackHash;
    var callbackData = {};
    var callbacks = {};
    for (var path in globData) {
        for (var glob in this._globListeners) {
            if (minimatch(path, glob)) {
                var listeners = this._globListeners[glob];
                for (var i = 0; i < listeners.length; i++) {
                    callbackHash = oid.hash(listeners[i]);
                    if (!callbacks[callbackHash]) {
                        callbacks[callbackHash] = listeners[i];
                        callbackData[callbackHash] = {};
                    }

                    callbackData[callbackHash][path] = globData[path];
                }
            }
        }
    }

    for (callbackHash in callbacks) {
        try {
            callbacks[callbackHash](callbackData[callbackHash]);
        } catch (e) {
            console.error(e, e.stack);
        }
    }
};

module.exports = GlobEmitter;
