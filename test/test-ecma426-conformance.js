/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Conformance with ECMA-426, the source map format standard:
 * https://tc39.es/ecma426/
 *
 * Where these tests come from:
 *
 * - 2026-05-09: written from an audit of this library against the ECMA-426
 *   draft. It found four gaps: `ignoreList`, `null` in `sources`, the VLQ
 *   value range and `url` in index map sections.
 * - 2026-11-19: extended after going through every decoding algorithm in the
 *   spec as of https://github.com/tc39/ecma426/commit/0230441 (2026-11-11):
 *   ParseSourceMap, DecodeSourceMap and the helpers it calls, DecodeMappings,
 *   VLQSignedValue, DecodeSourceMapSources and DecodeIndexSourceMap. Every
 *   step that tells a consumer what to do with its input has a test here,
 *   except the ones listed under "Not covered".
 *
 * Each test links the part of the spec it checks. There are three kinds:
 *
 * - `todo`: a gap. It fails today without failing the run. Drop `todo` once
 *   the library is fixed.
 * - guard: already conformant, kept to catch regressions.
 * - lock-in: pins current non-conformant behaviour, so that fixing a gap
 *   fails a test as a reminder to drop the matching `todo`.
 *
 * Where the spec says "optionally report an error", throwing is one of the
 * allowed behaviours (https://tc39.es/ecma426/#sec-optional-errors). Tests
 * for those steps accept either a throw or the spec's fallback result.
 *
 * The spec counts lines and columns from 0. This library's API counts lines
 * from 1 and columns from 0.
 *
 * Not covered:
 *
 * - Retrieving source maps (sourceMappingURL comments, HTTP headers,
 *   fetching): this library doesn't do that.
 * - An empty `sourceRoot`. The spec turns "" into a "/" prefix, which makes
 *   every source root-relative. https://github.com/tc39/ecma426/pull/183,
 *   which added that step, says it matches mozilla/source-map, trace-mapping
 *   and Chrome, but mozilla/source-map and trace-mapping (whose comment cites
 *   Chromium) treat "" as no `sourceRoot`, and so does this library.
 * - Index maps nested in a section. The spec decodes a section's `map` as a
 *   regular source map, so a nested index map fails to decode and its section
 *   is skipped or the whole map rejected. This library supports nesting on
 *   purpose; see the nested index map tests in test-source-map-consumer.js.
 */

var test = require('node:test');
var assert = require('node:assert/strict');

var base64VLQ = require('../lib/base64-vlq');
var SourceMapConsumer = require('../lib/source-map-consumer').SourceMapConsumer;
var SourceMapGenerator =
  require('../lib/source-map-generator').SourceMapGenerator;

function basicMap(fields) {
  return Object.assign(
    { version: 3, sources: ['a.js'], names: ['n'], mappings: 'AAAA' },
    fields
  );
}

function indexMap(sections) {
  return { version: 3, sections: sections };
}

// Decodes every mapping as
// [generatedLine, generatedColumn, source, originalLine, originalColumn, name].
function decode(map, sourceMapURL) {
  var consumer = new SourceMapConsumer(map, sourceMapURL);
  var mappings = [];
  consumer.eachMapping(function (m) {
    mappings.push([
      m.generatedLine,
      m.generatedColumn,
      m.source,
      m.originalLine,
      m.originalColumn,
      m.name,
    ]);
  });
  return mappings;
}

// For steps that "optionally report an error": the library may throw;
// otherwise `check` gets the result of `fn`.
function assertThrowsOr(fn, check) {
  var result;
  try {
    result = fn();
  } catch (error) {
    return;
  }
  check(result);
}

// ---------------------------------------------------------------------------
// 1. ignoreList
//    https://tc39.es/ecma426/#json-ignoreList
//    https://tc39.es/ecma426/#sec-DecodeSourceMapSources ([[Ignored]])
//    "Some browsers may also use the deprecated `x_google_ignoreList` field
//    if `ignoreList` is not present."
// ---------------------------------------------------------------------------

test(
  'consumer should expose ignoreList from the source map',
  { todo: true },
  () => {
    var map = new SourceMapConsumer({
      version: 3,
      sources: ['app.js', 'vendor.js'],
      names: [],
      mappings: '',
      ignoreList: [1],
    });
    assert.deepEqual(map.ignoreList, [1]);
  }
);

test(
  'consumer should fall back to x_google_ignoreList when ignoreList is absent',
  { todo: true },
  () => {
    var map = new SourceMapConsumer({
      version: 3,
      sources: ['app.js', 'vendor.js'],
      names: [],
      mappings: '',
      x_google_ignoreList: [1],
    });
    assert.deepEqual(map.ignoreList, [1]);
  }
);

test(
  'generator should preserve ignoreList through fromSourceMap round-trip',
  { todo: true },
  () => {
    var consumer = new SourceMapConsumer({
      version: 3,
      sources: ['app.js', 'vendor.js'],
      names: [],
      mappings: '',
      ignoreList: [1],
    });
    var json = SourceMapGenerator.fromSourceMap(consumer).toJSON();
    assert.deepEqual(json.ignoreList, [json.sources.indexOf('vendor.js')]);
  }
);

// ---------------------------------------------------------------------------
// 2. Values of `file`, `sources`, `sourcesContent` and `names`
//    https://tc39.es/ecma426/#json-sources
//    "Each entry is either a string that is a (potentially relative) URL or
//    null if the source name is not known."
//    https://tc39.es/ecma426/#sec-GetOptionalString
//    https://tc39.es/ecma426/#sec-GetOptionalListOfStrings
//    https://tc39.es/ecma426/#sec-GetOptionalListOfOptionalStrings
//    A value of the wrong type is an optional error. The fallback is null for
//    `file`, a `sources` entry and a `sourcesContent` entry, and "" for a
//    `names` entry. Today the library coerces values with String() or keeps
//    them as they are. The "consuming names and sources that are numbers"
//    test in test-source-map-consumer.js pins that coercion for numbers.
// ---------------------------------------------------------------------------

test(
  'null entries in `sources` should not be coerced to the string "null"',
  { todo: true },
  () => {
    var map = new SourceMapConsumer({
      version: 3,
      sources: ['a.js', null, 'b.js'],
      names: [],
      mappings: '',
    });
    // Spec-conformant behaviour: preserve null. (Today: 'null' string appears.)
    assert.notEqual(map.sources[1], 'null');
  }
);

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
  assert.equal(
    map.sources[1],
    'null',
    'When this assertion starts failing, the null-source bug has been fixed — ' +
      'remove this regression lock-in and un-todo the spec test above.'
  );
});

