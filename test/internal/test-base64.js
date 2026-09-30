/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var test = require('node:test').test;
var assert = require('node:assert');

var base64 = require('../../lib/base64');

test('test out of range encoding', () => {
  assert.throws(function () {
    base64.encode(-1);
  });
  assert.throws(function () {
    base64.encode(64);
  });
});

test('test out of range decoding', () => {
  assert.equal(base64.decode('='.charCodeAt(0)), -1);
});

test('test normal encoding and decoding', () => {
  for (var i = 0; i < 64; i++) {
    assert.equal(base64.decode(base64.encode(i).charCodeAt(0)), i);
  }
});
