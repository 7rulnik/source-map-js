/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2014 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

// MappingList unit tests. The class is unexported through source-map.js, so
// these tests are kept under test/internal. They exist primarily to cover
// the materialization paths (`unsortedForEach`, `toArray`) — internal hot
// paths (`_serializeMappings`, `BasicSourceMapConsumer.fromSourceMap`) read
// the i32 slab directly and don't exercise these methods.

var test = require('node:test').test;
var assert = require('node:assert');

var ArraySet = require('../../lib/array-set').ArraySet;
var MappingList = require('../../lib/mapping-list').MappingList;

function makeList() {
  var sources = new ArraySet();
  var names = new ArraySet();
  sources.add('a.js');
  sources.add('b.js');
  names.add('foo');
  return { list: new MappingList(sources, names), sources: sources, names: names };
}

test('MappingList.unsortedForEach yields materialized mappings with resolved source/name strings', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 2, /*srcIdx=*/0, /*nameIdx=*/0);
  ctx.list.add(1, 10, -1, -1, /*srcIdx=*/1, /*nameIdx=*/-1);

  var seen = [];
  ctx.list.unsortedForEach(function (m) {
    seen.push(m);
  });

  assert.deepStrictEqual(seen[0], {
    generatedLine: 1,
    generatedColumn: 0,
    source: 'a.js',
    originalLine: 5,
    originalColumn: 2,
    name: 'foo'
  });
  // -1 sentinels become null in the materialized shape.
  assert.deepStrictEqual(seen[1], {
    generatedLine: 1,
    generatedColumn: 10,
    source: 'b.js',
    originalLine: null,
    originalColumn: null,
    name: null
  });
});

test('MappingList.unsortedForEach passes thisArg', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, -1, -1, -1, -1);
  var thisArg = { tag: 'ctx' };
  var seenThis = null;
  ctx.list.unsortedForEach(function () { seenThis = this; }, thisArg);
  assert.strictEqual(seenThis, thisArg);
});

test('MappingList.toArray returns mappings sorted by generated position', () => {
  var ctx = makeList();
  // Insert out of order — first add a mapping that's strictly after the
  // sentinel, then one that violates it. _sorted should flip to false and
  // toArray() should invoke _sort.
  ctx.list.add(2, 5, -1, -1, -1, -1);
  ctx.list.add(1, 0, -1, -1, -1, -1);
  ctx.list.add(2, 0, -1, -1, -1, -1);

  var arr = ctx.list.toArray();
  assert.strictEqual(arr.length, 3);
  assert.deepStrictEqual(arr.map(function (m) {
    return [m.generatedLine, m.generatedColumn];
  }), [[1, 0], [2, 0], [2, 5]]);
});

test('MappingList.toArray on an already-sorted list does not re-sort', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, -1, -1, -1, -1);
  ctx.list.add(1, 5, -1, -1, -1, -1);
  ctx.list.add(2, 0, -1, -1, -1, -1);

  // _sorted invariant: stays true when all adds came in strictly-after order.
  assert.strictEqual(ctx.list._sorted, true);

  var arr = ctx.list.toArray();
  assert.deepStrictEqual(arr.map(function (m) {
    return [m.generatedLine, m.generatedColumn];
  }), [[1, 0], [1, 5], [2, 0]]);
});

// The sortedness check in MappingList.add is a 6-level cascade
// (genLine → genCol → srcIdx → origLine → origCol → nameIdx). Each
// non-tied level returns a boolean directly; only on full equality does
// the chain fall through to the `>= lastNameIdx` final compare. The tests
// below exercise both "after" and "before" outcomes at every level so
// branch coverage matches the runtime decision tree.

test('MappingList.add flips _sorted at the genLine level', () => {
  var ctx = makeList();
  ctx.list.add(2, 0, -1, -1, -1, -1);
  ctx.list.add(1, 0, -1, -1, -1, -1);  // genLine < lastGenLine
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add flips _sorted at the genCol level', () => {
  var ctx = makeList();
  ctx.list.add(1, 5, -1, -1, -1, -1);
  ctx.list.add(1, 0, -1, -1, -1, -1);  // same genLine, genCol <
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add flips _sorted at the srcIdx level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 0, 0, 1, -1);
  ctx.list.add(1, 0, 0, 0, 0, -1);  // same genPos, srcIdx <
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add flips _sorted at the origLine level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 0, 0, -1);
  ctx.list.add(1, 0, 3, 0, 0, -1);  // same genPos+srcIdx, origLine <
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add flips _sorted at the origCol level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, -1);
  ctx.list.add(1, 0, 5, 3, 0, -1);  // same up through origLine, origCol <
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add flips _sorted at the nameIdx level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, 1);
  // Same everything through origCol, smaller nameIdx — final branch uses
  // strict `>=` so equal would still count as after; this exercises strict
  // <-than-last path that flips _sorted false.
  ctx.list.add(1, 0, 5, 7, 0, 0);
  assert.strictEqual(ctx.list._sorted, false);
});

test('MappingList.add keeps _sorted true when fully equal mapping is added (>= tie)', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, 0);
  ctx.list.add(1, 0, 5, 7, 0, 0);  // exact duplicate — counts as "after"
  assert.strictEqual(ctx.list._sorted, true);
});

