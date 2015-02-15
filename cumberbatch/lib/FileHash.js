var fs = require('fs');
var XXHash = require('xxhash');

module.exports.generate = function (filename, callback) {
  // no security needed, just an arbitrary seed
  var hasher = new XXHash(0xABCDE012);

  fs.createReadStream(filename)
      .on('data', function(data) {
        // console.log('--', filename, data.length);
          hasher.update(data);
      })
      .on('end', function() {
          var hash = hasher.digest();
          callback(String(hash));
      })
      .on('error', function() {
          callback(null);
      });
}
