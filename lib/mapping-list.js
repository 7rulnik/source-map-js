/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2014 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

// A data structure that holds generator-side mappings in an Int32Array slab
// instead of one JS object per mapping. Eliminates the per-mapping heap
// allocation that dominated `addMapping` throughput on the previous
// object-array implementation (per bench-data-followups #2 — generator memory
// ratio ≈ generator speed ratio).
//
// Slab layout: 6 i32 slots per mapping, indexed by the F_* constants below.
// Sentinel -1 marks "no value" for the four optional slots (orig line/col,
// source idx, name idx). Source and name strings live in the owning
// SourceMapGenerator's ArraySet pair (`sources`, `names`) — MappingList stores
// indices into those ArraySets, so serialization can read indices directly
// from the slab with no per-mapping `indexOf` lookup.

var FIELDS_PER_MAPPING = 6;
var F_GEN_LINE  = 0;
var F_GEN_COL   = 1;
var F_SRC_IDX   = 2;  // -1 = no source
var F_ORIG_LINE = 3;  // -1 = no original line
var F_ORIG_COL  = 4;  // -1 = no original column
var F_NAME_IDX  = 5;  // -1 = no name

var INITIAL_CAPACITY = 16;

/**
 * A data structure to provide a sorted view of accumulated mappings in a
 * performance conscious manner. It trades a negligible overhead in the general
 * case for a large speedup in the common case of mappings being added in
 * generated-position order.
 *
 * The owning SourceMapGenerator passes its `sources` and `names` ArraySets so
 * we can resolve indices back to strings on `unsortedForEach` / `toArray` /
 * `applySourceMap` rebuilds.
 */
function MappingList(sources, names) {
  this._sources = sources;
  this._names = names;
  this._capacity = INITIAL_CAPACITY;
  this._buf = new Int32Array(INITIAL_CAPACITY * FIELDS_PER_MAPPING);
  this._count = 0;
  this._sorted = true;
  // Sentinel infimum — first add always sorts strictly after this.
  this._lastGenLine  = -1;
  this._lastGenCol   = 0;
  this._lastSrcIdx   = -1;
  this._lastOrigLine = -1;
  this._lastOrigCol  = -1;
  this._lastNameIdx  = -1;
}

MappingList.prototype._grow = function MappingList_grow() {
  var newCap = this._capacity * 2;
  var newBuf = new Int32Array(newCap * FIELDS_PER_MAPPING);
  newBuf.set(this._buf);
  this._buf = newBuf;
  this._capacity = newCap;
};

/**
 * Add a single mapping. All arguments are integers; pass -1 for absent
 * source/name/originalLine/originalColumn.
 */
MappingList.prototype.add = function MappingList_add(
  genLine, genCol, origLine, origCol, srcIdx, nameIdx
) {
  if (this._count === this._capacity) {
    this._grow();
  }

  // Sortedness check — equivalent of the old
  // `generatedPositionAfter(this._last, newMapping)` returning true.
  // Tie-break order uses integer compare on src/name instead of strcmp
  // on the source/name strings; that preserves equality classes
  // (same srcIdx ⇔ same source string), so the serializer's dedup
  // still works.
  var after;
  if (genLine !== this._lastGenLine) after = genLine > this._lastGenLine;
  else if (genCol !== this._lastGenCol) after = genCol > this._lastGenCol;
  else if (srcIdx !== this._lastSrcIdx) after = srcIdx > this._lastSrcIdx;
  else if (origLine !== this._lastOrigLine) after = origLine > this._lastOrigLine;
  else if (origCol !== this._lastOrigCol) after = origCol > this._lastOrigCol;
  else after = nameIdx >= this._lastNameIdx;

  if (after) {
    this._lastGenLine  = genLine;
    this._lastGenCol   = genCol;
    this._lastSrcIdx   = srcIdx;
    this._lastOrigLine = origLine;
    this._lastOrigCol  = origCol;
    this._lastNameIdx  = nameIdx;
  } else {
    this._sorted = false;
  }

  var off = this._count * FIELDS_PER_MAPPING;
  var buf = this._buf;
  buf[off + F_GEN_LINE]  = genLine;
  buf[off + F_GEN_COL]   = genCol;
  buf[off + F_SRC_IDX]   = srcIdx;
  buf[off + F_ORIG_LINE] = origLine;
  buf[off + F_ORIG_COL]  = origCol;
  buf[off + F_NAME_IDX]  = nameIdx;
  this._count++;
};

/**
 * Materialize one mapping at slab index `i` back to a JS object with the
 * shape callers used to see. Source/name indices are resolved through the
 * owning generator's ArraySets; -1 sentinels become `null`.
 */
MappingList.prototype._materialize = function MappingList_materialize(i) {
  var off = i * FIELDS_PER_MAPPING;
  var buf = this._buf;
  var srcIdx   = buf[off + F_SRC_IDX];
  var origLine = buf[off + F_ORIG_LINE];
  var origCol  = buf[off + F_ORIG_COL];
  var nameIdx  = buf[off + F_NAME_IDX];
  return {
    generatedLine:   buf[off + F_GEN_LINE],
    generatedColumn: buf[off + F_GEN_COL],
    source:          srcIdx === -1   ? null : this._sources.at(srcIdx),
    originalLine:    origLine === -1 ? null : origLine,
    originalColumn:  origCol === -1  ? null : origCol,
    name:            nameIdx === -1  ? null : this._names.at(nameIdx)
  };
};

