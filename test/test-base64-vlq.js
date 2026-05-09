/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var test = require('node:test').test;
var assert = require('node:assert');

var base64VLQ = require('../lib/base64-vlq');

test('test normal encoding and decoding', () => {
  var result = {};
  for (var i = -255; i < 256; i++) {
    var str = base64VLQ.encode(i);
    base64VLQ.decode(str, 0, result);
    assert.equal(result.value, i);
    assert.equal(result.rest, str.length);
  }
});

// Specific encoded-form vectors lifted from
// jridgewell/sourcemaps' sourcemap-codec test suite.
test('test specific encoded forms', () => {
  var vectors = [
    [0, 'A'],
    [1, 'C'],
    [-1, 'D'],
    [2, 'E'],
    [-2, 'F'],
    [16, 'gB'],
    [-16, 'hB'],
    // The "Int16 isn't being used" boundary check from jridgewell's codec.
    [32000, 'gw+B'],
    [33000, 'wugC'],
    [34000, 'gtiC'],
    [35000, 'wrkC'],
  ];
  var result = {};
  vectors.forEach(([value, encoded]) => {
    assert.equal(base64VLQ.encode(value), encoded,
      'encode(' + value + ') should be ' + encoded);
    base64VLQ.decode(encoded, 0, result);
    assert.equal(result.value, value,
      'decode(' + encoded + ') should be ' + value);
    assert.equal(result.rest, encoded.length);
  });
});

// Source-map-js's VLQ uses signed 32-bit shifts in toVLQSigned, so the safe
// roundtrip range is [-(2**29), 2**29]. Sweep the boundary to catch regressions.
test('test wide-range encoding and decoding', () => {
  var result = {};
  var max = Math.pow(2, 29);
  var values = [
    -max, -max + 1, -1234567, -65536, -1024, -1,
    0,
    1, 1024, 65536, 1234567, max - 1, max,
  ];
  values.forEach((i) => {
    var str = base64VLQ.encode(i);
    base64VLQ.decode(str, 0, result);
    assert.equal(result.value, i, 'roundtrip failed for ' + i);
    assert.equal(result.rest, str.length);
  });
});
