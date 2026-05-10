/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var util = require('./util');
var binarySearch = require('./binary-search');
var ArraySet = require('./array-set').ArraySet;
var base64VLQ = require('./base64-vlq');

function SourceMapConsumer(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util.parseSourceMapInput(aSourceMap);
  }

  return sourceMap.sections != null
    ? new IndexedSourceMapConsumer(sourceMap, aSourceMapURL)
    : new BasicSourceMapConsumer(sourceMap, aSourceMapURL);
}

SourceMapConsumer.fromSourceMap = function(aSourceMap, aSourceMapURL) {
  return BasicSourceMapConsumer.fromSourceMap(aSourceMap, aSourceMapURL);
}

/**
 * The version of the source mapping spec that we are consuming.
 */
SourceMapConsumer.prototype._version = 3;

// Parsed mappings are stored in Int32Array "slabs" instead of arrays of JS
// objects. Each mapping occupies six i32 slots (see SLAB_FIELDS below) — the
// generator-side MappingList from PR #64 uses the same layout. Eliminating the
// per-mapping heap object removes ~350k allocations per parse of a typical
// bundle and the ~12% GC tax that came with them.
//
// The generated-position slab lives on `this._genBuf` (Int32Array) +
// `this._genCount` (used row count). The original-position slab is the same,
// on `this._origBuf` + `this._origCount`. Both are built lazily on first
// access through the `_generatedMappings` / `_originalMappings` getters, which
// materialize back-compat object arrays from the slab on demand for callers
// that still expect the old shape.
//
// Slot semantics:
//   GEN_LINE, GEN_COL   — always set
//   SRC_IDX             — integer index into `_sources`, or -1 for "no source"
//   ORIG_LINE, ORIG_COL — integers, or -1 for "no original line/column"
//   NAME_IDX            — integer index into `_names`, or -1 for "no name"
//
// `_generatedMappings` is ordered by the generated positions.
// `_originalMappings`  is ordered by the original positions.

// Warm-start cache fields for `originalPositionFor`. Declared on the prototype
// so per-instance assignments don't grow the hidden class on first cache hit.
SourceMapConsumer.prototype._opfLine = -1;
SourceMapConsumer.prototype._opfColumn = -1;
SourceMapConsumer.prototype._opfIndex = -1;

// Cache for `_findSourceIndex` string→integer-index lookups. Lazy on first
// call. See the method body for the rationale.
SourceMapConsumer.prototype._sourceIndexCache = null;

// Per-source warm-start cache for `generatedPositionFor`. A single-slot cache
// (like the one above) wouldn't help the common `for (source of sources)`
// walk because each iteration changes the source. Instead we keep one
// (line, column, index) triple per source-index, packed into one Int32Array
// of length 3*N (allocated lazily on first GLB call). Sentinel -1 marks
// unset slots. The array is sized from `_sources.size()` and never resized.
SourceMapConsumer.prototype._gpfBySrc = null;

// Int32Array slab layout: 6 i32 slots per mapping, matching MappingList's
// generator-side field order (lib/mapping-list.js). Kept inline rather than
// imported because the consumer's hot paths read these constants in tight
// binary-search loops and the V8 inliner treats locally-declared constants
// best.
// Layout matches lib/mapping-list.js's MappingList slab exactly — same
// FIELDS_PER_MAPPING, same field order, same -1 sentinels — so fromSourceMap
// can copy the generator's slab into the consumer's with a single typed-array
// `set()` and no per-row decoding.
var SLAB_FIELDS    = 6;
var SLAB_GEN_LINE  = 0;
var SLAB_GEN_COL   = 1;
var SLAB_SRC_IDX   = 2;
var SLAB_ORIG_LINE = 3;
var SLAB_ORIG_COL  = 4;
var SLAB_NAME_IDX  = 5;
var SLAB_INITIAL_CAPACITY = 256;

// Slab storage — see top-of-file comment for semantics.
SourceMapConsumer.prototype._genBuf = null;
SourceMapConsumer.prototype._genCount = 0;
SourceMapConsumer.prototype._origBuf = null;
SourceMapConsumer.prototype._origCount = 0;
// Parallel Int32Array sized to `_genCount`, allocated lazily by
// `computeColumnSpans`. Slot i holds the last-generated-column for the
// mapping at slab row i, or -1 if the column extends to the line end.
SourceMapConsumer.prototype._lastGenCols = null;
// Per-row map orig→gen, built alongside `_origBuf` in `_buildOriginalMappings`.
// Lets `generatedPositionFor` / `allGeneratedPositionsFor` look up the
// matching `_lastGenCols` slot when `computeColumnSpans` has been called.
SourceMapConsumer.prototype._origToGen = null;

// Materialized-object-array caches. Lazy: only built if a caller goes through
// the `_generatedMappings` / `_originalMappings` getter (eachMapping,
// originalPositionFor, etc. all read the slab directly without touching these).
SourceMapConsumer.prototype.__generatedMappings = null;
SourceMapConsumer.prototype.__originalMappings = null;

Object.defineProperty(SourceMapConsumer.prototype, '_generatedMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (this._genBuf === null) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }
    if (this.__generatedMappings === null) {
      this.__generatedMappings = this._materializeSlabAsArray(this._genBuf, this._genCount);
    }
    return this.__generatedMappings;
  }
});

Object.defineProperty(SourceMapConsumer.prototype, '_originalMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (this._origBuf === null) {
      if (this._genBuf === null) {
        this._parseMappings(this._mappings, this.sourceRoot);
      }
      if (this._origBuf === null) {
        this._buildOriginalMappings();
      }
    }
    if (this.__originalMappings === null) {
      this.__originalMappings = this._materializeSlabAsArray(
        this._origBuf, this._origCount, this._origToGen);
    }
    return this.__originalMappings;
  }
});

// Materialize a `(buf, count)` slab into an Array<Mapping> with the legacy
// object shape (source/originalLine/originalColumn/name as integer index or
// `null`, matching how `_parseMappings` used to populate
// `__generatedMappings`). When `computeColumnSpans` has populated
// `_lastGenCols`, each output mapping also gets a `lastGeneratedColumn`
// property; for the original-order slab, the lookup hops through `origToGen`
// (built alongside `_origBuf`) to find the matching gen row.
SourceMapConsumer.prototype._materializeSlabAsArray =
  function SourceMapConsumer_materializeSlabAsArray(buf, count, origToGen) {
    var lastCols = this._lastGenCols;
    var out = new Array(count);
    for (var i = 0; i < count; i++) {
      var off = i * SLAB_FIELDS;
      var srcIdx   = buf[off + SLAB_SRC_IDX];
      var origLine = buf[off + SLAB_ORIG_LINE];
      var origCol  = buf[off + SLAB_ORIG_COL];
      var nameIdx  = buf[off + SLAB_NAME_IDX];
      var m = {
        generatedLine:   buf[off + SLAB_GEN_LINE],
        generatedColumn: buf[off + SLAB_GEN_COL],
        source:          srcIdx   === -1 ? null : srcIdx,
        originalLine:    origLine === -1 ? null : origLine,
        originalColumn:  origCol  === -1 ? null : origCol,
        name:            nameIdx  === -1 ? null : nameIdx
      };
      if (lastCols !== null) {
        var genIdx = origToGen !== undefined ? origToGen[i] : i;
        var v = lastCols[genIdx];
        m.lastGeneratedColumn = v === -1 ? Infinity : v;
      }
      out[i] = m;
    }
    return out;
  };

SourceMapConsumer.prototype._charIsMappingSeparator =
  function SourceMapConsumer_charIsMappingSeparator(aStr, index) {
    var c = aStr.charAt(index);
    return c === ";" || c === ",";
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
SourceMapConsumer.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    throw new Error("Subclasses must implement _parseMappings");
  };

SourceMapConsumer.GENERATED_ORDER = 1;
SourceMapConsumer.ORIGINAL_ORDER = 2;

SourceMapConsumer.GREATEST_LOWER_BOUND = 1;
SourceMapConsumer.LEAST_UPPER_BOUND = 2;

