var path = require('path');

module.exports = function(grunt) {
  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-jshint');

  grunt.initConfig({
    jshint: {
      test: {
        src: ['test/in/*.js']
      }
    },

    concat: {
      test: {
        files: [
          {
            src: ['test/in/*.js'],
            dest: 'test/out/concat.js'
          }
        ]
      }
    },

    'changed-only': {
      options: {
        cacheDir: path.join(__dirname, 'test', 'cache'),
        hashServer: {
          host: 'localhost',
          port: 11819
        }
      }
    },

    'changed-all': {
      options: {
        cacheDir: path.join(__dirname, 'test', 'cache'),
        hashServer: {
          host: 'localhost',
          port: 11819
        }
      }
    }
  })

  grunt.registerTask('test', ['changed-only:jshint:test']); //, 'changed-all:concat'])

  // Load local tasks.
  grunt.loadTasks('tasks');

  // Default task.
  grunt.registerTask('default', 'test');
};