/**
 * Iterate through internal items. Each callback invocation receives a
 * freshly-materialized mapping object. Mutating that object has no effect
 * on the underlying slab — callers that need to transform mappings should
 * rebuild the list (see SourceMapGenerator.applySourceMap).
 *
 * NOTE: The order of the mappings is NOT guaranteed.
 */
MappingList.prototype.unsortedForEach =
  function MappingList_forEach(aCallback, aThisArg) {
    for (var i = 0; i < this._count; i++) {
      aCallback.call(aThisArg, this._materialize(i));
    }
  };

/**
 * Returns true if the mapping at index `i` is field-for-field identical to
 * the mapping at index `i - 1`. Used by `_serializeMappings` to skip
 * emitting duplicate segments — equivalent of the old
 * `compareByGeneratedPositionsInflated(a, b) === 0` dedup check, but
 * direct slab reads.
 */
MappingList.prototype._equalsPrev = function MappingList_equalsPrev(i) {
  var a = i * FIELDS_PER_MAPPING;
  var b = a - FIELDS_PER_MAPPING;
  var buf = this._buf;
  return buf[a + F_GEN_LINE]  === buf[b + F_GEN_LINE]  &&
         buf[a + F_GEN_COL]   === buf[b + F_GEN_COL]   &&
         buf[a + F_SRC_IDX]   === buf[b + F_SRC_IDX]   &&
         buf[a + F_ORIG_LINE] === buf[b + F_ORIG_LINE] &&
         buf[a + F_ORIG_COL]  === buf[b + F_ORIG_COL]  &&
         buf[a + F_NAME_IDX]  === buf[b + F_NAME_IDX];
};

MappingList.prototype._sort = function MappingList_sort() {
  var n = this._count;
  var buf = this._buf;
  // n <= 1 falls through naturally — perm of length 0/1 sorts no-op, copy
  // loop runs 0/1 times. No early-return guard needed.
  // Sort a permutation array by mapping fields, then permute the slab.
  // Build a packed key for stable sort: V8 .sort is Tim Sort (stable
  // since ES2019), so equal keys preserve insertion order.
  var perm = new Array(n);
  for (var i = 0; i < n; i++) perm[i] = i;

  perm.sort(function (a, b) {
    var oa = a * FIELDS_PER_MAPPING;
    var ob = b * FIELDS_PER_MAPPING;
    var cmp = buf[oa + F_GEN_LINE] - buf[ob + F_GEN_LINE];
    if (cmp !== 0) return cmp;
    cmp = buf[oa + F_GEN_COL] - buf[ob + F_GEN_COL];
    if (cmp !== 0) return cmp;
    cmp = buf[oa + F_SRC_IDX] - buf[ob + F_SRC_IDX];
    if (cmp !== 0) return cmp;
    cmp = buf[oa + F_ORIG_LINE] - buf[ob + F_ORIG_LINE];
    if (cmp !== 0) return cmp;
    cmp = buf[oa + F_ORIG_COL] - buf[ob + F_ORIG_COL];
    if (cmp !== 0) return cmp;
    return buf[oa + F_NAME_IDX] - buf[ob + F_NAME_IDX];
  });

  var newBuf = new Int32Array(this._capacity * FIELDS_PER_MAPPING);
  for (var k = 0; k < n; k++) {
    var src = perm[k] * FIELDS_PER_MAPPING;
    var dst = k * FIELDS_PER_MAPPING;
    newBuf[dst + F_GEN_LINE]  = buf[src + F_GEN_LINE];
    newBuf[dst + F_GEN_COL]   = buf[src + F_GEN_COL];
    newBuf[dst + F_SRC_IDX]   = buf[src + F_SRC_IDX];
    newBuf[dst + F_ORIG_LINE] = buf[src + F_ORIG_LINE];
    newBuf[dst + F_ORIG_COL]  = buf[src + F_ORIG_COL];
    newBuf[dst + F_NAME_IDX]  = buf[src + F_NAME_IDX];
  }
  this._buf = newBuf;
};

/**
 * Returns the flat, sorted array of materialized mappings. The mappings
 * are sorted by generated position.
 *
 * Internal hot paths (`_serializeMappings`, `BasicSourceMapConsumer.fromSourceMap`)
 * read the slab directly instead. This method is kept for external API
 * compatibility — calling it materializes one JS object per mapping.
 */
MappingList.prototype.toArray = function MappingList_toArray() {
  if (!this._sorted) {
    this._sort();
    this._sorted = true;
  }
  var out = new Array(this._count);
  for (var i = 0; i < this._count; i++) {
    out[i] = this._materialize(i);
  }
  return out;
};

exports.MappingList = MappingList;

// Slab-layout constants exported for the internal hot-path consumers
// (`SourceMapGenerator._serializeMappings`, `BasicSourceMapConsumer.fromSourceMap`)
// that bypass `toArray()` materialization.
exports.FIELDS_PER_MAPPING = FIELDS_PER_MAPPING;
exports.F_GEN_LINE  = F_GEN_LINE;
exports.F_GEN_COL   = F_GEN_COL;
exports.F_SRC_IDX   = F_SRC_IDX;
exports.F_ORIG_LINE = F_ORIG_LINE;
exports.F_ORIG_COL  = F_ORIG_COL;
exports.F_NAME_IDX  = F_NAME_IDX;