/**
 * Iterate over each mapping between an original source/line/column and a
 * generated line/column in this source map.
 *
 * @param Function aCallback
 *        The function that is called with each mapping.
 * @param Object aContext
 *        Optional. If specified, this object will be the value of `this` every
 *        time that `aCallback` is called.
 * @param aOrder
 *        Either `SourceMapConsumer.GENERATED_ORDER` or
 *        `SourceMapConsumer.ORIGINAL_ORDER`. Specifies whether you want to
 *        iterate over the mappings sorted by the generated file's line/column
 *        order or the original's source/line/column order, respectively. Defaults to
 *        `SourceMapConsumer.GENERATED_ORDER`.
 */
SourceMapConsumer.prototype.eachMapping =
  function SourceMapConsumer_eachMapping(aCallback, aContext, aOrder) {
    var context = aContext || null;
    var order = aOrder || SourceMapConsumer.GENERATED_ORDER;

    // Go through the materialized-array getters rather than reading the slab
    // directly: the first call materializes once and the result is cached on
    // `__generatedMappings` / `__originalMappings`, so repeated eachMapping
    // calls iterate the stable-hidden-class object array (the post-#70
    // shape) instead of paying the slab-decode price per row each time.
    var mappings;
    switch (order) {
    case SourceMapConsumer.GENERATED_ORDER:
      mappings = this._generatedMappings;
      break;
    case SourceMapConsumer.ORIGINAL_ORDER:
      mappings = this._originalMappings;
      break;
    default:
      throw new Error("Unknown order of iteration.");
    }

    var cb = context !== null ? aCallback.bind(context) : aCallback;
    var nameArray = this._names._array;
    var absoluteSources = this._absoluteSources;

    for (var i = 0, n = mappings.length; i < n; i++) {
      var mapping = mappings[i];
      var src = mapping.source;
      var nm = mapping.name;
      cb({
        source: src === null ? null : absoluteSources[src],
        generatedLine: mapping.generatedLine,
        generatedColumn: mapping.generatedColumn,
        originalLine: mapping.originalLine,
        originalColumn: mapping.originalColumn,
        name: nm === null ? null : nameArray[nm]
      });
    }
  };

/**
 * Returns all generated line and column information for the original source,
 * line, and column provided. If no column is provided, returns all mappings
 * corresponding to a either the line we are searching for or the next
 * closest line that has any mappings. Otherwise, returns all mappings
 * corresponding to the given line and either the column we are searching for
 * or the next closest column that has any offsets.
 *
 * The only argument is an object with the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number is 1-based.
 *   - column: Optional. the column number in the original source.
 *    The column number is 0-based.
 *
 * and an array of objects is returned, each with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *    line number is 1-based.
 *   - column: The column number in the generated source, or null.
 *    The column number is 0-based.
 */
SourceMapConsumer.prototype.allGeneratedPositionsFor =
  function SourceMapConsumer_allGeneratedPositionsFor(aArgs) {
    var line = util.getArg(aArgs, 'line');
    var source = this._findSourceIndex(util.getArg(aArgs, 'source'));
    if (source < 0) {
      return [];
    }
    var hasColumn = aArgs.column !== undefined;
    // column defaults to 0 for the LUB needle so the search lands on the
    // smallest mapping with originalLine >= line.
    var needleColumn = hasColumn ? aArgs.column : 0;

    if (this._origBuf === null) {
      if (this._genBuf === null) {
        this._parseMappings(this._mappings, this.sourceRoot);
      }
      if (this._origBuf === null) {
        this._buildOriginalMappings();
      }
    }
    var buf = this._origBuf;
    var count = this._origCount;
    var lastCols = this._lastGenCols;
    var origToGen = this._origToGen;

    // Inline LUB binary search on (source, originalLine, originalColumn).
    // Returns the smallest index with value >= needle, then rewinds through
    // ties to match binarySearch.search's smallest-equal semantics.
    var lo = -1;
    var hi = count;
    while (hi - lo > 1) {
      var mid = (lo + hi) >>> 1;
      var off = mid * SLAB_FIELDS;
      var cmp;
      if (buf[off + SLAB_SRC_IDX] !== source) cmp = buf[off + SLAB_SRC_IDX] - source;
      else if (buf[off + SLAB_ORIG_LINE] !== line) cmp = buf[off + SLAB_ORIG_LINE] - line;
      else cmp = buf[off + SLAB_ORIG_COL] - needleColumn;
      if (cmp < 0) lo = mid;
      else hi = mid;
    }
    if (hi >= count) return [];
    while (hi > 0) {
      var aOff = hi * SLAB_FIELDS;
      var bOff = (hi - 1) * SLAB_FIELDS;
      if (buf[aOff + SLAB_SRC_IDX]   !== buf[bOff + SLAB_SRC_IDX]   ||
          buf[aOff + SLAB_ORIG_LINE] !== buf[bOff + SLAB_ORIG_LINE] ||
          buf[aOff + SLAB_ORIG_COL]  !== buf[bOff + SLAB_ORIG_COL]) {
        break;
      }
      hi--;
    }
    var index = hi;

    var firstOff = index * SLAB_FIELDS;
    if (buf[firstOff + SLAB_SRC_IDX] !== source) return [];

    var mappings = [];
    if (!hasColumn) {
      // Collect every mapping on the matching originalLine (within the
      // source) — the LUB landed on the smallest such index, so consecutive
      // rows are contiguous up to the line change.
      var matchLine = buf[firstOff + SLAB_ORIG_LINE];
      var i = index;
      while (i < count) {
        var off2 = i * SLAB_FIELDS;
        if (buf[off2 + SLAB_SRC_IDX] !== source ||
            buf[off2 + SLAB_ORIG_LINE] !== matchLine) {
          break;
        }
        var lastCol = null;
        if (lastCols !== null) {
          var v = lastCols[origToGen[i]];
          lastCol = v === -1 ? Infinity : v;
        }
        mappings.push({
          line: buf[off2 + SLAB_GEN_LINE],
          column: buf[off2 + SLAB_GEN_COL],
          lastColumn: lastCol
        });
        i++;
      }
    } else {
      var matchCol = buf[firstOff + SLAB_ORIG_COL];
      var i = index;
      while (i < count) {
        var off2 = i * SLAB_FIELDS;
        if (buf[off2 + SLAB_SRC_IDX] !== source ||
            buf[off2 + SLAB_ORIG_LINE] !== line ||
            buf[off2 + SLAB_ORIG_COL] != matchCol) {
          break;
        }
        var lastCol = null;
        if (lastCols !== null) {
          var v = lastCols[origToGen[i]];
          lastCol = v === -1 ? Infinity : v;
        }
        mappings.push({
          line: buf[off2 + SLAB_GEN_LINE],
          column: buf[off2 + SLAB_GEN_COL],
          lastColumn: lastCol
        });
        i++;
      }
    }

    return mappings;
  };

exports.SourceMapConsumer = SourceMapConsumer;

/**
 * A BasicSourceMapConsumer instance represents a parsed source map which we can
 * query for information about the original file positions by giving it a file
 * position in the generated source.
 *
 * The first parameter is the raw source map (either as a JSON string, or
 * already parsed to an object). According to the spec, source maps have the
 * following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - sources: An array of URLs to the original source files.
 *   - names: An array of identifiers which can be referrenced by individual mappings.
 *   - sourceRoot: Optional. The URL root from which all sources are relative.
 *   - sourcesContent: Optional. An array of contents of the original source files.
 *   - mappings: A string of base64 VLQs which contain the actual mappings.
 *   - file: Optional. The generated file this source map is associated with.
 *
 * Here is an example source map, taken from the source map spec[0]:
 *
 *     {
 *       version : 3,
 *       file: "out.js",
 *       sourceRoot : "",
 *       sources: ["foo.js", "bar.js"],
 *       names: ["src", "maps", "are", "fun"],
 *       mappings: "AA,AB;;ABCDE;"
 *     }
 *
 * The second parameter, if given, is a string whose value is the URL
 * at which the source map was found.  This URL is used to compute the
 * sources array.
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit?pli=1#
 */
