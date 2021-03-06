/* eslint no-underscore-dangle: ['error', { 'allow': ['_index', '_type'] }] */

const fs = require('fs');
const path = require('path');
const Promise = require('promise');
const debug = require('debug')('winston:elasticsearch');
const retry = require('retry');

const BulkWriter = function BulkWriter(transport, client, options) {
  this.transport = transport;
  this.client = client;
  this.options = options;
  this.interval = options.interval || 5000;
  this.waitForActiveShards = options.waitForActiveShards;
  this.pipeline = options.pipeline;
  this.retryLimit = options.retryLimit || 5;

  this.bulk = []; // bulk to be flushed
  // logger is only "initialized" when at least one connection to ES is
  // made, and if the template mapping is sucessfully written (if template
  // mapping is enabled).
  this.initialized = false;
  this.running = false;
  this.timer = false;
  debug('created', this);
};

BulkWriter.prototype.start = function start() {
  this.checkEsConnection();
  debug('started');
};

BulkWriter.prototype.stop = function stop() {
  this.running = false;
  if (!this.timer) {
    return;
  }
  clearTimeout(this.timer);
  this.timer = null;
  debug('stopped');
};

BulkWriter.prototype.schedule = function schedule() {
  const thiz = this;
  this.timer = setTimeout(() => {
    thiz.tick();
  }, this.interval);
};

BulkWriter.prototype.tick = function tick() {
  debug('tick');
  const thiz = this;
  if (!this.running) {
    return;
  }
  this.flush()
    .then(() => {
      // Emulate finally with last .then()
    })
    .then(() => {
      // finally()
      thiz.schedule();
    });
};

BulkWriter.prototype.flush = function flush() {
  // write bulk to elasticsearch
  if (this.bulk.length === 0) {
    debug('nothing to flush');
    return new Promise((resolve) => {
      // pause if nothing is there to write
      this.running = false;
      return resolve();
    });
  }
  const bulk = this.bulk.concat();
  this.bulk = [];
  const body = [];
  bulk.forEach(({
    index, type, doc, attempts
  }) => {
    body.push(
      { index: { _index: index, _type: type, pipeline: this.pipeline }, attempts },
      doc
    );
  });
  debug('bulk writer is going to write', body);
  return this.write(body);
};

BulkWriter.prototype.append = function append(index, type, doc) {
  if (this.options.buffering === true) {
    if (
      typeof this.options.bufferLimit === 'number'
      && this.bulk.length >= this.options.bufferLimit
    ) {
      const msg = this.bulk.pop();
      debug('message discarded because buffer limit exceeded');
      this.transport.emit('log-discarded', msg);
    }
    this.bulk.unshift({
      index,
      type,
      doc,
      attempts: 0
    });
    // resume the buffering process
    if (this.initialized && !this.running) {
      this.running = true;
      this.tick();
    }
  } else {
    // if not initialized can't write
    if (!this.initialized) {
      return;
    }
    this.write([
      { index: { _index: index, _type: type, pipeline: this.pipeline } },
      doc
    ]);
  }
};

BulkWriter.prototype.write = function write(body) {
  const thiz = this;
  return this.client
    .bulk({
      body,
      waitForActiveShards: this.waitForActiveShards,
      timeout: this.interval + 'ms',
    })
    .then((response) => {
      const res = response.body;
      if (res && res.errors && res.items) {
        res.items.forEach((item) => {
          if (item.index && item.index.error) {
            // eslint-disable-next-line no-console
            debug('elasticsearch index error', item.index);
            throw new Error('ElasticSearch index error');
          }
        });
      }
    })
    .catch((e) => {
      // rollback this.bulk array
      const newBody = [];
      for (let i = 0; i < body.length; i += 2) {
        const { attempts } = body[i];
        if (attempts < thiz.retryLimit) {
          newBody.push({
            index: body[i].index._index,
            type: body[i].index._type,
            doc: body[i + 1],
            attempts: attempts + 1,
          });
        } else {
          debug('retry attempts exceeded');
          thiz.transport.emit('log-error', {
            message: 'retry attempts exceeded',
            err: e
          });
        }
      }

      const lenSum = thiz.bulk.length + newBody.length;
      if (thiz.options.bufferLimit && lenSum >= thiz.options.bufferLimit) {
        thiz.bulk = newBody.concat(
          thiz.bulk.slice(0, thiz.options.bufferLimit - newBody.length)
        );
      } else {
        thiz.bulk = newBody.concat(thiz.bulk);
      }
      debug('error occurred', e);
      this.stop();
      this.checkEsConnection();
      thiz.transport.emit('warn', e);
    });
};