test(
  'a `sources` entry that is not a string or null becomes null',
  { todo: true },
  () => {
    assertThrowsOr(
      () => new SourceMapConsumer(basicMap({ sources: [1] })).sources,
      (sources) => assert.deepEqual(sources, [null])
    );
  }
);

test(
  'a `names` entry that is not a string becomes the empty string',
  { todo: true },
  () => {
    assertThrowsOr(
      () => decode(basicMap({ names: [1], mappings: 'AAAAA' })),
      (mappings) => assert.equal(mappings[0][5], '')
    );
  }
);

test(
  'a `sourcesContent` entry that is not a string or null becomes null',
  { todo: true },
  () => {
    assertThrowsOr(
      () =>
        new SourceMapConsumer(
          basicMap({ sourcesContent: [1] })
        ).sourceContentFor('a.js', true),
      (content) => assert.equal(content, null)
    );
  }
);

test('a `file` that is not a string becomes null', { todo: true }, () => {
  assertThrowsOr(
    () => new SourceMapConsumer(basicMap({ file: 42 })).file,
    (file) => assert.equal(file, null)
  );
});

// ---------------------------------------------------------------------------
// 3. Base64 VLQ
//    https://tc39.es/ecma426/#sec-VLQSignedValue
//    "If value is 0 and sign is -1, return -2^31."
//    "If value is ≥ 2^31, throw an error."
//    So a VLQ holds values from -2^31 to 2^31 - 1. The library loses data
//    from 2^30 on because toVLQSigned and decode use 32-bit signed shifts.
// ---------------------------------------------------------------------------