function BasicSourceMapConsumer(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util.parseSourceMapInput(aSourceMap);
  }

  var version = util.getArg(sourceMap, 'version');
  var sources = util.getArg(sourceMap, 'sources');
  // Sass 3.3 leaves out the 'names' array, so we deviate from the spec (which
  // requires the array) to play nice here. Inlined getArg with default for
  // the optional fields below — see #59 for the pattern.
  var names = sourceMap.names != null ? sourceMap.names : [];
  var sourceRoot = sourceMap.sourceRoot != null ? sourceMap.sourceRoot : null;
  var sourcesContent = sourceMap.sourcesContent != null ? sourceMap.sourcesContent : null;
  var mappings = util.getArg(sourceMap, 'mappings');
  var file = sourceMap.file != null ? sourceMap.file : null;

  // Once again, Sass deviates from the spec and supplies the version as a
  // string rather than a number, so we use loose equality checking here.
  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  if (sourceRoot) {
    sourceRoot = util.normalize(sourceRoot);
  }

  sources = sources
    .map(String)
    // Some source maps produce relative source paths like "./foo.js" instead of
    // "foo.js".  Normalize these first so that future comparisons will succeed.
    // See bugzil.la/1090768.
    .map(util.normalize)
    // Always ensure that absolute sources are internally stored relative to
    // the source root, if the source root is absolute. Not doing this would
    // be particularly problematic when the source root is a prefix of the
    // source (valid, but why??). See github issue #199 and bugzil.la/1188982.
    .map(function (source) {
      return sourceRoot && util.isAbsolute(sourceRoot) && util.isAbsolute(source)
        ? util.relative(sourceRoot, source)
        : source;
    });

  // Pass `true` below to allow duplicate names and sources. While source maps
  // are intended to be compressed and deduplicated, the TypeScript compiler
  // sometimes generates source maps with duplicates in them. See Github issue
  // #72 and bugzil.la/889492.
  this._names = ArraySet.fromArray(names.map(String), true);
  this._sources = ArraySet.fromArray(sources, true);

  this._absoluteSources = this._sources.toArray().map(function (s) {
    return util.computeSourceURL(sourceRoot, s, aSourceMapURL);
  });

  this.sourceRoot = sourceRoot;
  this.sourcesContent = sourcesContent;
  this._mappings = mappings;
  this._sourceMapURL = aSourceMapURL;
  this.file = file;
}

BasicSourceMapConsumer.prototype = Object.create(SourceMapConsumer.prototype);
BasicSourceMapConsumer.prototype.consumer = SourceMapConsumer;

/**
 * Utility function to find the index of a source.  Returns -1 if not
 * found.
 */
BasicSourceMapConsumer.prototype._findSourceIndex = function(aSource) {
  // Memoize string→index lookups. Callers like
  // `for (s of consumer.sources) consumer.generatedPositionFor({source: s, ...})`
  // pass each absolute URL through here, and the unmemoized fallback below
  // is an O(N) scan of `_absoluteSources`. Cache misses (-1) too so we
  // don't re-scan when the source genuinely isn't in this consumer.
  var cache = this._sourceIndexCache;
  if (cache !== null) {
    var cached = cache.get(aSource);
    if (cached !== undefined) return cached;
  } else {
    cache = this._sourceIndexCache = new Map();
  }

  var relativeSource = aSource;
  if (this.sourceRoot != null) {
    relativeSource = util.relative(this.sourceRoot, relativeSource);
  }

  var idx = -1;
  if (this._sources.has(relativeSource)) {
    idx = this._sources.indexOf(relativeSource);
  } else {
    // Maybe aSource is an absolute URL as returned by |sources|.  In
    // this case we can't simply undo the transform.
    for (var i = 0; i < this._absoluteSources.length; ++i) {
      if (this._absoluteSources[i] == aSource) {
        idx = i;
        break;
      }
    }
  }

  cache.set(aSource, idx);
  return idx;
};

/**
 * Create a BasicSourceMapConsumer from a SourceMapGenerator.
 *
 * @param SourceMapGenerator aSourceMap
 *        The source map that will be consumed.
 * @param String aSourceMapURL
 *        The URL at which the source map can be found (optional)
 * @returns BasicSourceMapConsumer
 */
BasicSourceMapConsumer.fromSourceMap =
  function SourceMapConsumer_fromSourceMap(aSourceMap, aSourceMapURL) {
    var smc = Object.create(BasicSourceMapConsumer.prototype);

    var names = smc._names = ArraySet.fromArray(aSourceMap._names.toArray(), true);
    var sources = smc._sources = ArraySet.fromArray(aSourceMap._sources.toArray(), true);
    smc.sourceRoot = aSourceMap._sourceRoot;
    smc.sourcesContent = aSourceMap._generateSourcesContent(smc._sources.toArray(),
                                                            smc.sourceRoot);
    smc.file = aSourceMap._file;
    smc._sourceMapURL = aSourceMapURL;
    smc._absoluteSources = smc._sources.toArray().map(function (s) {
      return util.computeSourceURL(smc.sourceRoot, s, aSourceMapURL);
    });

    // Copy the generator's MappingList slab straight into a consumer slab.
    // ML_FIELDS / SLAB_FIELDS share the same layout and the same sentinel
    // (-1 for absent source/origLine/origCol/name), so a single typed-array
    // `set()` covers the active rows. Source/name remain integer indices —
    // smc._sources / smc._names were initialized from aSourceMap's toArray()
    // above, so the indices are identical.
    var ml = aSourceMap._mappings;
    if (!ml._sorted) {
      ml._sort();
      ml._sorted = true;
    }
    var mlBuf = ml._buf;
    var mlCount = ml._count;
    var genBuf = new Int32Array(mlCount * SLAB_FIELDS);
    genBuf.set(mlBuf.subarray(0, mlCount * SLAB_FIELDS));
    smc._genBuf = genBuf;
    smc._genCount = mlCount;
    // Build _origBuf via the shared bucketing path on the freshly-populated
    // _genBuf. Mirrors _parseMappings → _buildOriginalMappings.
    BasicSourceMapConsumer.prototype._buildOriginalMappings.call(smc);

    return smc;
  };

/**
 * The version of the source mapping spec that we are consuming.
 */
BasicSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(BasicSourceMapConsumer.prototype, 'sources', {
  get: function () {
    return this._absoluteSources.slice();
  }
});

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */

// Swap two slab rows by index. Each row is `SLAB_FIELDS` i32 slots, so a swap
// is 12 typed-array reads / 12 writes — still cheap inside a per-line sort
// because most maps come in already sorted and the swap path never runs.
function slabSwapRows(buf, i, j) {
  var oi = i * SLAB_FIELDS;
  var oj = j * SLAB_FIELDS;
  for (var k = 0; k < SLAB_FIELDS; k++) {
    var tmp = buf[oi + k];
    buf[oi + k] = buf[oj + k];
    buf[oj + k] = tmp;
  }
}

