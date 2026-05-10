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
var quickSort = require('./quick-sort').quickSort;
var mappingListModule = require('./mapping-list');
var ML_FIELDS = mappingListModule.FIELDS_PER_MAPPING;
var ML_F_GEN_LINE  = mappingListModule.F_GEN_LINE;
var ML_F_GEN_COL   = mappingListModule.F_GEN_COL;
var ML_F_SRC_IDX   = mappingListModule.F_SRC_IDX;
var ML_F_ORIG_LINE = mappingListModule.F_ORIG_LINE;
var ML_F_ORIG_COL  = mappingListModule.F_ORIG_COL;
var ML_F_NAME_IDX  = mappingListModule.F_NAME_IDX;

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

// `__generatedMappings` and `__originalMappings` are arrays that hold the
// parsed mapping coordinates from the source map's "mappings" attribute. They
// are lazily instantiated, accessed via the `_generatedMappings` and
// `_originalMappings` getters respectively, and we only parse the mappings
// and create these arrays once queried for a source location. We jump through
// these hoops because there can be many thousands of mappings, and parsing
// them is expensive, so we only want to do it if we must.
//
// Each object in the arrays is of the form:
//
//     {
//       generatedLine: The line number in the generated code,
//       generatedColumn: The column number in the generated code,
//       source: The path to the original source file that generated this
//               chunk of code,
//       originalLine: The line number in the original source that
//                     corresponds to this chunk of generated code,
//       originalColumn: The column number in the original source that
//                       corresponds to this chunk of generated code,
//       name: The name of the original symbol which generated this chunk of
//             code.
//     }
//
// All properties except for `generatedLine` and `generatedColumn` can be
// `null`.
//
// `_generatedMappings` is ordered by the generated positions.
//
// `_originalMappings` is ordered by the original positions.

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

SourceMapConsumer.prototype.__generatedMappings = null;
Object.defineProperty(SourceMapConsumer.prototype, '_generatedMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (!this.__generatedMappings) {
      this._parseMappings(this._mappings, this.sourceRoot);
    }

    return this.__generatedMappings;
  }
});