// The spec only defines decoding. An encoder that accepts values outside the
// range above writes maps that a conformant consumer has to reject.
test(
  'VLQ encode should throw on values outside [-2^31, 2^31 - 1]',
  { todo: true },
  () => {
    assert.throws(() => base64VLQ.encode(Math.pow(2, 31)));
    assert.throws(() => base64VLQ.encode(-Math.pow(2, 31) - 1));
  }
);

test(
  'VLQ decode should throw on values with |value| >= 2^31',
  { todo: true },
  () => {
    // 9 continuation digits and a terminator encode 2^44, far above 2^31.
    var tooBig = 'gggggggggB';
    var out = {};
    assert.throws(() => base64VLQ.decode(tooBig, 0, out));
  }
);

test('VLQ "negative zero" (B) decodes to -2^31', { todo: true }, () => {
  var out = {};
  base64VLQ.decode('B', 0, out);
  assert.equal(out.value, -Math.pow(2, 31));
});

test(
  'VLQ encode/decode round-trips values up to 2^31 - 1',
  { todo: true },
  () => {
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
  }
);

// Lock in the current overflow so a future fix is visible.
test('current behaviour: VLQ encode overflows at 2^30 (regression lock-in)', () => {
  // toVLQSigned does `(v << 1)`; at v = 2^30 this wraps to a negative int32.
  var encoded = base64VLQ.encode(Math.pow(2, 30));
  var out = {};
  base64VLQ.decode(encoded, 0, out);
  assert.notEqual(
    out.value,
    Math.pow(2, 30),
    'When this assertion starts failing, the VLQ overflow has been fixed — ' +
      'remove this regression lock-in.'
  );
});

// ---------------------------------------------------------------------------
// 4. Required fields
//    https://tc39.es/ecma426/#sec-DecodeSourceMap
//    "If mappingsField is not a String, throw an error."
//    "If JSONObjectGet(json, "sources") is not a JSON array, throw an error."
//    A `version` other than 3 is an optional error.
// ---------------------------------------------------------------------------

test('a missing `mappings` is rejected', () => {
  var map = basicMap({});
  delete map.mappings;
  assert.throws(() => decode(map));
});

test('a `mappings` that is not a string is rejected', { todo: true }, () => {
  assert.throws(() => decode(basicMap({ mappings: 42 })));
});

test('a missing `sources` is rejected', () => {
  var map = basicMap({});
  delete map.sources;
  assert.throws(() => decode(map));
});

test('a `sources` that is not an array is rejected', () => {
  assert.throws(() => decode(basicMap({ sources: 'a.js' })));
});

test('a `version` other than 3 is rejected or ignored', () => {
  assertThrowsOr(
    () => decode(basicMap({ version: 2 })),
    (mappings) => assert.deepEqual(mappings, [[1, 0, 'a.js', 1, 0, null]])
  );
});

// ---------------------------------------------------------------------------
// 5. The `mappings` grammar
//    https://tc39.es/ecma426/#sec-mappings-grammar
//    https://tc39.es/ecma426/#sec-DecodeMappings
//    A segment has 1, 4 or 5 fields, and segments are separated by single
//    commas. If `mappings` doesn't match the grammar, that's an optional
//    error and the result is no mappings at all: a consumer may throw or
//    return no mappings, but not the segments it managed to read.
// ---------------------------------------------------------------------------