// Sort slab rows in `[start, count)` by `generatedColumn` (line is constant
// within a per-line subarray, so column-only suffices). Mirrors the original
// object-array `sortGenerated` strategy: check-sorted first, then either
// insertion sort for small n or quicksort-by-row for large n.
function sortGeneratedSlab(buf, start, count) {
  var n = count - start;
  if (n <= 1) return;

  // Check-sorted fast path — well-formed source maps emit segments in
  // increasing generatedColumn within each line, so this is overwhelmingly
  // the common case and we exit without doing any swap work.
  var sorted = true;
  for (var i = start + 1; i < count; i++) {
    if (buf[(i - 1) * SLAB_FIELDS + SLAB_GEN_COL] >
        buf[i * SLAB_FIELDS + SLAB_GEN_COL]) {
      sorted = false;
      break;
    }
  }
  if (sorted) return;

  if (n === 2) {
    slabSwapRows(buf, start, start + 1);
    return;
  }

  if (n < 20) {
    for (var i = start + 1; i < count; i++) {
      for (var j = i; j > start; j--) {
        if (buf[(j - 1) * SLAB_FIELDS + SLAB_GEN_COL] <=
            buf[j * SLAB_FIELDS + SLAB_GEN_COL]) {
          break;
        }
        slabSwapRows(buf, j - 1, j);
      }
    }
    return;
  }

  // Large unsorted run — sort a permutation array by genCol, then permute
  // the slab in one pass. O(n) extra memory but only triggered for the rare
  // ill-formed map.
  var perm = new Array(n);
  for (var i = 0; i < n; i++) perm[i] = start + i;
  perm.sort(function (a, b) {
    return buf[a * SLAB_FIELDS + SLAB_GEN_COL] -
           buf[b * SLAB_FIELDS + SLAB_GEN_COL];
  });
  var sortedBuf = new Int32Array(n * SLAB_FIELDS);
  for (var k = 0; k < n; k++) {
    var srcOff = perm[k] * SLAB_FIELDS;
    var dstOff = k * SLAB_FIELDS;
    for (var f = 0; f < SLAB_FIELDS; f++) {
      sortedBuf[dstOff + f] = buf[srcOff + f];
    }
  }
  for (var k = 0; k < n; k++) {
    var dstOff = (start + k) * SLAB_FIELDS;
    var srcOff = k * SLAB_FIELDS;
    for (var f = 0; f < SLAB_FIELDS; f++) {
      buf[dstOff + f] = sortedBuf[srcOff + f];
    }
  }
}
// Lookup table for single-byte VLQ decode (no continuation bit)
// Maps base64 char code -> decoded signed value, or undefined if multi-byte
var vlqTable = [];
(function() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (var i = 0; i < 128; i++) vlqTable[i] = undefined;
  // Only first 32 base64 values (A-f) are single-byte VLQ (no continuation bit)
  for (var i = 0; i < 32; i++) {
    var charCode = chars.charCodeAt(i);
    // Single-byte VLQ: bit 0 is sign, bits 1-4 are value
    var value = i >> 1;
    vlqTable[charCode] = (i & 1) ? -value : value;
  }
})();

BasicSourceMapConsumer.prototype._parseMappings =
  function SourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    var generatedLine = 1;
    var previousGeneratedColumn = 0;
    var previousOriginalLine = 0;
    var previousOriginalColumn = 0;
    var previousSource = 0;
    var previousName = 0;
    var length = aStr.length;
    var index = 0;
    var temp = {};
    var value, charCode;
    // Reuse segment array to avoid allocations per mapping
    var segment = [0, 0, 0, 0, 0];
    var segmentLength = 0;

    // Estimate initial slab capacity from the mappings string length —
    // typical VLQ segments are 5-10 chars apiece, so `length >> 3` is a
    // safe lower bound that avoids most reallocations on real-world maps.
    var capacity = Math.max(SLAB_INITIAL_CAPACITY, length >> 3);
    var buf = new Int32Array(capacity * SLAB_FIELDS);
    var count = 0;
    var subarrayStart = 0;

    while (index < length) {
      charCode = aStr.charCodeAt(index);
      if (charCode === 59) { // ';'
        generatedLine++;
        index++;
        previousGeneratedColumn = 0;

        sortGeneratedSlab(buf, subarrayStart, count);
        subarrayStart = count;
      }
      else if (charCode === 44) { // ','
        index++;
      }
      else {
        // Decode VLQ values until we hit a separator
        segmentLength = 0;
        while (index < length) {
          charCode = aStr.charCodeAt(index);
          if (charCode === 44 || charCode === 59) { // ',' or ';'
            break;
          }
          // Fast path for single-byte VLQ (most common case)
          value = vlqTable[charCode];
          if (value !== undefined) {
            index++;
            segment[segmentLength++] = value;
          } else {
            base64VLQ.decode(aStr, index, temp);
            value = temp.value;
            index = temp.rest;
            segment[segmentLength++] = value;
          }
        }

        if (segmentLength === 2) {
          throw new Error('Found a source, but no line and column');
        }

        if (segmentLength === 3) {
          throw new Error('Found a source and line, but no column');
        }

        var genCol = previousGeneratedColumn + segment[0];
        previousGeneratedColumn = genCol;

        var srcIdx = -1, origLine = -1, origCol = -1, nameIdx = -1;
        if (segmentLength > 1) {
          srcIdx = previousSource + segment[1];
          previousSource = srcIdx;

          var origLine0 = previousOriginalLine + segment[2];
          previousOriginalLine = origLine0;
          origLine = origLine0 + 1; // stored 1-based

          origCol = previousOriginalColumn + segment[3];
          previousOriginalColumn = origCol;

          if (segmentLength > 4) {
            nameIdx = previousName + segment[4];
            previousName = nameIdx;
          }
        }

        if (count === capacity) {
          // Grow: double capacity, copy slab. set() on a typed array is a
          // single memmove under the hood — much faster than re-pushing
          // 6×count i32s individually.
          capacity *= 2;
          var nb = new Int32Array(capacity * SLAB_FIELDS);
          nb.set(buf);
          buf = nb;
        }
        var off = count * SLAB_FIELDS;
        buf[off + SLAB_GEN_LINE]  = generatedLine;
        buf[off + SLAB_GEN_COL]   = genCol;
        buf[off + SLAB_SRC_IDX]   = srcIdx;
        buf[off + SLAB_ORIG_LINE] = origLine;
        buf[off + SLAB_ORIG_COL]  = origCol;
        buf[off + SLAB_NAME_IDX]  = nameIdx;
        count++;
      }
    }

    sortGeneratedSlab(buf, subarrayStart, count);
    this._genBuf = buf;
    this._genCount = count;
  };

/**
 * Build originalMappings lazily from generatedMappings.
 */
BasicSourceMapConsumer.prototype._buildOriginalMappings =
  function SourceMapConsumer_buildOriginalMappings() {
    var genBuf = this._genBuf;
    var genCount = this._genCount;

    // Pass 1: count rows that carry an original position. A `-1` SLAB_ORIG_LINE
    // marks "no original" (mappings emitted with a generated column only); we
    // skip them entirely. _parseMappings keeps SLAB_SRC_IDX / SLAB_ORIG_LINE
    // / SLAB_ORIG_COL in lockstep, so a single check on origLine is enough.
    var rowsWithSource = 0;
    var maxSrcIdx = -1;
    for (var i = 0; i < genCount; i++) {
      var off = i * SLAB_FIELDS;
      if (genBuf[off + SLAB_ORIG_LINE] !== -1) {
        rowsWithSource++;
        var s = genBuf[off + SLAB_SRC_IDX];
        if (s > maxSrcIdx) maxSrcIdx = s;
      }
    }

    var origBuf = new Int32Array(rowsWithSource * SLAB_FIELDS);
    var origToGen = new Int32Array(rowsWithSource);
    if (rowsWithSource === 0) {
      this._origBuf = origBuf;
      this._origCount = 0;
      this._origToGen = origToGen;
      return;
    }

    // Pass 2: bucket gen-slab row indices by source. The buckets are kept as
    // plain JS arrays of i32 indices — the per-source counts (a few hundred
    // to a few thousand for typical bundles) make a flat per-source pool
    // overkill vs. the simplicity of small arrays.
    var buckets = new Array(maxSrcIdx + 1);
    for (var i = 0; i < genCount; i++) {
      var off = i * SLAB_FIELDS;
      if (genBuf[off + SLAB_ORIG_LINE] !== -1) {
        var s = genBuf[off + SLAB_SRC_IDX];
        var b = buckets[s];
        if (b === undefined) {
          b = buckets[s] = [];
        }
        b.push(i);
      }
    }

    // Pass 3: for each non-null bucket, ensure sorted by (originalLine,
    // originalColumn, generatedColumn, generatedLine, name) — matches
    // compareByOriginalPositionsNoSource — then copy rows into the orig
    // slab. Well-formed maps emit per-source in original-position order, so
    // the check-sorted pass almost always wins and the comparator-based
    // sort below never runs.
    var dstRow = 0;
    for (var s = 0; s <= maxSrcIdx; s++) {
      var bucket = buckets[s];
      if (bucket === undefined) continue;

      var n = bucket.length;
      var sorted = true;
      for (var k = 1; k < n; k++) {
        var aOff = bucket[k - 1] * SLAB_FIELDS;
        var bOff = bucket[k] * SLAB_FIELDS;
        var d = genBuf[aOff + SLAB_ORIG_LINE] - genBuf[bOff + SLAB_ORIG_LINE];
        if (d > 0) { sorted = false; break; }
        if (d === 0 &&
            genBuf[aOff + SLAB_ORIG_COL] > genBuf[bOff + SLAB_ORIG_COL]) {
          sorted = false; break;
        }
      }

      if (!sorted) {
        bucket.sort(function (a, b) {
          var aOff = a * SLAB_FIELDS;
          var bOff = b * SLAB_FIELDS;
          var d = genBuf[aOff + SLAB_ORIG_LINE] - genBuf[bOff + SLAB_ORIG_LINE];
          if (d !== 0) return d;
          d = genBuf[aOff + SLAB_ORIG_COL] - genBuf[bOff + SLAB_ORIG_COL];
          if (d !== 0) return d;
          d = genBuf[aOff + SLAB_GEN_COL] - genBuf[bOff + SLAB_GEN_COL];
          if (d !== 0) return d;
          d = genBuf[aOff + SLAB_GEN_LINE] - genBuf[bOff + SLAB_GEN_LINE];
          if (d !== 0) return d;
          return genBuf[aOff + SLAB_NAME_IDX] - genBuf[bOff + SLAB_NAME_IDX];
        });
      }

      for (var k = 0; k < n; k++) {
        var genIdx = bucket[k];
        var srcOff = genIdx * SLAB_FIELDS;
        var dstOff = dstRow * SLAB_FIELDS;
        origBuf[dstOff + SLAB_GEN_LINE]  = genBuf[srcOff + SLAB_GEN_LINE];
        origBuf[dstOff + SLAB_GEN_COL]   = genBuf[srcOff + SLAB_GEN_COL];
        origBuf[dstOff + SLAB_SRC_IDX]   = genBuf[srcOff + SLAB_SRC_IDX];
        origBuf[dstOff + SLAB_ORIG_LINE] = genBuf[srcOff + SLAB_ORIG_LINE];
        origBuf[dstOff + SLAB_ORIG_COL]  = genBuf[srcOff + SLAB_ORIG_COL];
        origBuf[dstOff + SLAB_NAME_IDX]  = genBuf[srcOff + SLAB_NAME_IDX];
        origToGen[dstRow] = genIdx;
        dstRow++;
      }
    }

    this._origBuf = origBuf;
    this._origCount = dstRow;
    this._origToGen = origToGen;
  };

