var cumberbatch = require('./main');
var path = require('path');

process.on('uncaughtException', function (e) {
    console.error(e, e.stack);
});

var watcher = new cumberbatch.Watcher(path.join(__dirname, 'test'), {
    debug: true
});


watcher.on(path.join(__dirname, '**', '*.js'), function (files) {
    console.log('js changed', files);
});

watcher.onReady(function () {
    console.log('WATCHER IS READY!');
});

var hasher = new cumberbatch.Hasher(watcher, {
    cacheFile: path.join(__dirname, '.cumberpatchCache'),
    debug: true
});

hasher.on('**/*.js', function (data) {
    console.log('HASHER CHANGED', data);
});

hasher.onReady(function () {
    console.log('HASHER IS READY');
    hasher.calculate('**/*.js').then(function (md5) {
        console.log('MD5 IS', md5);
    });
});
