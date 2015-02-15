var cumberbatch = require('./main');
var fs = require('fs');
var mkdirp = require('mkdirp');
var path = require('path');

var paths = [];
var chars = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
var extensions = ['js', 'html', 'css', 'json', 'nunjucks', 'py'];
var counts = 0;
var errCount = 0;
var totalWrites = 0;
var totalMisses = 0;
var totalHeldover = 0;

chars.forEach(function (first) {
  chars.forEach(function (second) {
    counts++;
    paths.push(path.join(__dirname, 'LOAD_TEST', first, second));
  })
})

var pendingFiles = {};
var handleFile = function (fileMap) {
  var handledCount = 0;
  for (var key in fileMap) {
    delete pendingFiles[key];
    handledCount++;
  }
  console.log("HANDLED", handledCount, "FILE UPDATES");
};

var updateRandomFiles = function (count) {
  var now = Math.floor(Date.now() / 1000);
  var data = String(now);
  for (var i = 0; i < count; i++) {
    var filename = path.join(
      __dirname,
      'LOAD_TEST',
      chars[Math.floor(Math.random() * chars.length)],
      chars[Math.floor(Math.random() * chars.length)],
      chars[Math.floor(Math.random() * chars.length)] + '.' +
        extensions[Math.floor(Math.random() * extensions.length)]
    );
    pendingFiles[filename] = now;
    fs.writeFile(filename, data, function(err) {
      if (err) {
        delete pendingFiles[filename];
        errCount++;
        if (errCount > 100) {
          console.error(err);
          console.error("ERROR COUNT EXCEEDED 100");
          process.exit();
        }
      }
    });
  }

  totalWrites += count;
  console.log('UPDATED', count, 'FILES');
}

var heldoverFiles = {};
var validateCounts = function() {
  var newHeldoverFiles = {};
  var numMissed = 0;
  var numHeldover = 0;
  for (var key in pendingFiles) {
    newHeldoverFiles[key] = true;
    numMissed++;
    if (heldoverFiles[key] === true) {
      numHeldover++;
    }
  }
  heldoverFiles = newHeldoverFiles;
  console.log('-----\nUNHANDLED PATHS: ' + numMissed + ' (' + numHeldover +
    ' HELDOVER)\nTOTAL WRITES: ' + totalWrites + ' / MISSED: ' + totalMisses + ' / HELDOVER: ' +
    totalHeldover + '\n-----');
  totalMisses += numMissed;
  totalHeldover += numHeldover;
};

var startTest = function() {
  var watcher = new cumberbatch.Watcher(path.join(__dirname, 'LOAD_TEST'), {
    ignored: function (path) {
      return false;
    },
    coldFileInterval: 250,
    binaryInterval: 4000,
    debug: false
  });

  var hasher = new cumberbatch.Hasher(watcher, {
    cacheFile: path.join(__dirname, 'LOAD_TEST', '.cumberbatchCache'),
    clusterProcesses: 1,
    debug: false,
    httpServer: {
      port: 1234
    }
  });

  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.js'), handleFile);
  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.css'), handleFile);
  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.html'), handleFile);
  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.nunjucks'), handleFile);
  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.py'), handleFile);
  hasher.on(path.join(__dirname, 'LOAD_TEST', '**/*.json'), handleFile);

  hasher.onReady(function() {
    var intervalCount = 0;
    setInterval(function() {
      if (intervalCount++ % 10 === 0) {
        validateCounts();
      } else {
        updateRandomFiles(Math.floor(Math.random() * 300));
      }
      intervalCount++;
    }, 2000);
  });
};

var callback = function() {
  counts--;
  if (counts === 0) {
    startTest();
  }
}
paths.forEach(function (p) {
  mkdirp(p, callback);
})

console.log(paths.length);

// var watcher = new cumberbatch.Watcher(paths.PROJECT_DIR, }
// )