/**
 * Compute the last column for each generated mapping. The last column is
 * inclusive.
 */
BasicSourceMapConsumer.prototype.computeColumnSpans =
  function SourceMapConsumer_computeColumnSpans() {
    if (this._genBuf === null) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }
    var buf = this._genBuf;
    var n = this._genCount;
    var lastCols = this._lastGenCols = new Int32Array(n);
    // Sentinel -1 in the slab serializes back to `Infinity` at the callers
    // that return `lastColumn` to user code (originalPositionFor /
    // generatedPositionFor / allGeneratedPositionsFor / eachMapping).
    for (var i = 0; i < n; i++) {
      var off = i * SLAB_FIELDS;
      if (i + 1 < n) {
        var nextOff = (i + 1) * SLAB_FIELDS;
        if (buf[off + SLAB_GEN_LINE] === buf[nextOff + SLAB_GEN_LINE]) {
          lastCols[i] = buf[nextOff + SLAB_GEN_COL] - 1;
          continue;
        }
      }
      lastCols[i] = -1;
    }
    // Invalidate any cached object-array view so a stale `_generatedMappings`
    // getter doesn't return mappings without `lastGeneratedColumn`.
    this.__generatedMappings = null;
    this.__originalMappings = null;
  };

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.  The line number
 *     is 1-based.
 *   - column: The column number in the generated source.  The column
 *     number is 0-based.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the original source, or null.  The
 *     column number is 0-based.
 *   - name: The original identifier, or null.
 */
