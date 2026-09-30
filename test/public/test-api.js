/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2012 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var test = require('node:test').test;
var assert = require('node:assert');

var sourceMap = require('../../source-map');

test('test that the api is properly exposed in the top level', () => {
  assert.equal(typeof sourceMap.SourceMapGenerator, "function");
  assert.equal(typeof sourceMap.SourceMapConsumer, "function");
  assert.equal(typeof sourceMap.SourceNode, "function");
});