BulkWriter.prototype.checkEsConnection = function checkEsConnection() {
  const thiz = this;
  thiz.esConnection = false;

  const operation = retry.operation({
    // test will never end if mapping template creation is retried forever
    forever: process.env.TEST_ENV !== 'TRUE',
    retries: 1,
    factor: 1,
    minTimeout: 1 * 1000,
    maxTimeout: 60 * 1000,
    randomize: false
  });
  return setTimeout(() => {
    operation.attempt((currentAttempt) => {
      debug('checking for connection');
      thiz.client.cluster.health({
        timeout: '5s',
        wait_for_nodes: '>=1',
        wait_for_status: 'yellow'
      })
        .then(
          (res) => {
            thiz.esConnection = true;
            const startWriter = () => {
              thiz.initialized = true;
              if (thiz.options.buffering === true) {
                debug('starting bulk writer');
                thiz.running = true;
                thiz.tick();
              }
            };
            // Ensure mapping template is existing if desired
            if (thiz.options.ensureMappingTemplate) {
              thiz.ensureMappingTemplate(startWriter, (err) => {
                debug('retrying mapping template creation');
                if (operation.retry(err)) {
                  return;
                }
                thiz.transport.emit('error', err);
              });
            } else {
              startWriter();
            }
          },
          (err) => {
            debug('checking for connection');
            if (operation.retry(err)) {
              return;
            }
            // thiz.esConnection = false;
            thiz.transport.emit('error', err);
          }
        );
    });
  }, 0);
};

BulkWriter.prototype.ensureMappingTemplate = function ensureMappingTemplate(
  fulfill,
  reject
) {
  const thiz = this;

  const indexPrefix = typeof thiz.options.indexPrefix === 'function'
    ? thiz.options.indexPrefix()
    : thiz.options.indexPrefix;
  // eslint-disable-next-line prefer-destructuring
  let mappingTemplate = thiz.options.mappingTemplate;
  if (mappingTemplate === null || typeof mappingTemplate === 'undefined') {
    // es version 6 and below will use 'index-template-mapping-es-lte-6.json'
    // 7 and above will use 'index-template-mapping-es-gte-7.json'
    const esVersion = Number(thiz.options.elasticsearchVersion) >= 7 ? 'gte-7' : 'lte-6';
    const rawdata = fs.readFileSync(
      path.join(__dirname, 'index-template-mapping-es-' + esVersion + '.json')
    );
    mappingTemplate = JSON.parse(rawdata);
    mappingTemplate.index_patterns = indexPrefix + '-*';
  }

  const tmplCheckMessage = {
    name: 'template_' + indexPrefix
  };
  thiz.client.indices.existsTemplate(tmplCheckMessage).then(
    (res) => {
      if (res.statusCode && res.statusCode === 404) {
        const tmplMessage = {
          name: 'template_' + indexPrefix,
          create: true,
          body: mappingTemplate
        };
        thiz.client.indices.putTemplate(tmplMessage).then(
          (res1) => {
            fulfill(res1.body);
          },
          (err1) => {
            reject(err1);
          }
        );
      } else {
        fulfill(res.body);
      }
    },
    (err) => {
      reject(err);
    }
  );
};

module.exports = BulkWriter;