BasicSourceMapConsumer.prototype.originalPositionFor =
  function SourceMapConsumer_originalPositionFor(aArgs) {
    // Inline the optional read for required args — every trace call paid
    // for a `getArg` function call plus an `'in' in aArgs` check. Combining
    // the value validation with a `typeof !== 'number'` guard preserves the
    // documented "is a required argument" error for missing/undefined args
    // while skipping the function-call overhead.
    var needleLine = aArgs.line;
    var needleColumn = aArgs.column;
    if (typeof needleLine !== 'number') {
      throw new Error('"line" is a required argument.');
    }
    if (needleLine <= 0) {
      throw new TypeError('Line must be greater than or equal to 1, got ' + needleLine);
    }
    if (typeof needleColumn !== 'number') {
      throw new Error('"column" is a required argument.');
    }
    if (needleColumn < 0) {
      throw new TypeError('Column must be greater than or equal to 0, got ' + needleColumn);
    }
    var bias = aArgs.bias != null ? aArgs.bias : SourceMapConsumer.GREATEST_LOWER_BOUND;

    if (this._genBuf === null) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }
    var buf = this._genBuf;
    var count = this._genCount;

    var index = -1;

    // Warm-start cache: ascending-column traces (the bundler walk pattern)
    // repeatedly query the same line with growing columns. When applicable,
    // run a bounded inline binary search on [cachedIndex, count). GLB only.
    if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND &&
        this._opfLine === needleLine &&
        needleColumn >= this._opfColumn) {
      var lo = this._opfIndex;
      var hi = count;
      while (hi - lo > 1) {
        var mid = (lo + hi) >>> 1;
        var off = mid * SLAB_FIELDS;
        var cmp = buf[off + SLAB_GEN_LINE] - needleLine;
        if (cmp === 0) cmp = buf[off + SLAB_GEN_COL] - needleColumn;
        if (cmp <= 0) lo = mid;
        else hi = mid;
      }
      while (lo > 0) {
        var aOff = lo * SLAB_FIELDS;
        var bOff = (lo - 1) * SLAB_FIELDS;
        if (buf[aOff + SLAB_GEN_LINE] !== buf[bOff + SLAB_GEN_LINE] ||
            buf[aOff + SLAB_GEN_COL] !== buf[bOff + SLAB_GEN_COL]) {
          break;
        }
        lo--;
      }
      index = lo;
    }

    if (index < 0) {
      // Cold-path inline binary search on the slab. Same approach as the
      // gpf inline cold path landed in PR #68: direct typed-array reads,
      // no aCompare callback through binarySearch.search, no needle alloc.
      if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND) {
        var lo = -1;
        var hi = count;
        while (hi - lo > 1) {
          var mid = (lo + hi) >>> 1;
          var off = mid * SLAB_FIELDS;
          var cmp = buf[off + SLAB_GEN_LINE] - needleLine;
          if (cmp === 0) cmp = buf[off + SLAB_GEN_COL] - needleColumn;
          if (cmp <= 0) lo = mid;
          else hi = mid;
        }
        if (lo >= 0) {
          while (lo > 0) {
            var aOff = lo * SLAB_FIELDS;
            var bOff = (lo - 1) * SLAB_FIELDS;
            if (buf[aOff + SLAB_GEN_LINE] !== buf[bOff + SLAB_GEN_LINE] ||
                buf[aOff + SLAB_GEN_COL] !== buf[bOff + SLAB_GEN_COL]) {
              break;
            }
            lo--;
          }
          index = lo;
        }
      } else {
        // LUB: smallest index whose value is >= needle. Rewind to smallest-
        // equal to match binarySearch.search semantics.
        var lo = -1;
        var hi = count;
        while (hi - lo > 1) {
          var mid = (lo + hi) >>> 1;
          var off = mid * SLAB_FIELDS;
          var cmp = buf[off + SLAB_GEN_LINE] - needleLine;
          if (cmp === 0) cmp = buf[off + SLAB_GEN_COL] - needleColumn;
          if (cmp < 0) lo = mid;
          else hi = mid;
        }
        if (hi < count) {
          while (hi > 0) {
            var aOff = hi * SLAB_FIELDS;
            var bOff = (hi - 1) * SLAB_FIELDS;
            if (buf[aOff + SLAB_GEN_LINE] !== buf[bOff + SLAB_GEN_LINE] ||
                buf[aOff + SLAB_GEN_COL] !== buf[bOff + SLAB_GEN_COL]) {
              break;
            }
            hi--;
          }
          index = hi;
        }
      }
    }

    if (index >= 0) {
      var off = index * SLAB_FIELDS;
      if (buf[off + SLAB_GEN_LINE] === needleLine) {
        if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND) {
          this._opfLine = needleLine;
          this._opfColumn = needleColumn;
          this._opfIndex = index;
        }

        var srcIdx = buf[off + SLAB_SRC_IDX];
        var source = srcIdx === -1 ? null : this._absoluteSources[srcIdx];
        var nameIdx = buf[off + SLAB_NAME_IDX];
        var name = nameIdx === -1 ? null : this._names._array[nameIdx];
        var origLine = buf[off + SLAB_ORIG_LINE];
        var origCol  = buf[off + SLAB_ORIG_COL];
        return {
          source: source,
          line:   origLine === -1 ? null : origLine,
          column: origCol  === -1 ? null : origCol,
          name:   name
        };
      }
    }

    return {
      source: null,
      line: null,
      column: null,
      name: null
    };
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
BasicSourceMapConsumer.prototype.hasContentsOfAllSources =
  function BasicSourceMapConsumer_hasContentsOfAllSources() {
    if (!this.sourcesContent) {
      return false;
    }
    return this.sourcesContent.length >= this._sources.size() &&
      !this.sourcesContent.some(function (sc) { return sc == null; });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
BasicSourceMapConsumer.prototype.sourceContentFor =
  function SourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    if (!this.sourcesContent) {
      return null;
    }

    var index = this._findSourceIndex(aSource);
    if (index >= 0) {
      return this.sourcesContent[index];
    }

    var relativeSource = aSource;
    if (this.sourceRoot != null) {
      relativeSource = util.relative(this.sourceRoot, relativeSource);
    }

    var url;
    if (this.sourceRoot != null
        && (url = util.urlParse(this.sourceRoot))) {
      // XXX: file:// URIs and absolute paths lead to unexpected behavior for
      // many users. We can help them out when they expect file:// URIs to
      // behave like it would if they were running a local HTTP server. See
      // https://bugzilla.mozilla.org/show_bug.cgi?id=885597.
      var fileUriAbsPath = relativeSource.replace(/^file:\/\//, "");
      if (url.scheme == "file"
          && this._sources.has(fileUriAbsPath)) {
        return this.sourcesContent[this._sources.indexOf(fileUriAbsPath)]
      }

      if ((!url.path || url.path == "/")
          && this._sources.has("/" + relativeSource)) {
        return this.sourcesContent[this._sources.indexOf("/" + relativeSource)];
      }
    }

    // This function is used recursively from
    // IndexedSourceMapConsumer.prototype.sourceContentFor. In that case, we
    // don't want to throw if we can't find the source - we just want to
    // return null, so we provide a flag to exit gracefully.
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + relativeSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number
 *     is 1-based.
 *   - column: The column number in the original source.  The column
 *     number is 0-based.
 *   - bias: Either 'SourceMapConsumer.GREATEST_LOWER_BOUND' or
 *     'SourceMapConsumer.LEAST_UPPER_BOUND'. Specifies whether to return the
 *     closest element that is smaller than or greater than the one we are
 *     searching for, respectively, if the exact element cannot be found.
 *     Defaults to 'SourceMapConsumer.GREATEST_LOWER_BOUND'.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the generated source, or null.
 *     The column number is 0-based.
 */
BasicSourceMapConsumer.prototype.generatedPositionFor =
  function SourceMapConsumer_generatedPositionFor(aArgs) {
    // Inline the `source` read — same megamorphic-call-site issue that hit
    // the line/column reads in PR #72. The hot path is a single property
    // access; the "is a required argument" throw is preserved but deferred
    // to the slow path: if the lookup fails AND the key is absent, throw.
    // Defined values (the hot path) never see the `in` check.
    var source = this._findSourceIndex(aArgs.source);
    if (source < 0) {
      if (!('source' in aArgs)) {
        throw new Error('"source" is a required argument.');
      }
      return {
        line: null,
        column: null,
        lastColumn: null
      };
    }

    // Inline the required-arg reads — same pattern as originalPositionFor.
    var needleLine = aArgs.line;
    var needleColumn = aArgs.column;
    if (typeof needleLine !== 'number') {
      throw new Error('"line" is a required argument.');
    }
    if (needleLine <= 0) {
      throw new TypeError('Line must be greater than or equal to 1, got ' + needleLine);
    }
    if (typeof needleColumn !== 'number') {
      throw new Error('"column" is a required argument.');
    }
    if (needleColumn < 0) {
      throw new TypeError('Column must be greater than or equal to 0, got ' + needleColumn);
    }
    var bias = aArgs.bias != null ? aArgs.bias : SourceMapConsumer.GREATEST_LOWER_BOUND;

    if (this._origBuf === null) {
      if (this._genBuf === null) {
        this._parseMappings(this._mappings, this.sourceRoot);
      }
      if (this._origBuf === null) {
        this._buildOriginalMappings();
      }
    }
    var buf = this._origBuf;
    var count = this._origCount;

    var index = -1;

    // Per-source warm-start cache: walks like `for (s of sources) gpf(s,L,C)`
    // hit cache on every iteration after the first. GLB only.
    if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND) {
      var cache = this._gpfBySrc;
      if (cache === null) {
        cache = this._gpfBySrc = new Int32Array(this._sources.size() * 3).fill(-1);
      }
      var slot = source * 3;
      var cachedLine = cache[slot];
      var cachedColumn = cache[slot + 1];

      if (cachedLine === needleLine && needleColumn >= cachedColumn) {
        if (needleColumn === cachedColumn) {
          index = cache[slot + 2];
        } else {
          var lo = cache[slot + 2];
          var hi = count;
          while (hi - lo > 1) {
            var mid = (lo + hi) >>> 1;
            var off = mid * SLAB_FIELDS;
            var cmp;
            if (buf[off + SLAB_SRC_IDX] !== source) cmp = buf[off + SLAB_SRC_IDX] - source;
            else if (buf[off + SLAB_ORIG_LINE] !== needleLine) cmp = buf[off + SLAB_ORIG_LINE] - needleLine;
            else cmp = buf[off + SLAB_ORIG_COL] - needleColumn;
            if (cmp <= 0) lo = mid;
            else hi = mid;
          }
          while (lo > 0) {
            var aOff = lo * SLAB_FIELDS;
            var bOff = (lo - 1) * SLAB_FIELDS;
            if (buf[aOff + SLAB_SRC_IDX]   !== buf[bOff + SLAB_SRC_IDX]   ||
                buf[aOff + SLAB_ORIG_LINE] !== buf[bOff + SLAB_ORIG_LINE] ||
                buf[aOff + SLAB_ORIG_COL]  !== buf[bOff + SLAB_ORIG_COL]) {
              break;
            }
            lo--;
          }
          index = lo;
        }
      }
    }

    if (index < 0) {
      if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND) {
        var lo = -1;
        var hi = count;
        while (hi - lo > 1) {
          var mid = (lo + hi) >>> 1;
          var off = mid * SLAB_FIELDS;
          var cmp;
          if (buf[off + SLAB_SRC_IDX] !== source) cmp = buf[off + SLAB_SRC_IDX] - source;
          else if (buf[off + SLAB_ORIG_LINE] !== needleLine) cmp = buf[off + SLAB_ORIG_LINE] - needleLine;
          else cmp = buf[off + SLAB_ORIG_COL] - needleColumn;
          if (cmp <= 0) lo = mid;
          else hi = mid;
        }
        if (lo >= 0) {
          while (lo > 0) {
            var aOff = lo * SLAB_FIELDS;
            var bOff = (lo - 1) * SLAB_FIELDS;
            if (buf[aOff + SLAB_SRC_IDX]   !== buf[bOff + SLAB_SRC_IDX]   ||
                buf[aOff + SLAB_ORIG_LINE] !== buf[bOff + SLAB_ORIG_LINE] ||
                buf[aOff + SLAB_ORIG_COL]  !== buf[bOff + SLAB_ORIG_COL]) {
              break;
            }
            lo--;
          }
          index = lo;
        }
      } else {
        // LUB cold path: smallest index with value >= needle, then rewind
        // through ties for smallest-equal.
        var lo = -1;
        var hi = count;
        while (hi - lo > 1) {
          var mid = (lo + hi) >>> 1;
          var off = mid * SLAB_FIELDS;
          var cmp;
          if (buf[off + SLAB_SRC_IDX] !== source) cmp = buf[off + SLAB_SRC_IDX] - source;
          else if (buf[off + SLAB_ORIG_LINE] !== needleLine) cmp = buf[off + SLAB_ORIG_LINE] - needleLine;
          else cmp = buf[off + SLAB_ORIG_COL] - needleColumn;
          if (cmp < 0) lo = mid;
          else hi = mid;
        }
        if (hi < count) {
          while (hi > 0) {
            var aOff = hi * SLAB_FIELDS;
            var bOff = (hi - 1) * SLAB_FIELDS;
            if (buf[aOff + SLAB_SRC_IDX]   !== buf[bOff + SLAB_SRC_IDX]   ||
                buf[aOff + SLAB_ORIG_LINE] !== buf[bOff + SLAB_ORIG_LINE] ||
                buf[aOff + SLAB_ORIG_COL]  !== buf[bOff + SLAB_ORIG_COL]) {
              break;
            }
            hi--;
          }
          index = hi;
        }
      }
    }

    if (index >= 0) {
      var off = index * SLAB_FIELDS;
      if (buf[off + SLAB_SRC_IDX] === source) {
        if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND &&
            buf[off + SLAB_ORIG_LINE] === needleLine) {
          var s = source * 3;
          this._gpfBySrc[s] = needleLine;
          this._gpfBySrc[s + 1] = needleColumn;
          this._gpfBySrc[s + 2] = index;
        }

        // lastGeneratedColumn is stored in the parallel _lastGenCols slab if
        // computeColumnSpans has been called; -1 sentinel means "extends to
        // end of line". The legacy API returned `null` for either-not-set, so
        // we mirror that.
        var lastCol = null;
        if (this._lastGenCols !== null) {
          // _origBuf rows reference back to _genBuf positions only by
          // (genLine, genCol). Look up the corresponding gen-slab index for
          // this slot via a small per-row map built alongside _lastGenCols.
          var lastIdx = this._origToGen !== null ? this._origToGen[index] : -1;
          if (lastIdx >= 0) {
            var v = this._lastGenCols[lastIdx];
            lastCol = v === -1 ? Infinity : v;
          }
        }
        return {
          line: buf[off + SLAB_GEN_LINE],
          column: buf[off + SLAB_GEN_COL],
          lastColumn: lastCol
        };
      }
    }

    return {
      line: null,
      column: null,
      lastColumn: null
    };
  };

