var cluster = require('cluster');
var FileHash = require('./FileHash');

if (cluster.isWorker) {
  process.send('online');
  var count = 0;

  process.on('message', function(msg) {
    if (msg.ping === true) {
      process.send({
        pong: true
      });
    } else {
      FileHash.generate(msg.filename, function (hash) {
        process.send({
          filename: msg.filename,
          hash: hash
        })
      });
    }
  })
}
