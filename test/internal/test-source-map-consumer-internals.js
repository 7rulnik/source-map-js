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
var base64VLQ = require('../../lib/base64-vlq');
var SourceMapGenerator = require('../../lib/source-map-generator').SourceMapGenerator;

// Build a single-line mappings string from generated-column values.
// Each segment is just (genColumn delta), so the resulting line has
// `gens.length` segments whose generated columns are exactly `gens`.
function makeUnsortedSingleLineMappings(gens) {
  var out = '';
  var prev = 0;
  for (var i = 0; i < gens.length; i++) {
    if (i > 0) out += ',';
    out += base64VLQ.encode(gens[i] - prev);
    prev = gens[i];
  }
  return out;
}

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

// The internal sortGenerated has three branches based on per-line segment count
// (n==2, n<20 insertion, n>=20 quicksort) plus an early-exit for already-sorted
// input. Real-world maps are always sorted, so these tests feed deliberately
// out-of-order generated columns to exercise the sort branches and the
// "found out-of-order" path of the pre-scan.

function unsortedSegmentMap(generatedColumns) {
  return {
    version: 3,
    sources: [],
    names: [],
    mappings: makeUnsortedSingleLineMappings(generatedColumns)
  };
}

function sortedColumns(consumer) {
  var cols = [];
  consumer.eachMapping(function (m) { cols.push(m.generatedColumn); });
  return cols;
}

test('BasicSourceMapConsumer sorts a 2-segment line whose generated columns are out of order', () => {
  var map = unsortedSegmentMap([5, 2]);
  var consumer = new SourceMapConsumer(map);
  assert.deepStrictEqual(sortedColumns(consumer), [2, 5]);
});

test('BasicSourceMapConsumer sorts a small line (n<20) whose generated columns are out of order', () => {
  var unsorted = [10, 2, 7, 1, 9, 3, 8, 4, 6, 5];
  var map = unsortedSegmentMap(unsorted);
  var consumer = new SourceMapConsumer(map);
  assert.deepStrictEqual(sortedColumns(consumer), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('BasicSourceMapConsumer sorts a large line (n>=20) whose generated columns are out of order', () => {
  var unsorted = [];
  for (var i = 30; i >= 1; i--) unsorted.push(i);
  var map = unsortedSegmentMap(unsorted);
  var consumer = new SourceMapConsumer(map);
  var expected = [];
  for (var j = 1; j <= 30; j++) expected.push(j);
  assert.deepStrictEqual(sortedColumns(consumer), expected);
});

// _buildOriginalMappings groups parsed mappings by source and then sorts each
// group by original position. The skip-sorted check short-circuits when the
// per-source array is already in original order. Real-world maps usually are,
// so we craft one where two segments share a generated line and source but
// have decreasing original lines — guaranteeing the per-source array comes
// out of original-position order and forcing the actual quickSort call.
test('BasicSourceMapConsumer sorts originalMappings when generated and original orders disagree', () => {
  // Segment 1: genCol=0, srcIdx=0, origLineDelta=10 (→ origLine 11), origCol=0
  // Segment 2: genColDelta=5, srcIdxDelta=0, origLineDelta=-5 (→ origLine 6), origCol=0
  var seg1 = base64VLQ.encode(0) + base64VLQ.encode(0)
           + base64VLQ.encode(10) + base64VLQ.encode(0);
  var seg2 = base64VLQ.encode(5) + base64VLQ.encode(0)
           + base64VLQ.encode(-5) + base64VLQ.encode(0);
  var consumer = new SourceMapConsumer({
    version: 3,
    sources: ['x.js'],
    names: [],
    mappings: seg1 + ',' + seg2
  });

  var lines = [];
  consumer.eachMapping(function (m) { lines.push(m.originalLine); },
                       null, SourceMapConsumer.ORIGINAL_ORDER);
  assert.deepStrictEqual(lines, [6, 11]);
});

// IndexedSourceMapConsumer._parseMappings buckets original-side mappings by
// source and sorts each bucket with compareByOriginalPositionsNoSource. The
// skip-sorted check short-circuits for the common in-order case; this test
// crafts a section whose per-source bucket comes out of original-position
// order, forcing the actual quickSort fallback.
test('IndexedSourceMapConsumer sorts per-source originalMappings when bucket is out of order', () => {
  var seg1 = base64VLQ.encode(0) + base64VLQ.encode(0)
           + base64VLQ.encode(10) + base64VLQ.encode(0);
  var seg2 = base64VLQ.encode(5) + base64VLQ.encode(0)
           + base64VLQ.encode(-5) + base64VLQ.encode(0);
  var consumer = new SourceMapConsumer({
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ['x.js'],
          names: [],
          mappings: seg1 + ',' + seg2
        }
      }
    ]
  });

  var lines = [];
  consumer.eachMapping(function (m) { lines.push(m.originalLine); },
                       null, SourceMapConsumer.ORIGINAL_ORDER);
  assert.deepStrictEqual(lines, [6, 11]);
});