exports.BasicSourceMapConsumer = BasicSourceMapConsumer;

/**
 * An IndexedSourceMapConsumer instance represents a parsed source map which
 * we can query for information. It differs from BasicSourceMapConsumer in
 * that it takes "indexed" source maps (i.e. ones with a "sections" field) as
 * input.
 *
 * The first parameter is a raw source map (either as a JSON string, or already
 * parsed to an object). According to the spec for indexed source maps, they
 * have the following attributes:
 *
 *   - version: Which version of the source map spec this map is following.
 *   - file: Optional. The generated file this source map is associated with.
 *   - sections: A list of section definitions.
 *
 * Each value under the "sections" field has two fields:
 *   - offset: The offset into the original specified at which this section
 *       begins to apply, defined as an object with a "line" and "column"
 *       field.
 *   - map: A source map definition. This source map could also be indexed,
 *       but doesn't have to be.
 *
 * Instead of the "map" field, it's also possible to have a "url" field
 * specifying a URL to retrieve a source map from, but that's currently
 * unsupported.
 *
 * Here's an example source map, taken from the source map spec[0], but
 * modified to omit a section which uses the "url" field.
 *
 *  {
 *    version : 3,
 *    file: "app.js",
 *    sections: [{
 *      offset: {line:100, column:10},
 *      map: {
 *        version : 3,
 *        file: "section.js",
 *        sources: ["foo.js", "bar.js"],
 *        names: ["src", "maps", "are", "fun"],
 *        mappings: "AAAA,E;;ABCDE;"
 *      }
 *    }],
 *  }
 *
 * The second parameter, if given, is a string whose value is the URL
 * at which the source map was found.  This URL is used to compute the
 * sources array.
 *
 * [0]: https://docs.google.com/document/d/1U1RGAehQwRypUTovF1KRlpiOFze0b-_2gc6fAH0KY0k/edit#heading=h.535es3xeprgt
 */
function IndexedSourceMapConsumer(aSourceMap, aSourceMapURL) {
  var sourceMap = aSourceMap;
  if (typeof aSourceMap === 'string') {
    sourceMap = util.parseSourceMapInput(aSourceMap);
  }

  var version = util.getArg(sourceMap, 'version');
  var sections = util.getArg(sourceMap, 'sections');

  if (version != this._version) {
    throw new Error('Unsupported version: ' + version);
  }

  this._sources = new ArraySet();
  this._names = new ArraySet();

  var lastOffset = {
    line: -1,
    column: 0
  };
  this._sections = sections.map(function (s) {
    if (s.url) {
      // The url field will require support for asynchronicity.
      // See https://github.com/mozilla/source-map/issues/16
      throw new Error('Support for url field in sections not implemented.');
    }
    var offset = util.getArg(s, 'offset');
    var offsetLine = util.getArg(offset, 'line');
    var offsetColumn = util.getArg(offset, 'column');

    if (offsetLine < lastOffset.line ||
        (offsetLine === lastOffset.line && offsetColumn < lastOffset.column)) {
      throw new Error('Section offsets must be ordered and non-overlapping.');
    }
    lastOffset = offset;

    return {
      generatedOffset: {
        // The offset fields are 0-based, but we use 1-based indices when
        // encoding/decoding from VLQ.
        generatedLine: offsetLine + 1,
        generatedColumn: offsetColumn + 1
      },
      consumer: new SourceMapConsumer(util.getArg(s, 'map'), aSourceMapURL)
    }
  });
}

IndexedSourceMapConsumer.prototype = Object.create(SourceMapConsumer.prototype);
IndexedSourceMapConsumer.prototype.constructor = SourceMapConsumer;

/**
 * The version of the source mapping spec that we are consuming.
 */
IndexedSourceMapConsumer.prototype._version = 3;

/**
 * The list of original sources.
 */
Object.defineProperty(IndexedSourceMapConsumer.prototype, 'sources', {
  get: function () {
    var sources = [];
    for (var i = 0; i < this._sections.length; i++) {
      for (var j = 0; j < this._sections[i].consumer.sources.length; j++) {
        sources.push(this._sections[i].consumer.sources[j]);
      }
    }
    return sources;
  }
});

/**
 * Returns the original source, line, and column information for the generated
 * source's line and column positions provided. The only argument is an object
 * with the following properties:
 *
 *   - line: The line number in the generated source.  The line number
 *     is 1-based.
 *   - column: The column number in the generated source.  The column
 *     number is 0-based.
 *
 * and an object is returned with the following properties:
 *
 *   - source: The original source file, or null.
 *   - line: The line number in the original source, or null.  The
 *     line number is 1-based.
 *   - column: The column number in the original source, or null.  The
 *     column number is 0-based.
 *   - name: The original identifier, or null.
 */
IndexedSourceMapConsumer.prototype.originalPositionFor =
  function IndexedSourceMapConsumer_originalPositionFor(aArgs) {
    var needle = {
      generatedLine: util.getArg(aArgs, 'line'),
      generatedColumn: util.getArg(aArgs, 'column')
    };

    // Find the section containing the generated position we're trying to map
    // to an original position.
    var sectionIndex = binarySearch.search(needle, this._sections,
      function(needle, section) {
        var cmp = needle.generatedLine - section.generatedOffset.generatedLine;
        if (cmp) {
          return cmp;
        }

        return (needle.generatedColumn -
                section.generatedOffset.generatedColumn);
      });
    var section = this._sections[sectionIndex];

    if (!section) {
      return {
        source: null,
        line: null,
        column: null,
        name: null
      };
    }

    return section.consumer.originalPositionFor({
      line: needle.generatedLine -
        (section.generatedOffset.generatedLine - 1),
      column: needle.generatedColumn -
        (section.generatedOffset.generatedLine === needle.generatedLine
         ? section.generatedOffset.generatedColumn - 1
         : 0),
      bias: aArgs.bias
    });
  };

