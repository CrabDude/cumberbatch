var cluster = require('cluster');
var FileHash = require('./FileHash');

if (cluster.isWorker) {
  process.send('online');

  process.on('message', function(msg) {
    FileHash.generate(msg.filename, function (hash) {
      process.send({
        filename: msg.filename,
        hash: hash
      })
    });
  })
}
