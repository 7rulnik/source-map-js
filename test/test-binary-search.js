/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var test = require('node:test').test;
var assert = require('node:assert');

var binarySearch = require('../lib/binary-search');

function numberCompare(a, b) {
  return a - b;
}

test('test too high with default (glb) bias', () => {
  var needle = 30;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.doesNotThrow(function () {
    binarySearch.search(needle, haystack, numberCompare);
  });

  assert.equal(haystack[binarySearch.search(needle, haystack, numberCompare)], 20);
});

test('test too low with default (glb) bias', () => {
  var needle = 1;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.doesNotThrow(function () {
    binarySearch.search(needle, haystack, numberCompare);
  });

  assert.equal(binarySearch.search(needle, haystack, numberCompare), -1);
});

test('test too high with lub bias', () => {
  var needle = 30;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.doesNotThrow(function () {
    binarySearch.search(needle, haystack, numberCompare);
  });

  assert.equal(binarySearch.search(needle, haystack, numberCompare,
                                   binarySearch.LEAST_UPPER_BOUND), -1);
});

test('test too low with lub bias', () => {
  var needle = 1;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.doesNotThrow(function () {
    binarySearch.search(needle, haystack, numberCompare);
  });

  assert.equal(haystack[binarySearch.search(needle, haystack, numberCompare,
                                            binarySearch.LEAST_UPPER_BOUND)], 2);
});

test('test exact search', () => {
  var needle = 4;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.equal(haystack[binarySearch.search(needle, haystack, numberCompare)], 4);
});

test('test fuzzy search with default (glb) bias', () => {
  var needle = 19;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.equal(haystack[binarySearch.search(needle, haystack, numberCompare)], 18);
});

test('test fuzzy search with lub bias', () => {
  var needle = 19;
  var haystack = [2,4,6,8,10,12,14,16,18,20];

  assert.equal(haystack[binarySearch.search(needle, haystack, numberCompare,
                                            binarySearch.LEAST_UPPER_BOUND)], 20);
});

test('test multiple matches', () => {
  var needle = 5;
  var haystack = [1, 1, 2, 5, 5, 5, 13, 21];

  assert.equal(binarySearch.search(needle, haystack, numberCompare,
                                   binarySearch.LEAST_UPPER_BOUND), 3);
});

test('test multiple matches at the beginning', () => {
  var needle = 1;
  var haystack = [1, 1, 2, 5, 5, 5, 13, 21];

  assert.equal(binarySearch.search(needle, haystack, numberCompare,
                                   binarySearch.LEAST_UPPER_BOUND), 0);
});

test('test empty haystack returns -1', () => {
  assert.equal(binarySearch.search(1, [], numberCompare), -1);
  assert.equal(binarySearch.search(1, [], numberCompare,
                                   binarySearch.LEAST_UPPER_BOUND), -1);
});