/**
 * Return true if we have the source content for every source in the source
 * map, false otherwise.
 */
IndexedSourceMapConsumer.prototype.hasContentsOfAllSources =
  function IndexedSourceMapConsumer_hasContentsOfAllSources() {
    return this._sections.every(function (s) {
      return s.consumer.hasContentsOfAllSources();
    });
  };

/**
 * Returns the original source content. The only argument is the url of the
 * original source file. Returns null if no original source content is
 * available.
 */
IndexedSourceMapConsumer.prototype.sourceContentFor =
  function IndexedSourceMapConsumer_sourceContentFor(aSource, nullOnMissing) {
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      var content = section.consumer.sourceContentFor(aSource, true);
      if (content || content === '') {
        return content;
      }
    }
    if (nullOnMissing) {
      return null;
    }
    else {
      throw new Error('"' + aSource + '" is not in the SourceMap.');
    }
  };

/**
 * Returns the generated line and column information for the original source,
 * line, and column positions provided. The only argument is an object with
 * the following properties:
 *
 *   - source: The filename of the original source.
 *   - line: The line number in the original source.  The line number
 *     is 1-based.
 *   - column: The column number in the original source.  The column
 *     number is 0-based.
 *
 * and an object is returned with the following properties:
 *
 *   - line: The line number in the generated source, or null.  The
 *     line number is 1-based. 
 *   - column: The column number in the generated source, or null.
 *     The column number is 0-based.
 */
IndexedSourceMapConsumer.prototype.generatedPositionFor =
  function IndexedSourceMapConsumer_generatedPositionFor(aArgs) {
    // Hoist the source read out of the per-section loop — used to be one
    // util.getArg call per section iteration.
    var argSource = util.getArg(aArgs, 'source');
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];

      // Only consider this section if the requested source is in the list of
      // sources of the consumer.
      if (section.consumer._findSourceIndex(argSource) === -1) {
        continue;
      }
      var generatedPosition = section.consumer.generatedPositionFor(aArgs);
      if (generatedPosition) {
        var ret = {
          line: generatedPosition.line +
            (section.generatedOffset.generatedLine - 1),
          column: generatedPosition.column +
            (section.generatedOffset.generatedLine === generatedPosition.line
             ? section.generatedOffset.generatedColumn - 1
             : 0)
        };
        return ret;
      }
    }

    return {
      line: null,
      column: null
    };
  };

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */
IndexedSourceMapConsumer.prototype._parseMappings =
  function IndexedSourceMapConsumer_parseMappings(aStr, aSourceRoot) {
    // Pre-sum section mapping counts so we can size the merged _genBuf
    // exactly. Triggers each section's lazy parse if it hasn't run yet.
    var totalCount = 0;
    for (var i = 0; i < this._sections.length; i++) {
      var sc = this._sections[i].consumer;
      if (sc._genBuf === null) {
        sc._parseMappings(sc._mappings, sc.sourceRoot);
      }
      totalCount += sc._genCount;
    }

    var genBuf = new Int32Array(totalCount * SLAB_FIELDS);
    var count = 0;
    var sourcesSet = this._sources;
    var namesSet = this._names;

    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];
      var sc = section.consumer;
      var sectionGenLine = section.generatedOffset.generatedLine;
      var lineOffset = sectionGenLine - 1;
      var colOffset = section.generatedOffset.generatedColumn - 1;
      var scBuf = sc._genBuf;
      var scCount = sc._genCount;
      // `sc._absoluteSources[i]` is the absolute URL the section's source at
      // index i resolves to under the indexed map's `_sourceMapURL`
      // (BasicSourceMapConsumer's constructor and IndexedSourceMapConsumer's
      // _parseMappings both compute through `computeSourceURL` with the
      // outer URL). Reading the precomputed value here saves a per-mapping
      // URL parse + resolve, matching the eachMapping fast path.
      var scAbsSources = sc._absoluteSources;
      var scNameArray = sc._names._array;

      for (var j = 0; j < scCount; j++) {
        var off = j * SLAB_FIELDS;
        var scSrcIdx = scBuf[off + SLAB_SRC_IDX];
        var ourSrcIdx;
        if (scSrcIdx === -1) {
          ourSrcIdx = sourcesSet.add(null);
        } else {
          ourSrcIdx = sourcesSet.add(scAbsSources[scSrcIdx]);
        }
        var scNameIdx = scBuf[off + SLAB_NAME_IDX];
        var ourNameIdx = scNameIdx === -1
          ? -1
          : namesSet.add(scNameArray[scNameIdx]);

        var scGenLine = scBuf[off + SLAB_GEN_LINE];
        var adjGenLine = scGenLine + lineOffset;
        var adjGenCol = scBuf[off + SLAB_GEN_COL] +
          (sectionGenLine === scGenLine ? colOffset : 0);

        var dstOff = count * SLAB_FIELDS;
        genBuf[dstOff + SLAB_GEN_LINE]  = adjGenLine;
        genBuf[dstOff + SLAB_GEN_COL]   = adjGenCol;
        genBuf[dstOff + SLAB_SRC_IDX]   = ourSrcIdx;
        genBuf[dstOff + SLAB_ORIG_LINE] = scBuf[off + SLAB_ORIG_LINE];
        genBuf[dstOff + SLAB_ORIG_COL]  = scBuf[off + SLAB_ORIG_COL];
        genBuf[dstOff + SLAB_NAME_IDX]  = ourNameIdx;
        count++;
      }
    }

    // _sources holds absolute URLs after the section-merge above, so the
    // absolute view is just the ArraySet's toArray — same shape as
    // BasicSourceMapConsumer's constructor populates.
    this._absoluteSources = this._sources.toArray();

    // Sort merged rows by (generatedLine, generatedColumn). Sections may
    // overlap each other, so a single global sort is required (per-line
    // sortGeneratedSlab won't do). Use a permutation array to avoid 6×count
    // row swaps; quicksort over the perm is a few seconds even for vscode.
    if (count > 1) {
      var perm = new Array(count);
      for (var p = 0; p < count; p++) perm[p] = p;
      perm.sort(function (a, b) {
        var aOff = a * SLAB_FIELDS;
        var bOff = b * SLAB_FIELDS;
        var d = genBuf[aOff + SLAB_GEN_LINE] - genBuf[bOff + SLAB_GEN_LINE];
        if (d !== 0) return d;
        return genBuf[aOff + SLAB_GEN_COL] - genBuf[bOff + SLAB_GEN_COL];
      });
      var sorted = new Int32Array(count * SLAB_FIELDS);
      for (var k = 0; k < count; k++) {
        var srcOff = perm[k] * SLAB_FIELDS;
        var dstOff = k * SLAB_FIELDS;
        sorted[dstOff + SLAB_GEN_LINE]  = genBuf[srcOff + SLAB_GEN_LINE];
        sorted[dstOff + SLAB_GEN_COL]   = genBuf[srcOff + SLAB_GEN_COL];
        sorted[dstOff + SLAB_SRC_IDX]   = genBuf[srcOff + SLAB_SRC_IDX];
        sorted[dstOff + SLAB_ORIG_LINE] = genBuf[srcOff + SLAB_ORIG_LINE];
        sorted[dstOff + SLAB_ORIG_COL]  = genBuf[srcOff + SLAB_ORIG_COL];
        sorted[dstOff + SLAB_NAME_IDX]  = genBuf[srcOff + SLAB_NAME_IDX];
      }
      genBuf = sorted;
    }

    this._genBuf = genBuf;
    this._genCount = count;

    // Build _origBuf from the now-populated _genBuf via the shared method.
    BasicSourceMapConsumer.prototype._buildOriginalMappings.call(this);
  };

exports.IndexedSourceMapConsumer = IndexedSourceMapConsumer;
