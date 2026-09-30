/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Tests documenting gaps between source-map-js and the ECMA-426 draft
 * (https://tc39.es/ecma426/). Each test is marked `todo` so that the suite
 * stays green: failures are reported but do not fail the run. When the
 * underlying behaviour is fixed, drop the `todo` flag.
 *
 * See ecma426-audit.md for the full audit.
 */

var test = require('node:test').test;
var assert = require('node:assert');

var base64VLQ = require('../../lib/base64-vlq');
var SourceMapConsumer = require('../../lib/source-map-consumer').SourceMapConsumer;
var SourceMapGenerator = require('../../lib/source-map-generator').SourceMapGenerator;

// ---------------------------------------------------------------------------
// 1. ignoreList round-trip (spec [json-ignoreList])
// ---------------------------------------------------------------------------

test('consumer should expose ignoreList from the source map', { todo: true }, () => {
  var map = new SourceMapConsumer({
    version: 3,
    sources: ['app.js', 'vendor.js'],
    names: [],
    mappings: '',
    ignoreList: [1],
  });
  assert.deepEqual(map.ignoreList, [1]);
});

test('consumer should fall back to x_google_ignoreList when ignoreList is absent', { todo: true }, () => {
  var map = new SourceMapConsumer({
    version: 3,
    sources: ['app.js', 'vendor.js'],
    names: [],
    mappings: '',
    x_google_ignoreList: [1],
  });
  assert.deepEqual(map.ignoreList, [1]);
});

test('generator should preserve ignoreList through fromSourceMap round-trip', { todo: true }, () => {
  var consumer = new SourceMapConsumer({
    version: 3,
    sources: ['app.js', 'vendor.js'],
    names: [],
    mappings: '',
    ignoreList: [1],
  });
  var json = SourceMapGenerator.fromSourceMap(consumer).toJSON();
  assert.deepEqual(json.ignoreList, [json.sources.indexOf('vendor.js')]);
});

// ---------------------------------------------------------------------------
// 2. null entries in `sources` (spec [json-sources])
//    "Each entry is either a string ... or null if the source name is not
//    known." Today `sources.map(String)` turns null into the string "null".
// ---------------------------------------------------------------------------

test('null entries in `sources` should not be coerced to the string "null"', { todo: true }, () => {
  var map = new SourceMapConsumer({
    version: 3,
    sources: ['a.js', null, 'b.js'],
    names: [],
    mappings: '',
  });
  // Spec-conformant behaviour: preserve null. (Today: 'null' string appears.)
  assert.notEqual(map.sources[1], 'null');
});

// Already conformant — left in to guard against regressions.
test('null entries in `sourcesContent` round-trip as null', () => {
  var input = {
    version: 3,
    sources: ['a.js', 'b.js'],
    sourcesContent: ['var a = 1;', null],
    names: [],
    mappings: '',
  };
  var map = new SourceMapConsumer(input);
  assert.equal(map.sourcesContent[1], null);
  assert.notEqual(map.sourcesContent[1], 'null');
});

// Lock in the *current* (broken) behaviour so a fix surfaces as a failing
// assertion in this test, prompting an update to the conformance test above.
test('current behaviour: null in sources is stringified (regression lock-in)', () => {
  var map = new SourceMapConsumer({
    version: 3,
    sources: ['a.js', null, 'b.js'],
    names: [],
    mappings: '',
  });
  assert.equal(map.sources[1], 'null',
    'When this assertion starts failing, the null-source bug has been fixed — ' +
    'remove this regression lock-in and un-todo the spec test above.');
});

// ---------------------------------------------------------------------------
// 3. VLQ overflow at 2^31 (spec §base64-vlq)
//    "If value is >= 2^31, throw an error." Implementations also lose data
//    near the boundary because of JS 32-bit signed shifts.
// ---------------------------------------------------------------------------

test('VLQ encode should throw on values with |value| >= 2^31', { todo: true }, () => {
  assert.throws(() => base64VLQ.encode(Math.pow(2, 31)));
  assert.throws(() => base64VLQ.encode(-Math.pow(2, 31) - 1));
});

test('VLQ decode should throw on values with |value| >= 2^31', { todo: true }, () => {
  // Encoded form of 2^31 produced by a spec-conformant encoder.
  // We just verify that whatever string would represent a >=2^31 value is rejected.
  // Simplest approach: feed an obviously-too-long continuation chain.
  var tooBig = 'gggggggggB'; // 9 continuation digits + terminator
  var out = {};
  assert.throws(() => base64VLQ.decode(tooBig, 0, out));
});

test('VLQ encode/decode round-trips values up to 2^31 - 1', { todo: true }, () => {
  // Today this fails near 2^30 because toVLQSigned uses signed `<<`.
  var values = [
    Math.pow(2, 30),
    Math.pow(2, 30) + 1,
    Math.pow(2, 31) - 1,
    -(Math.pow(2, 31) - 1),
  ];
  var out = {};
  values.forEach((v) => {
    var encoded = base64VLQ.encode(v);
    base64VLQ.decode(encoded, 0, out);
    assert.equal(out.value, v, 'roundtrip failed for ' + v);
  });
});

// Lock in the current overflow so a future fix is visible.
test('current behaviour: VLQ encode overflows at 2^30 (regression lock-in)', () => {
  // toVLQSigned does `(v << 1)`; at v = 2^30 this wraps to a negative int32.
  var encoded = base64VLQ.encode(Math.pow(2, 30));
  var out = {};
  base64VLQ.decode(encoded, 0, out);
  assert.notEqual(out.value, Math.pow(2, 30),
    'When this assertion starts failing, the VLQ overflow has been fixed — ' +
    'remove this regression lock-in.');
});

// ---------------------------------------------------------------------------
// 4. Indexed source map: unrecognized properties (spec [index-source-map])
//    "Source map consumers shall ignore any additional unrecognized
//    properties, rather than causing the source map to be rejected."
//    The library throws on `url` even when a valid `map` is also present.
// ---------------------------------------------------------------------------

test('section with both `map` and an unrecognized `url` should not throw', { todo: true }, () => {
  var indexed = {
    version: 3,
    sections: [{
      offset: { line: 0, column: 0 },
      url: 'https://example.com/ignored.map',
      map: {
        version: 3,
        sources: ['a.js'],
        names: [],
        mappings: '',
      },
    }],
  };
  assert.doesNotThrow(() => new SourceMapConsumer(indexed));
});

// Already conformant for arbitrary unknown keys (only `url` is rejected) —
// kept as a regression guard.
test('section with extra unknown properties is accepted', () => {
  var indexed = {
    version: 3,
    sections: [{
      offset: { line: 0, column: 0 },
      somethingNew: 'spec says ignore me',
      map: {
        version: 3,
        sources: ['a.js'],
        names: [],
        mappings: '',
      },
    }],
  };
  assert.doesNotThrow(() => new SourceMapConsumer(indexed));
});

// ---------------------------------------------------------------------------
// 5. Type-definition gaps (source-map.d.ts)
//    Not testable from runtime JS — covered by the audit doc. If we add a
//    .d.ts compile check later, fold those assertions in here.
// ---------------------------------------------------------------------------
