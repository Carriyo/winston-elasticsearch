/* eslint-disable */
var util = require('util');
var fs = require('fs');
var should = require('should');
var winston = require('winston');
var elasticsearch = require('@elastic/elasticsearch');

require('../index');
var defaultTransformer = require('../transformer');

var logMessage = JSON.parse(fs.readFileSync('./test/request_logentry_1.json', 'utf8'));

/*
 * Note: To run the tests, a running elasticsearch instance is required.
 */

// A null logger to prevent ES client spamming the console for deliberately failed tests
function NullLogger(config) {
  this.error = function(msg) { };
  this.warning = function(msg) { };
  this.info = function(msg) { };
  this.debug = function(msg) { };
  this.trace = function(msg) { };
  this.close = function(msg) { };
}

process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

function createLogger(buffering) {
  return winston.createLogger({
    transports: [
      new winston.transports.Elasticsearch({
        flushInterval: 1,
        buffering,
        clientOpts: {
          log: NullLogger,
          node: 'http://localhost:9200',
        }
      })]
  });
}

describe('the default transformer', function () {
  it('should transform log data from winston into a logstash like structure', function (done) {
    var transformed = defaultTransformer({
      message: 'some message',
      level: 'error',
      meta: {
        someField: true
      }
    });
    should.exist(transformed['@timestamp']);
    transformed.severity.should.equal('error');
    transformed.fields.someField.should.be.true();
    done();
  });
});

describe('a buffering logger', function () {
  it('can be instantiated', function (done) {
    this.timeout(8000);
    try {
      const logger = createLogger(true);
      logger.end();
    } catch (err) {
      should.not.exist(err);
    }

    // Wait for index template to settle
    setTimeout (function() {
      done();
    }, 4000)
  });

  it('should log simple message to Elasticsearch', function (done) {
    this.timeout(8000);
    const logger = createLogger(true);

    logger.log(logMessage.level, `${logMessage.message}1`);
    logger.on('finish', () => {
      done();
    });
    logger.on('error', (err) => {
      should.not.exist(err);
    });
    logger.on('warn', (err) => {
      should.not.exist(err);
    });
    logger.end();
  });

  it('should log with or without metadata', function (done) {
    this.timeout(8000);
    const logger = createLogger(true);

    logger.info('test test');
    logger.info('test test', 'hello world');
    logger.info({ message: 'test test', foo: 'bar' });
    logger.log(logMessage.level, `${logMessage.message}2`, logMessage.meta);
    logger.on('finish', () => {
      done();
    });
    logger.on('error', (err) => {
      should.not.exist(err);
    });
    logger.on('warn', (err) => {
      should.not.exist(err);
    });
    logger.end();
  });

  it('should update buffer properly in case of an error from elasticsearch.', function (done) {
    this.timeout(8000);
    const logger = createLogger(true);
    const transport = logger.transports[0];
    transport.bulkWriter.bulk.should.have.lengthOf(0)

    // mock client.bulk to throw an error
    transport.client.bulk = function() {
      return Promise.reject(new Error('Test Error'))
    };
    logger.on('error', (err) => {
      should.not.exist(err);
    });
    logger.on('warn', (err) => {
      console.log('got it!!!', err);
      should.exist(err);
      transport.bulkWriter.bulk.should.have.lengthOf(1);
      transport.bulkWriter.bulk = []; // manually clear the buffer of stop transport from attempting to flush logs.
      done();
    });
    logger.info('test');
    logger.end();
  });

  /*
  describe('the logged message', function () {
    it('should be found in the index', function (done) {
      var client = new elasticsearch.Client({
        host: 'localhost:9200',
        log: 'error'
      });
      client.search(`message:${logMessage.message}`).then(
        (res) => {
          res.hits.total.should.be.above(0);
          done();
        },
        (err) => {
          should.not.exist(err);
        }).catch((e) => {
          // prevent '[DEP0018] DeprecationWarning: Unhandled promise rejections are deprecated'
        });
    });
  });
  */
});


describe('a non buffering logger', function () {
  it('can be instantiated', function (done) {
    this.timeout(8000);
    try {
      const logger = createLogger(false);
      logger.end();
      done();
    } catch (err) {
      should.not.exist(err);
    }
  });

  it('should log simple message to Elasticsearch', function (done) {
    this.timeout(8000);
    const logger = createLogger(false);

    logger.log(logMessage.level, `${logMessage.message}1`);
    logger.on('finish', () => {
      done();
    });
    logger.on('error', (err) => {
      should.not.exist(err);
    });
    logger.on('warn', (err) => {
      should.not.exist(err);
    });
    logger.end();
  });
});

  // describe('a defective log transport', function () {
  //   it('emits an error', function (done) {
  //     this.timeout(40000);
  //     var transport = new (winston.transports.Elasticsearch)({
  //       clientOpts: {
  //         host: 'http://does-not-exist.test:9200',
  //         log: NullLogger,
  //       }
  //     });

  //     transport.on('error', (err) => {
  //       should.exist(err);
  //       done();
  //     });

  //     defectiveLogger = winston.createLogger({
  //       transports: [
  //         transport
  //       ]
  //     });
  //   });
  // });

  /* Manual test which allows to test re-connection of the ES client for unavailable ES instance.
  // Must be combined with --no-timeouts option for mocha
  describe('ES Re-Connection Test', function () {
    it('test', function (done) {
      this.timeout(400000);
      setInterval(function() {
        console.log('LOGGING...');
        const logger = createLogger(false);
        logger.log(logMessage.level, logMessage.message, logMessage.meta,
          function (err) {
            should.not.exist(err);
          });
        }, 3000);
      });
    });
  */