SourceMapConsumer.prototype.__originalMappings = null;
Object.defineProperty(SourceMapConsumer.prototype, '_originalMappings', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (!this.__originalMappings) {
      // Ensure generatedMappings are parsed first (may also set __originalMappings for IndexedSourceMapConsumer)
      var generatedMappings = this._generatedMappings;
      // Build originalMappings lazily if not already set (BasicSourceMapConsumer)
      if (!this.__originalMappings) {
        this._buildOriginalMappings();
      }
    }

    return this.__originalMappings;
  }
});

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

    var boundCallback = aCallback.bind(context);
    var names = this._names;
    // `_absoluteSources` is precomputed in both consumer constructors as
    // `computeSourceURL(sourceRoot, _sources.at(i), sourceMapURL)`, so a
    // direct index skips the per-call URL parse + resolve. Same memoization
    // pattern used by `originalPositionFor` (PR #49).
    var absoluteSources = this._absoluteSources;

    for (var i = 0, n = mappings.length; i < n; i++) {
      var mapping = mappings[i];
      boundCallback({
        source: mapping.source === null ? null : absoluteSources[mapping.source],
        generatedLine: mapping.generatedLine,
        generatedColumn: mapping.generatedColumn,
        originalLine: mapping.originalLine,
        originalColumn: mapping.originalColumn,
        name: mapping.name === null ? null : names.at(mapping.name)
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

    // When there is no exact match, BasicSourceMapConsumer.prototype._findMapping
    // returns the index of the closest mapping less than the needle. By
    // setting needle.originalColumn to 0, we thus find the last mapping for
    // the given line, provided such a mapping exists.
    var needle = {
      source: util.getArg(aArgs, 'source'),
      originalLine: line,
      // `column` is optional, defaulted to 0. Inline the optional read.
      originalColumn: aArgs.column != null ? aArgs.column : 0
    };

    needle.source = this._findSourceIndex(needle.source);
    if (needle.source < 0) {
      return [];
    }

    var mappings = [];

    var index = this._findMapping(needle,
                                  this._originalMappings,
                                  "originalLine",
                                  "originalColumn",
                                  util.compareByOriginalPositions,
                                  binarySearch.LEAST_UPPER_BOUND);
    if (index >= 0) {
      var mapping = this._originalMappings[index];

      if (aArgs.column === undefined) {
        var originalLine = mapping.originalLine;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we found. Since
        // mappings are sorted, this is guaranteed to find all mappings for
        // the line we found.
        while (mapping && mapping.originalLine === originalLine) {
          mappings.push({
            line: mapping.generatedLine,
            column: mapping.generatedColumn,
            lastColumn: mapping.lastGeneratedColumn != null ? mapping.lastGeneratedColumn : null
          });

          mapping = this._originalMappings[++index];
        }
      } else {
        var originalColumn = mapping.originalColumn;

        // Iterate until either we run out of mappings, or we run into
        // a mapping for a different line than the one we were searching for.
        // Since mappings are sorted, this is guaranteed to find all mappings for
        // the line we are searching for.
        while (mapping &&
               mapping.originalLine === line &&
               mapping.originalColumn == originalColumn) {
          mappings.push({
            line: mapping.generatedLine,
            column: mapping.generatedColumn,
            lastColumn: mapping.lastGeneratedColumn != null ? mapping.lastGeneratedColumn : null
          });

          mapping = this._originalMappings[++index];
        }
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
  // requires the array) to play nice here.
  var names = util.getArg(sourceMap, 'names', []);
  var sourceRoot = util.getArg(sourceMap, 'sourceRoot', null);
  var sourcesContent = util.getArg(sourceMap, 'sourcesContent', null);
  var mappings = util.getArg(sourceMap, 'mappings');
  var file = util.getArg(sourceMap, 'file', null);

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

    // Read the generator's MappingList slab directly. The slab already
    // stores source/name as integer indices into aSourceMap._sources /
    // _names, and our smc._sources / smc._names were initialized from the
    // same toArray() above — so the indices are identical and no `indexOf`
    // is needed per mapping.
    var ml = aSourceMap._mappings;
    if (!ml._sorted) {
      ml._sort();
      ml._sorted = true;
    }
    var mlBuf = ml._buf;
    var mlCount = ml._count;
    var destGeneratedMappings = smc.__generatedMappings = new Array(mlCount);
    // Bucket original-side mappings by source index — same pattern as
    // _buildOriginalMappings and IndexedSourceMapConsumer._parseMappings —
    // so the per-bucket sort can use compareByOriginalPositionsNoSource and
    // skip the function-call strcmp(source, source) primary key.
    var originalBuckets = [];

    for (var i = 0; i < mlCount; i++) {
      var mlOff = i * ML_FIELDS;
      var destMapping = new Mapping;
      destMapping.generatedLine = mlBuf[mlOff + ML_F_GEN_LINE];
      destMapping.generatedColumn = mlBuf[mlOff + ML_F_GEN_COL];

      var srcIdx = mlBuf[mlOff + ML_F_SRC_IDX];
      if (srcIdx !== -1) {
        destMapping.source = srcIdx;
        destMapping.originalLine = mlBuf[mlOff + ML_F_ORIG_LINE];
        destMapping.originalColumn = mlBuf[mlOff + ML_F_ORIG_COL];

        var nameIdx = mlBuf[mlOff + ML_F_NAME_IDX];
        if (nameIdx !== -1) {
          destMapping.name = nameIdx;
        }

        while (originalBuckets.length <= srcIdx) {
          originalBuckets.push(null);
        }
        if (originalBuckets[srcIdx] === null) {
          originalBuckets[srcIdx] = [];
        }
        originalBuckets[srcIdx].push(destMapping);
      }

      destGeneratedMappings[i] = destMapping;
    }

    var nonNullBuckets = [];
    var compareOriginal = util.compareByOriginalPositionsNoSource;
    for (var b = 0; b < originalBuckets.length; b++) {
      var perSource = originalBuckets[b];
      if (perSource != null) {
        // Well-formed input usually emits per-source mappings already in
        // original-position order — probe and skip the sort when it is.
        var sorted = true;
        for (var k = 1; k < perSource.length; k++) {
          if (compareOriginal(perSource[k - 1], perSource[k]) > 0) {
            sorted = false;
            break;
          }
        }
        if (!sorted) {
          quickSort(perSource, compareOriginal);
        }
        nonNullBuckets.push(perSource);
      }
    }
    smc.__originalMappings = [].concat(...nonNullBuckets);

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
 * Provide the JIT with a nice shape / hidden class.
 */
function Mapping() {
  this.generatedLine = 0;
  this.generatedColumn = 0;
  this.source = null;
  this.originalLine = null;
  this.originalColumn = null;
  this.name = null;
}

/**
 * Parse the mappings in a string in to a data structure which we can easily
 * query (the ordered arrays in the `this.__generatedMappings` and
 * `this.__originalMappings` properties).
 */

const compareGenerated = util.compareByGeneratedPositionsDeflatedNoLine;
function sortGenerated(array, start) {
  let l = array.length;
  let n = array.length - start;
  if (n <= 1) {
    return;
  }

  // Check if already sorted (common case for well-formed source maps)
  let sorted = true;
  for (let i = start + 1; i < l; i++) {
    if (compareGenerated(array[i - 1], array[i]) > 0) {
      sorted = false;
      break;
    }
  }
  if (sorted) {
    return;
  }

  if (n == 2) {
    // Already checked above, must be out of order
    let a = array[start];
    array[start] = array[start + 1];
    array[start + 1] = a;
  } else if (n < 20) {
    for (let i = start; i < l; i++) {
      for (let j = i; j > start; j--) {
        let a = array[j - 1];
        let b = array[j];
        if (compareGenerated(a, b) <= 0) {
          break;
        }
        array[j - 1] = b;
        array[j] = a;
      }
    }
  } else {
    quickSort(array, compareGenerated, start);
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
    var generatedMappings = [];
    var mapping, value, charCode;
    // Reuse segment array to avoid allocations per mapping
    var segment = [0, 0, 0, 0, 0];
    var segmentLength = 0;

    let subarrayStart = 0;
    while (index < length) {
      charCode = aStr.charCodeAt(index);
      if (charCode === 59) { // ';'
        generatedLine++;
        index++;
        previousGeneratedColumn = 0;

        sortGenerated(generatedMappings, subarrayStart);
        subarrayStart = generatedMappings.length;
      }
      else if (charCode === 44) { // ','
        index++;
      }
      else {
        mapping = {
          generatedLine: generatedLine,
          generatedColumn: 0,
          source: null,
          originalLine: null,
          originalColumn: null,
          name: null
        };

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

        // Generated column.
        mapping.generatedColumn = previousGeneratedColumn + segment[0];
        previousGeneratedColumn = mapping.generatedColumn;

        if (segmentLength > 1) {
          // Original source.
          mapping.source = previousSource + segment[1];
          previousSource += segment[1];

          // Original line.
          mapping.originalLine = previousOriginalLine + segment[2];
          previousOriginalLine = mapping.originalLine;
          // Lines are stored 0-based
          mapping.originalLine += 1;

          // Original column.
          mapping.originalColumn = previousOriginalColumn + segment[3];
          previousOriginalColumn = mapping.originalColumn;

          if (segmentLength > 4) {
            // Original name.
            mapping.name = previousName + segment[4];
            previousName += segment[4];
          }
        }

        generatedMappings.push(mapping);
      }
    }

    sortGenerated(generatedMappings, subarrayStart);
    this.__generatedMappings = generatedMappings;
  };

/**
 * Build originalMappings lazily from generatedMappings.
 */
BasicSourceMapConsumer.prototype._buildOriginalMappings =
  function SourceMapConsumer_buildOriginalMappings() {
    var generatedMappings = this.__generatedMappings;
    var originalMappings = [];

    for (var i = 0; i < generatedMappings.length; i++) {
      var mapping = generatedMappings[i];
      if (typeof mapping.originalLine === 'number') {
        var currentSource = mapping.source;
        while (originalMappings.length <= currentSource) {
          originalMappings.push(null);
        }
        if (originalMappings[currentSource] === null) {
          originalMappings[currentSource] = [];
        }
        originalMappings[currentSource].push(mapping);
      }
    }

    var nonNullOriginalMappings = [];
    var compareOriginal = util.compareByOriginalPositionsNoSource;
    for (var i = 0; i < originalMappings.length; i++) {
      var perSource = originalMappings[i];
      if (perSource != null) {
        // Well-formed source maps emit segments in original-position order
        // within each source, so the per-source array is usually already
        // sorted. Probe with one O(N) pass and skip the quickSort when it
        // is. Same shape as the sortGenerated skip-sorted check.
        var sorted = true;
        for (var j = 1; j < perSource.length; j++) {
          if (compareOriginal(perSource[j - 1], perSource[j]) > 0) {
            sorted = false;
            break;
          }
        }
        if (!sorted) {
          quickSort(perSource, compareOriginal);
        }
        nonNullOriginalMappings.push(perSource);
      }
    }
    this.__originalMappings = [].concat(...nonNullOriginalMappings);
  };

/**
 * Find the mapping that best matches the hypothetical "needle" mapping that
 * we are searching for in the given "haystack" of mappings.
 */
BasicSourceMapConsumer.prototype._findMapping =
  function SourceMapConsumer_findMapping(aNeedle, aMappings, aLineName,
                                         aColumnName, aComparator, aBias) {
    // To return the position we are searching for, we must first find the
    // mapping for the given position and then return the opposite position it
    // points to. Because the mappings are sorted, we can use binary search to
    // find the best mapping.

    if (aNeedle[aLineName] <= 0) {
      throw new TypeError('Line must be greater than or equal to 1, got '
                          + aNeedle[aLineName]);
    }
    if (aNeedle[aColumnName] < 0) {
      throw new TypeError('Column must be greater than or equal to 0, got '
                          + aNeedle[aColumnName]);
    }

    return binarySearch.search(aNeedle, aMappings, aComparator, aBias);
  };

/**
 * Compute the last column for each generated mapping. The last column is
 * inclusive.
 */
BasicSourceMapConsumer.prototype.computeColumnSpans =
  function SourceMapConsumer_computeColumnSpans() {
    for (var index = 0; index < this._generatedMappings.length; ++index) {
      var mapping = this._generatedMappings[index];

      // Mappings do not contain a field for the last generated columnt. We
      // can come up with an optimistic estimate, however, by assuming that
      // mappings are contiguous (i.e. given two consecutive mappings, the
      // first mapping ends where the second one starts).
      if (index + 1 < this._generatedMappings.length) {
        var nextMapping = this._generatedMappings[index + 1];

        if (mapping.generatedLine === nextMapping.generatedLine) {
          mapping.lastGeneratedColumn = nextMapping.generatedColumn - 1;
          continue;
        }
      }

      // The last mapping for each line spans the entire line.
      mapping.lastGeneratedColumn = Infinity;
    }
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
    var needleLine = util.getArg(aArgs, 'line');
    var needleColumn = util.getArg(aArgs, 'column');
    // `bias` is optional, defaulted to GLB. Inline the optional read — every
    // trace call paid for the getArg function-call overhead.
    var bias = aArgs.bias != null ? aArgs.bias : SourceMapConsumer.GREATEST_LOWER_BOUND;
    var mappings = this._generatedMappings;

    var index = -1;

    // Warm-start cache: ascending-column traces (the bundler walk pattern)
    // repeatedly query the same line with growing columns. When the cache
    // applies, run a bounded inline binary search on [cachedIndex, len)
    // instead of the full haystack. binarySearch.search itself is left
    // untouched so its V8 optimization profile is preserved on every other
    // call site. Only used for GLB bias.
    if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND &&
        this._opfLine === needleLine &&
        needleColumn >= this._opfColumn) {
      // Cache invariant: mappings[_opfIndex] <= the previous needle on this
      // line, so it is also <= the new needle (column has not decreased).
      // GLB lies in [_opfIndex, len). Iterative bisect with inclusive lo.
      var lo = this._opfIndex;
      var hi = mappings.length;
      while (hi - lo > 1) {
        var mid = (lo + hi) >>> 1;
        var m = mappings[mid];
        var cmp = m.generatedLine - needleLine;
        if (cmp === 0) cmp = m.generatedColumn - needleColumn;
        if (cmp <= 0) lo = mid;
        else hi = mid;
      }
      // Rewind through any tie cluster to match binarySearch's
      // smallest-equal semantics.
      while (lo > 0) {
        var cur = mappings[lo];
        var prev = mappings[lo - 1];
        if (prev.generatedLine !== cur.generatedLine ||
            prev.generatedColumn !== cur.generatedColumn) {
          break;
        }
        lo--;
      }
      index = lo;
    }

    if (index < 0) {
      var needle = {
        generatedLine: needleLine,
        generatedColumn: needleColumn
      };
      index = this._findMapping(
        needle,
        mappings,
        "generatedLine",
        "generatedColumn",
        util.compareByGeneratedPositionsDeflated,
        bias
      );
    }

    if (index >= 0) {
      var mapping = mappings[index];

      if (mapping.generatedLine === needleLine) {
        // Update cache only when GLB found a mapping on the queried line —
        // the case where a follow-up ascending query can short-circuit.
        if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND) {
          this._opfLine = needleLine;
          this._opfColumn = needleColumn;
          this._opfIndex = index;
        }

        // _parseMappings always sets `source`, `name`, `originalLine`, and
        // `originalColumn` — null when unset, integer index otherwise — so a
        // direct property read is correct and skips the getArg `in` check.
        var source = mapping.source;
        if (source !== null) {
          // _absoluteSources is precomputed at construction time as
          // computeSourceURL(sourceRoot, _sources.at(i), sourceMapURL) for
          // each i. Indexing into it skips the per-call URL parse + resolve.
          source = this._absoluteSources[source];
        }
        var name = mapping.name;
        if (name !== null) {
          name = this._names.at(name);
        }
        return {
          source: source,
          line: mapping.originalLine,
          column: mapping.originalColumn,
          name: name
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
    var source = util.getArg(aArgs, 'source');
    source = this._findSourceIndex(source);
    if (source < 0) {
      return {
        line: null,
        column: null,
        lastColumn: null
      };
    }

    var needleLine = util.getArg(aArgs, 'line');
    var needleColumn = util.getArg(aArgs, 'column');
    // `bias` is optional, defaulted to GLB. Inline the optional read.
    var bias = aArgs.bias != null ? aArgs.bias : SourceMapConsumer.GREATEST_LOWER_BOUND;
    var mappings = this._originalMappings;

    var index = -1;

    // Per-source warm-start cache: walks like `for (s of sources) gpf(s,L,C)`
    // hit cache on every iteration after the first. On a hit we run a bounded
    // inline binary search on [cachedIdx, len) instead of touching the full
    // haystack. binarySearch.search itself is left untouched so its V8
    // optimization profile is preserved on every other call site. GLB only.
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
          // Exact-match fast path: same (source, line, col) as the previous
          // cached query, so the smallest-equal GLB index is unchanged. The
          // common case for `for (s of sources) gpf(s, L, C)` walks where C
          // is fixed.
          index = cache[slot + 2];
        } else {
          // Cache invariant: mappings[cachedIdx] is the smallest-equal GLB
          // result of the previous query on this (source, line). Since the
          // new needle is > the previous needle (column strictly greater),
          // GLB lies in [cachedIdx, len).
          var lo = cache[slot + 2];
          var hi = mappings.length;
          while (hi - lo > 1) {
            var mid = (lo + hi) >>> 1;
            var m = mappings[mid];
            var cmp;
            if (m.source !== source) cmp = m.source - source;
            else if (m.originalLine !== needleLine) cmp = m.originalLine - needleLine;
            else cmp = m.originalColumn - needleColumn;
            if (cmp <= 0) lo = mid;
            else hi = mid;
          }
          // Rewind through any tie cluster to match binarySearch's
          // smallest-equal semantics.
          while (lo > 0) {
            var cur = mappings[lo];
            var prev = mappings[lo - 1];
            if (prev.source !== cur.source ||
                prev.originalLine !== cur.originalLine ||
                prev.originalColumn !== cur.originalColumn) {
              break;
            }
            lo--;
          }
          index = lo;
        }
      }
    }

    if (index < 0) {
      var needle = {
        source: source,
        originalLine: needleLine,
        originalColumn: needleColumn
      };
      index = this._findMapping(
        needle,
        mappings,
        "originalLine",
        "originalColumn",
        util.compareByOriginalPositions,
        bias
      );
    }

    if (index >= 0) {
      var mapping = mappings[index];

      if (mapping.source === source) {
        // Update cache only when GLB found a mapping on the queried
        // (source, line) — the case where a follow-up ascending query can
        // short-circuit.
        if (bias === SourceMapConsumer.GREATEST_LOWER_BOUND &&
            mapping.originalLine === needleLine) {
          var s = source * 3;
          this._gpfBySrc[s] = needleLine;
          this._gpfBySrc[s + 1] = needleColumn;
          this._gpfBySrc[s + 2] = index;
        }

        // generatedLine and generatedColumn are always set by _parseMappings;
        // lastGeneratedColumn is added optionally by computeColumnSpans, so a
        // direct read with a null fallback covers both the missing and
        // explicitly-null cases the same way getArg(...,'<f>',null) did.
        return {
          line: mapping.generatedLine,
          column: mapping.generatedColumn,
          lastColumn: mapping.lastGeneratedColumn != null ? mapping.lastGeneratedColumn : null
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
    this.__generatedMappings = [];
    // Bucket original-side mappings by source index. Sorting per bucket with
    // `compareByOriginalPositionsNoSource` avoids the `strcmp(source, source)`
    // primary key on every comparison — same pattern as
    // BasicSourceMapConsumer._buildOriginalMappings.
    var originalBuckets = [];
    for (var i = 0; i < this._sections.length; i++) {
      var section = this._sections[i];
      var sectionMappings = section.consumer._generatedMappings;
      for (var j = 0; j < sectionMappings.length; j++) {
        var mapping = sectionMappings[j];

        var source = section.consumer._sources.at(mapping.source);
        if(source !== null) {
          source = util.computeSourceURL(section.consumer.sourceRoot, source, this._sourceMapURL);
        }
        source = this._sources.add(source);

        var name = null;
        if (mapping.name) {
          name = this._names.add(section.consumer._names.at(mapping.name));
        }

        // The mappings coming from the consumer for the section have
        // generated positions relative to the start of the section, so we
        // need to offset them to be relative to the start of the concatenated
        // generated file.
        var adjustedMapping = {
          source: source,
          generatedLine: mapping.generatedLine +
            (section.generatedOffset.generatedLine - 1),
          generatedColumn: mapping.generatedColumn +
            (section.generatedOffset.generatedLine === mapping.generatedLine
            ? section.generatedOffset.generatedColumn - 1
            : 0),
          originalLine: mapping.originalLine,
          originalColumn: mapping.originalColumn,
          name: name
        };

        this.__generatedMappings.push(adjustedMapping);
        if (typeof adjustedMapping.originalLine === 'number') {
          while (originalBuckets.length <= source) {
            originalBuckets.push(null);
          }
          if (originalBuckets[source] === null) {
            originalBuckets[source] = [];
          }
          originalBuckets[source].push(adjustedMapping);
        }
      }
    }

    // `_sources` is populated with already-absolute URLs (lines above resolve
    // each section's source through `computeSourceURL`), so the absolute view
    // is simply the ArraySet's toArray. Mirroring the field that
    // BasicSourceMapConsumer sets in its constructor lets `eachMapping` index
    // into `_absoluteSources` uniformly across consumer types.
    this._absoluteSources = this._sources.toArray();

    quickSort(this.__generatedMappings, util.compareByGeneratedPositionsDeflated);

    var nonNullBuckets = [];
    var compareOriginal = util.compareByOriginalPositionsNoSource;
    for (var k = 0; k < originalBuckets.length; k++) {
      var perSource = originalBuckets[k];
      if (perSource != null) {
        // Well-formed input usually emits per-source mappings already in
        // original-position order — probe and skip the sort when it is.
        var sorted = true;
        for (var m = 1; m < perSource.length; m++) {
          if (compareOriginal(perSource[m - 1], perSource[m]) > 0) {
            sorted = false;
            break;
          }
        }
        if (!sorted) {
          quickSort(perSource, compareOriginal);
        }
        nonNullBuckets.push(perSource);
      }
    }
    this.__originalMappings = [].concat(...nonNullBuckets);
  };

exports.IndexedSourceMapConsumer = IndexedSourceMapConsumer;
