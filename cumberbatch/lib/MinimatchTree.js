var minimatch = require('minimatch');
var oid = require('oid');

var MinimatchTree = function() {
  this._roots = [];
  this._rootData = {};
  this._exactMatches = {};
};

MinimatchTree.prototype.add = function (glob, data) {
  var globRoot = this._getGlobRoot(glob);
  var hash = oid.hash(data);
  var isNegation = this._isNegation(glob);
  if (isNegation) {
      glob = glob.substr(1);
  }

  if (globRoot === glob) {
    if (typeof(this._exactMatches[glob]) === 'undefined') {
      this._exactMatches[glob] = [];
    }

    // exact filename special case
    this._exactMatches[glob].push({
      glob: glob,
      data: data,
      hash: hash,
      isNegation: isNegation
    });
    return;
  }

  var globRootParts = globRoot.split(/\//);
  var globRootStems = [globRootParts[0]];
  for (var i = 1; i < globRootParts.length; i++) {
    globRootStems.push(globRootStems[globRootStems.length - 1] + '/' + globRootParts[i]);
  }

  var globExtensions = this._getGlobExtensions(glob);
  var extensionMap = {'*':true};
  for (var i = 0; i < globExtensions.length; i++) {
    extensionMap[globExtensions[i]] = true;
  }

  var globObj = {
    glob: glob,
    extensions: extensionMap,
    data: data,
    hash: hash,
    isNegation: isNegation
  };

  if (typeof this._rootData[globRoot] === 'undefined') {
    this._rootData[globRoot] = [globObj];
    this._roots.push({globRoot: globRoot, stems: globRootStems});
  } else {
    this._rootData[globRoot].push(globObj);
  }

  this._roots.sort(function (a, b) {
    if (a.globRoot === b.globRoot) return 0;
    return a.globRoot < b.globRoot ? -1 : 1;
  });
};

MinimatchTree.prototype.remove = function (glob, data) {
  var globRoot = this._getGlobRoot(glob);
  var hash = oid.hash(data);

  var matches = globRoot === glob ? this._exactMatches[glob] : this._rootData[globRoot];
  if (typeof matches !== 'undefined') {
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].hash === hash) {
        matches.splice(i, 1);
        i--;
      }
    }
  }
};