// BasicSourceMapConsumer.fromSourceMap reads the generator's MappingList
// slab directly. The srcIdx === -1 branch (source-less generated mapping)
// isn't covered by the standard fromSourceMap tests since they all add
// mappings with sources. Exercise it here to pin the slab read shape for
// the source-less case.
// applySourceMap walks the generator's MappingList slab. The
// `srcIdx === -1` branch on line 253 (source-less mapping going through
// applySourceMap) was uncovered — all existing applySourceMap tests use
// fully-sourced mappings. Pin the pass-through behavior here.
test('SourceMapGenerator.applySourceMap passes source-less mappings through unchanged', () => {
  // Inner map: x.js → y.js
  var inner = new SourceMapGenerator({ file: 'x.js' });
  inner.addMapping({
    source: 'y.js',
    original:  { line: 1, column: 0 },
    generated: { line: 1, column: 0 }
  });
  var innerConsumer = new SourceMapConsumer(inner.toJSON());

  // Outer generator has a source-less mapping alongside an x.js mapping.
  var outer = new SourceMapGenerator({ file: 'foo.js' });
  outer.addMapping({ generated: { line: 1, column: 0 } });  // source-less
  outer.addMapping({
    source:    'x.js',
    original:  { line: 1, column: 0 },
    generated: { line: 1, column: 5 }
  });

  outer.applySourceMap(innerConsumer);

  var result = new SourceMapConsumer(outer.toJSON());
  var seen = [];
  result.eachMapping(function (m) {
    seen.push({ gc: m.generatedColumn, src: m.source });
  });
  assert.deepStrictEqual(seen, [
    { gc: 0, src: null },   // source-less mapping survives unchanged
    { gc: 5, src: 'y.js' }  // x.js mapping got transformed via inner
  ]);
});

test('BasicSourceMapConsumer.fromSourceMap handles source-less mappings', () => {
  var smg = new SourceMapGenerator({ file: 'foo.js' });
  // Case-1 mapping per _validateMapping: only generated position.
  smg.addMapping({ generated: { line: 1, column: 0 } });
  smg.addMapping({
    source:    'x.js',
    original:  { line: 1, column: 0 },
    generated: { line: 1, column: 5 }
  });

  var smc = SourceMapConsumer.fromSourceMap(smg);
  // Source-less mapping survives the round-trip with source/name null.
  var lines = [];
  smc.eachMapping(function (m) {
    lines.push({ gc: m.generatedColumn, src: m.source, name: m.name });
  });
  assert.deepStrictEqual(lines, [
    { gc: 0, src: null, name: null },
    { gc: 5, src: 'x.js', name: null }
  ]);
});

// BasicSourceMapConsumer.fromSourceMap buckets original-side mappings by
// source and sorts each bucket with compareByOriginalPositionsNoSource.
// MappingList stores mappings in generated-position order, so we need two
// mappings on the same source whose original positions decrease as their
// generated columns increase — that produces an out-of-order bucket and
// forces the quickSort fallback.
test('BasicSourceMapConsumer.fromSourceMap sorts per-source originalMappings when bucket is out of order', () => {
  var smg = new SourceMapGenerator({ file: 'foo.js' });
  smg.addMapping({
    source:    'x.js',
    original:  { line: 11, column: 0 },
    generated: { line:  1, column: 0 }
  });
  smg.addMapping({
    source:    'x.js',
    original:  { line:  6, column: 0 },
    generated: { line:  1, column: 5 }
  });

  var consumer = SourceMapConsumer.fromSourceMap(smg);
  var lines = [];
  consumer.eachMapping(function (m) { lines.push(m.originalLine); },
                       null, SourceMapConsumer.ORIGINAL_ORDER);
  assert.deepStrictEqual(lines, [6, 11]);
});

// _charIsMappingSeparator is no longer used by the inline-charCodeAt parser
// in _parseMappings, but it remains on the prototype as a documented helper
// for subclasses / monkey-patching. Cover it directly so the prototype method
// keeps reporting as covered.
test('_charIsMappingSeparator returns true for ; and , and false otherwise', () => {
  var consumer = new SourceMapConsumer(util.testMap);
  assert.strictEqual(consumer._charIsMappingSeparator('a;b', 1), true);
  assert.strictEqual(consumer._charIsMappingSeparator('a,b', 1), true);
  assert.strictEqual(consumer._charIsMappingSeparator('abc', 1), false);
  assert.strictEqual(consumer._charIsMappingSeparator('', 0), false);
});