function assertRejected(map) {
  assertThrowsOr(
    () => decode(map),
    (mappings) => assert.deepEqual(mappings, [])
  );
}

test('segments with 2 or 3 fields are rejected', () => {
  assertRejected(basicMap({ mappings: 'AA' }));
  assertRejected(basicMap({ mappings: 'AAA' }));
});

test('a character outside base64 is rejected', () => {
  assertRejected(basicMap({ mappings: 'AA!A' }));
});

test('a segment with more than 5 fields is rejected', { todo: true }, () => {
  assertRejected(basicMap({ mappings: 'AAAAAA' }));
});

test('an empty segment is rejected', { todo: true }, () => {
  assertRejected(basicMap({ mappings: 'A,,C' }));
  assertRejected(basicMap({ mappings: 'A,' }));
});

// ---------------------------------------------------------------------------
// 6. Values out of range in a segment
//    https://tc39.es/ecma426/#sec-DecodeMappingsField
//    Each is an optional error. The fallback for a negative generated column
//    is to drop the mapping. For a source index outside `sources`, or a
//    negative original line or column, it's to keep the mapping without an
//    original position. For a name index outside `names`, it's to keep the
//    mapping without a name.
// ---------------------------------------------------------------------------

test(
  'a mapping with a negative generated column is dropped',
  { todo: true },
  () => {
    // D is -1.
    assertThrowsOr(
      () => decode(basicMap({ mappings: 'D' })),
      (mappings) => assert.deepEqual(mappings, [])
    );
  }
);

test(
  'a mapping with a negative original line has no original position',
  { todo: true },
  () => {
    // Original line -1.
    assertThrowsOr(
      () => decode(basicMap({ mappings: 'AADA' })),
      (mappings) => assert.deepEqual(mappings, [[1, 0, null, null, null, null]])
    );
  }
);

test('a source index outside `sources` drops the original position', () => {
  assertThrowsOr(
    () => decode(basicMap({ mappings: 'ACAA' })),
    (mappings) => assert.deepEqual(mappings, [[1, 0, null, null, null, null]])
  );
});

test('a name index outside `names` drops the name', () => {
  assertThrowsOr(
    () => decode(basicMap({ mappings: 'AAAAC' })),
    (mappings) => assert.deepEqual(mappings, [[1, 0, 'a.js', 1, 0, null]])
  );
});

// ---------------------------------------------------------------------------
// 7. Resolving sources
//    https://tc39.es/ecma426/#sec-DecodeSourceMapSources
//    `sourceRoot` gets a trailing "/" if it has none and is prepended to each
//    source, and the result is URL-parsed against the source map's URL.
// ---------------------------------------------------------------------------

var MAP_URL = 'https://example.com/js/app.js.map';

test('sources are joined to `sourceRoot` and resolved against the map URL', () => {
  function resolve(sourceRoot, source) {
    return new SourceMapConsumer(
      basicMap({ sourceRoot: sourceRoot, sources: [source] }),
      MAP_URL
    ).sources[0];
  }
  assert.equal(resolve('x', 'a.js'), 'https://example.com/js/x/a.js');
  assert.equal(resolve('x/', 'a.js'), 'https://example.com/js/x/a.js');
  assert.equal(resolve('/root', '../a.js'), 'https://example.com/a.js');
});

test('URL parsing keeps "//" inside a source path', { todo: true }, () => {
  function resolve(source) {
    return new SourceMapConsumer(basicMap({ sources: [source] }), MAP_URL)
      .sources[0];
  }
  // Today both lose a slash: .../js/a/b.js and http://y.com/a/b.js.
  assert.equal(resolve('a//b.js'), 'https://example.com/js/a//b.js');
  assert.equal(resolve('http://y.com/a//b.js'), 'http://y.com/a//b.js');
});

