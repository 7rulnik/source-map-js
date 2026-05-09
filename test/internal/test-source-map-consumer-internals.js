/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

// Tests that touch the unexported BasicSourceMapConsumer / IndexedSourceMapConsumer
// constructors directly — i.e. behaviour that's not part of the public surface
// re-exported through ../../source-map.js. Keep public-API tests in
// test/public/test-source-map-consumer.js.

var test = require('node:test').test;
var assert = require('node:assert');

var util = require("../util");
var consumerModule = require('../../lib/source-map-consumer');
var SourceMapConsumer = consumerModule.SourceMapConsumer;
var BasicSourceMapConsumer = consumerModule.BasicSourceMapConsumer;
var IndexedSourceMapConsumer = consumerModule.IndexedSourceMapConsumer;

test('test that a BasicSourceMapConsumer is returned for sourcemaps without sections', () => {
  assert.ok(new SourceMapConsumer(util.testMap) instanceof BasicSourceMapConsumer);
});

test('test that an IndexedSourceMapConsumer is returned for sourcemaps with sections', () => {
  assert.ok(new SourceMapConsumer(util.indexedTestMap) instanceof IndexedSourceMapConsumer);
});

test('BasicSourceMapConsumer accepts a JSON string directly', () => {
  var map = new BasicSourceMapConsumer(JSON.stringify(util.testMap));
  assert.equal(map.sources.length, 2);
});

test('BasicSourceMapConsumer throws on unsupported version', () => {
  assert.throws(() => new BasicSourceMapConsumer({
    version: 2,
    sources: ['a.js'],
    names: [],
    mappings: ''
  }), /Unsupported version: 2/);
});

test('IndexedSourceMapConsumer accepts a JSON string directly', () => {
  var map = new IndexedSourceMapConsumer(JSON.stringify(util.indexedTestMap));
  assert.equal(map.sources.length, 2);
});

test('IndexedSourceMapConsumer throws on unsupported version', () => {
  assert.throws(() => new IndexedSourceMapConsumer({
    version: 2,
    sections: []
  }), /Unsupported version: 2/);
});