MinimatchTree.prototype.find = function (filenames) {
  if (this._roots.length === 0) return [];
  if (filenames.length === 0) return [];

  // keep the files sorted for ease of walking the patterns
  filenames.sort();

  var callbacks = {}, negatedMap = {}, foundMap = {};
  var globIdx, stemIdx, fileIdx = 0;

  // binary search to find the starting point for the glob / file traversal
  var min = 0;
  var max = this._roots.length - 1;
  while (min <= max) {
    var curr = (min + max) / 2 | 0;
    var root = this._roots[curr];

    if (root.globRoot < filenames[0]) {
        min = curr + 1;
    } else if (root.globRoot > filenames[0]) {
        max = curr - 1;
    } else {
        break;
    }
  }

  globIdx = curr > 0 ? curr - 1 : curr;
  stemIdx = this._roots[globIdx].stems.length - 1;

  for (var fileIdx = 0; fileIdx < filenames.length; fileIdx++) {
    var filename = filenames[fileIdx];

    var exactMatches = this._exactMatches[filename];
    if (typeof exactMatches !== 'undefined') {
      // handle the exact filename match case
      for (var matchIdx = 0; matchIdx < exactMatches.length; matchIdx++) {
        var pattern = exactMatches[matchIdx];

        if (!pattern.isNegation) {
          // make sure the file isn't in the negation map and queue the callback
          if (typeof negatedMap[pattern.hash] !== 'undefined'
              && negatedMap[pattern.hash][filename] === true) {
            continue;
          }

          if (typeof foundMap[pattern.hash] === 'undefined') {
            foundMap[pattern.hash] = {};
          }

          foundMap[pattern.hash][filename] = true;
          callbacks[pattern.hash] = pattern.data;
        } else {
          // mark the hash as negated for this file
          if (typeof negatedMap[pattern.hash] === 'undefined') {
            negatedMap[pattern.hash] = {};
          }
          negatedMap[pattern.hash][filename] = true;
          if (typeof foundMap[pattern.hash] !== 'undefined') {
            delete foundMap[pattern.hash][filename];
          }
        }
      }
    }

    // opportunistically walk to the next glob if it's a substring of the
    // current path
    while (globIdx < this._roots.length - 1) {
      var nextGlob = this._roots[globIdx + 1];
      var nextRoot = nextGlob.globRoot;
      if (filename.substr(0, nextRoot.length) !== nextRoot && filename < nextRoot) {
        // if the next glob isn't a substring of this file but is still greater
        // the file, don't increment the glob index
        break;
      }
      stemIdx = nextGlob.stems.length - 1;
      globIdx++;
    }

    var currentGlobRoot = this._roots[globIdx];

    // walk back down the stems if they're not substrings
    while (stemIdx >= 0) {
      var currentStem = currentGlobRoot.stems[stemIdx];
      if (filename.length < currentStem.length || filename.substr(0, currentStem.length) !== currentStem) {
        stemIdx--;
      } else {
        break;
      }
    }

    // exit early if no stems match
    if (stemIdx < 0) continue;

    // extract the file extension for additional filtering
    var matches = filename.match(/\.([^\.]+)$/);
    var fileExtension = matches && matches[1];

    for (var i = 0; i <= stemIdx; i++) {
      // iterate through each stem looking for patterns to match against
      var stem = currentGlobRoot.stems[i];
      var patterns = this._rootData[stem];

      if (typeof patterns !== 'undefined') {
        // loop through all the patterns for the current stem
        for (var j = 0; j < patterns.length; j++) {
          var pattern = patterns[j];

          if (pattern.extensions['*'] !== true &&
            (typeof fileExtension === 'undefined' || pattern.extensions[fileExtension] === true)) {
            continue;
          }

          if (minimatch(filename, pattern.glob)) {
            if (!pattern.isNegation) {
              // make sure the file isn't in the negation map and queue the callback
              if (typeof negatedMap[pattern.hash] !== 'undefined'
                  && negatedMap[pattern.hash][filename] === true) {
                continue;
              }

              if (typeof foundMap[pattern.hash] === 'undefined') {
                foundMap[pattern.hash] = {};
              }

              foundMap[pattern.hash][filename] = true;
              callbacks[pattern.hash] = pattern.data;
            } else {
              // mark the hash as negated for this file
              if (typeof negatedMap[pattern.hash] === 'undefined') {
                negatedMap[pattern.hash] = {};
              }
              negatedMap[pattern.hash][filename] = true;
              if (typeof foundMap[pattern.hash] !== 'undefined') {
                delete foundMap[pattern.hash][filename];
              }
            }
          }

        }
      }
    }
  }

  var response = [];
  for (var key in foundMap) {
    var files = Object.keys(foundMap[key]);
    if (files.length !== 0) {
      response.push({data: callbacks[key], files: files});
    }
  }
  return response;
};

MinimatchTree.prototype._getGlobRoot = function (glob) {
  // remove any negation symbols
  var pathGlob = glob.indexOf('!') === 0 ? glob.substr(1) : glob;

  // find the root of the glob for the tree
  var globParts = pathGlob.split(/\*|\{/);
  var globRoot;
  var matches;
  if (globParts.length === 1) {
    globRoot = globParts[0]
  } else if (matches = globParts[0].match(/^(.*)\/[^\/]*$/)) {
    globRoot = matches[1];
  } else {
    globRoot = '';
  }
  return globRoot;
};

MinimatchTree.prototype._isNegation = function (glob) {
  return glob.indexOf('!') === 0;
};

MinimatchTree.prototype._getGlobExtensions = function (glob) {
  var globSuffix = glob.split(/\//).pop().split(/\./).pop();
  var extensions;

  if (globSuffix.match(/^[a-zA-Z0-9\_\-]+$/)) {
    return [globSuffix];
  } else if (globSuffix.match(/^\{(?:[a-zA-Z0-9\_\-]+)(?:,[a-zA-Z0-9\_\-]+)*\}$/)) {
    return globSuffix.substr(1, globSuffix.length - 2).split(',');
  } else {
    return [];
  }
};

module.exports = MinimatchTree;