// Each cascade level also has an "after = true at this level" branch that
// fires when the level's field is strictly greater than the previous mapping's.
test('MappingList.add: level genCol after-true (same genLine, greater genCol)', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, -1, -1, -1, -1);
  ctx.list.add(1, 5, -1, -1, -1, -1);
  assert.strictEqual(ctx.list._sorted, true);
});

test('MappingList.add: level srcIdx after-true', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 0, 0, 0, -1);
  ctx.list.add(1, 0, 0, 0, 1, -1);
  assert.strictEqual(ctx.list._sorted, true);
});

test('MappingList.add: level origLine after-true', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 3, 0, 0, -1);
  ctx.list.add(1, 0, 5, 0, 0, -1);
  assert.strictEqual(ctx.list._sorted, true);
});

test('MappingList.add: level origCol after-true', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 3, 0, -1);
  ctx.list.add(1, 0, 5, 7, 0, -1);
  assert.strictEqual(ctx.list._sorted, true);
});

test('MappingList.add: level nameIdx after-true', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, 0);
  ctx.list.add(1, 0, 5, 7, 0, 1);
  assert.strictEqual(ctx.list._sorted, true);
});

// _sort's comparator has the same 6-level cascade. The straight toArray
// test only hits the F_GEN_LINE/F_GEN_COL branches. Add an out-of-order
// pair tied on gen position that forces the comparator to descend.
test('MappingList.toArray sorts through deeper tie-break levels', () => {
  var ctx = makeList();
  // Two mappings same gen pos but different srcIdx, inserted out of order.
  ctx.list.add(1, 0, 0, 0, 1, -1);
  ctx.list.add(1, 0, 0, 0, 0, -1);
  assert.strictEqual(ctx.list._sorted, false);
  var arr = ctx.list.toArray();
  // Sort by srcIdx ascending — `a.js` (idx 0) comes before `b.js` (idx 1).
  assert.deepStrictEqual(arr.map(function (m) { return m.source; }), ['a.js', 'b.js']);
});

// _sort's perm comparator has the same 6-level cascade as add's sortedness
// check. The toArray test above only exercises the genLine/genCol/srcIdx
// branches of that comparator. Each subsequent level needs an out-of-order
// pair tied on the levels above it.
test('MappingList.toArray sorts at the origLine comparator level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 0, 0, -1);
  ctx.list.add(1, 0, 3, 0, 0, -1);
  var arr = ctx.list.toArray();
  assert.deepStrictEqual(arr.map(function (m) { return m.originalLine; }), [3, 5]);
});

test('MappingList.toArray sorts at the origCol comparator level', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, -1);
  ctx.list.add(1, 0, 5, 3, 0, -1);
  var arr = ctx.list.toArray();
  assert.deepStrictEqual(arr.map(function (m) { return m.originalColumn; }), [3, 7]);
});

test('MappingList.toArray sorts at the nameIdx comparator level', () => {
  var ctx = makeList();
  ctx.sources.add('a.js');
  ctx.names.add('bar');  // adds nameIdx=1 (after 'foo' at 0)
  ctx.list.add(1, 0, 5, 7, 0, 1);
  ctx.list.add(1, 0, 5, 7, 0, 0);
  var arr = ctx.list.toArray();
  assert.deepStrictEqual(arr.map(function (m) { return m.name; }), ['foo', 'bar']);
});

// _equalsPrev is used by SourceMapGenerator._serializeMappings to skip
// emitting duplicate segments. Each level of the 6-field equality chain
// has a short-circuit path that needs coverage.
test('MappingList._equalsPrev returns true for an exact duplicate adjacent pair', () => {
  var ctx = makeList();
  ctx.list.add(1, 0, 5, 7, 0, 0);
  ctx.list.add(1, 0, 5, 7, 0, 0);
  assert.strictEqual(ctx.list._equalsPrev(1), true);
});

test('MappingList._equalsPrev short-circuits at each cascade level', () => {
  // Helper that builds a fresh list, adds a base mapping plus a mutated
  // sibling differing only at the field we want to exercise. The
  // assertion is that _equalsPrev returns false because that field
  // differs — covering the short-circuit at that level.
  function diff(base, mut) {
    var ctx = makeList();
    ctx.list.add.apply(ctx.list, base);
    ctx.list.add.apply(ctx.list, mut);
    return ctx.list._equalsPrev(1);
  }
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [2, 0, 5, 7, 0, 0]), false); // genLine
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [1, 1, 5, 7, 0, 0]), false); // genCol
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [1, 0, 5, 7, 1, 0]), false); // srcIdx
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [1, 0, 6, 7, 0, 0]), false); // origLine
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [1, 0, 5, 8, 0, 0]), false); // origCol
  assert.strictEqual(diff([1, 0, 5, 7, 0, 0], [1, 0, 5, 7, 0, 1]), false); // nameIdx
});

test('MappingList grows the slab beyond initial capacity', () => {
  var ctx = makeList();
  // INITIAL_CAPACITY is 16 — push past the boundary to exercise _grow.
  for (var i = 0; i < 40; i++) {
    ctx.list.add(1 + i, 0, -1, -1, -1, -1);
  }
  assert.strictEqual(ctx.list._count, 40);
  var arr = ctx.list.toArray();
  assert.strictEqual(arr.length, 40);
  assert.strictEqual(arr[0].generatedLine, 1);
  assert.strictEqual(arr[39].generatedLine, 40);
});
