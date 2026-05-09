/* -*- Mode: js; js-indent-level: 2; -*- */

// Real-world map roundtrip — inspired by jridgewell/sourcemaps'
// sourcemap-codec "real world" tests. Parse each benchmark fixture with
// SourceMapConsumer, regenerate via SourceMapGenerator.fromSourceMap, and
// verify that every (generated, original, name) segment matches.
//
// Segment-level equality is the right invariant: byte-for-byte equality of
// the `mappings` string isn't guaranteed (names can be re-indexed in equally
// valid ways), but no information may be lost.

var test = require('node:test').test;
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var sourceMap = require('../../source-map.js');
var SourceMapConsumer = sourceMap.SourceMapConsumer;
var SourceMapGenerator = sourceMap.SourceMapGenerator;

var FIXTURES_DIR = path.join(__dirname, '..', '..', 'benchmark', 'fixtures');

function collectSegments(consumer) {
  var out = [];
  consumer.eachMapping(function (m) {
    out.push([
      m.generatedLine,
      m.generatedColumn,
      m.source || null,
      m.originalLine == null ? null : m.originalLine,
      m.originalColumn == null ? null : m.originalColumn,
      m.name || null,
    ]);
  });
  return out;
}

var fixtures = fs.readdirSync(FIXTURES_DIR)
  .filter(function (f) { return f.endsWith('.map'); });

fixtures.forEach(function (file) {
  test('roundtrip ' + file, { timeout: 60000 }, () => {
    var raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));

    var consumerA = new SourceMapConsumer(raw);
    var segmentsA = collectSegments(consumerA);

    var generated = SourceMapGenerator.fromSourceMap(consumerA).toJSON();

    var consumerB = new SourceMapConsumer(generated);
    var segmentsB = collectSegments(consumerB);

    assert.equal(segmentsB.length, segmentsA.length,
      'segment count differs after roundtrip');
    assert.deepStrictEqual(segmentsB, segmentsA,
      'segments differ after roundtrip');
  });
});