// ---------------------------------------------------------------------------
// 8. Unrecognized properties
//    https://tc39.es/ecma426/#sec-extensions
//    "Source map consumers shall ignore any additional unrecognized
//    properties, rather than causing the source map to be rejected."
//    The library throws on `url` in a section even when a valid `map` is
//    also present.
// ---------------------------------------------------------------------------

test('unknown top-level properties are ignored', () => {
  assert.deepEqual(
    decode(basicMap({ x_custom: 1, debugId: 'id', scopes: 'A' })),
    [[1, 0, 'a.js', 1, 0, null]]
  );
});

test(
  'section with both `map` and an unrecognized `url` should not throw',
  { todo: true },
  () => {
    var indexed = {
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          url: 'https://example.com/ignored.map',
          map: {
            version: 3,
            sources: ['a.js'],
            names: [],
            mappings: '',
          },
        },
      ],
    };
    assert.doesNotThrow(() => new SourceMapConsumer(indexed));
  }
);

// Already conformant for arbitrary unknown keys (only `url` is rejected) —
// kept as a regression guard.
test('section with extra unknown properties is accepted', () => {
  var indexed = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        somethingNew: 'spec says ignore me',
        map: {
          version: 3,
          sources: ['a.js'],
          names: [],
          mappings: '',
        },
      },
    ],
  };
  assert.doesNotThrow(() => new SourceMapConsumer(indexed));
});

// ---------------------------------------------------------------------------
// 9. Index source maps
//    https://tc39.es/ecma426/#sec-DecodeIndexSourceMap
//    `sections` must be an array, and each section needs an `offset` object
//    and a `map` object; anything else throws. A section that isn't an
//    object, an offset that isn't an integer and a section map that fails to
//    decode are optional errors, with fallbacks: skip the section, use 0,
//    skip the section. The column offset only applies to mappings on the
//    section's first line.
// ---------------------------------------------------------------------------

test(
  'the section column offset only applies to the first line of the section',
  { todo: true },
  () => {
    var map = indexMap([
      {
        offset: { line: 1, column: 4 },
        map: basicMap({ mappings: 'AAAA;AACA' }),
      },
    ]);
    // Today the offset lands on the section's second line instead:
    // [2, 0, ...] and [3, 4, ...].
    assert.deepEqual(decode(map), [
      [2, 4, 'a.js', 1, 0, null],
      [3, 0, 'a.js', 2, 0, null],
    ]);
  }
);

test('`sections` that is not an array is rejected', () => {
  assert.throws(() => decode({ version: 3, sections: {} }));
});

test('a section without an `offset` is rejected', () => {
  assert.throws(() => decode(indexMap([{ map: basicMap({}) }])));
});

test('a section without a `map` is rejected', () => {
  assert.throws(() =>
    decode(indexMap([{ offset: { line: 0, column: 0 }, url: 'a.js.map' }]))
  );
});

test('a section that is not an object is rejected or skipped', () => {
  assertThrowsOr(
    () =>
      decode(
        indexMap([null, { offset: { line: 1, column: 0 }, map: basicMap({}) }])
      ),
    (mappings) => assert.deepEqual(mappings, [[2, 0, 'a.js', 1, 0, null]])
  );
});

test('a section offset that is not an integer is rejected or read as 0', () => {
  assertThrowsOr(
    () =>
      decode(
        indexMap([{ offset: { line: 'x', column: 0.5 }, map: basicMap({}) }])
      ),
    (mappings) => assert.deepEqual(mappings, [[1, 0, 'a.js', 1, 0, null]])
  );
});

test('a section whose map fails to decode is rejected or skipped', () => {
  var broken = basicMap({});
  delete broken.sources;
  assertThrowsOr(
    () =>
      decode(
        indexMap([
          { offset: { line: 0, column: 0 }, map: broken },
          { offset: { line: 1, column: 0 }, map: basicMap({}) },
        ])
      ),
    (mappings) => assert.deepEqual(mappings, [[2, 0, 'a.js', 1, 0, null]])
  );
});
