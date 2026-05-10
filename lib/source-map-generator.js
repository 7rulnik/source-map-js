/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var base64VLQ = require('./base64-vlq');
var util = require('./util');
var ArraySet = require('./array-set').ArraySet;
var mappingListModule = require('./mapping-list');
var MappingList = mappingListModule.MappingList;
var FIELDS_PER_MAPPING = mappingListModule.FIELDS_PER_MAPPING;
var F_GEN_LINE  = mappingListModule.F_GEN_LINE;
var F_GEN_COL   = mappingListModule.F_GEN_COL;
var F_SRC_IDX   = mappingListModule.F_SRC_IDX;
var F_ORIG_LINE = mappingListModule.F_ORIG_LINE;
var F_ORIG_COL  = mappingListModule.F_ORIG_COL;
var F_NAME_IDX  = mappingListModule.F_NAME_IDX;

/**
 * An instance of the SourceMapGenerator represents a source map which is
 * being built incrementally. You may pass an object with the following
 * properties:
 *
 *   - file: The filename of the generated source.
 *   - sourceRoot: A root for all relative URLs in this source map.
 */
function SourceMapGenerator(aArgs) {
  if (!aArgs) {
    aArgs = {};
  }
  // Inlined getArg with default — see #59 for the pattern. All four fields are
  // optional with documented defaults.
  this._file = aArgs.file != null ? aArgs.file : null;
  this._sourceRoot = aArgs.sourceRoot != null ? aArgs.sourceRoot : null;
  this._skipValidation = aArgs.skipValidation != null ? aArgs.skipValidation : false;
  this._ignoreInvalidMapping = aArgs.ignoreInvalidMapping != null ? aArgs.ignoreInvalidMapping : false;
  this._sources = new ArraySet();
  this._names = new ArraySet();
  this._mappings = new MappingList(this._sources, this._names);
  this._sourcesContents = null;
}

SourceMapGenerator.prototype._version = 3;

/**
 * Creates a new SourceMapGenerator based on a SourceMapConsumer
 *
 * @param aSourceMapConsumer The SourceMap.
 */
SourceMapGenerator.fromSourceMap =
  function SourceMapGenerator_fromSourceMap(aSourceMapConsumer, generatorOps) {
    var sourceRoot = aSourceMapConsumer.sourceRoot;
    var generator = new SourceMapGenerator(Object.assign(generatorOps || {}, {
      file: aSourceMapConsumer.file,
      sourceRoot: sourceRoot
    }));
    aSourceMapConsumer.eachMapping(function (mapping) {
      var newMapping = {
        generated: {
          line: mapping.generatedLine,
          column: mapping.generatedColumn
        }
      };

      if (mapping.source != null) {
        newMapping.source = mapping.source;
        if (sourceRoot != null) {
          newMapping.source = util.relative(sourceRoot, newMapping.source);
        }

        newMapping.original = {
          line: mapping.originalLine,
          column: mapping.originalColumn
        };

        if (mapping.name != null) {
          newMapping.name = mapping.name;
        }
      }

      generator.addMapping(newMapping);
    });
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var sourceRelative = sourceFile;
      if (sourceRoot !== null) {
        sourceRelative = util.relative(sourceRoot, sourceFile);
      }

      if (!generator._sources.has(sourceRelative)) {
        generator._sources.add(sourceRelative);
      }

      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        generator.setSourceContent(sourceFile, content);
      }
    });
    return generator;
  };

/**
 * Add a single mapping from original source line and column to the generated
 * source's line and column for this source map being created. The mapping
 * object should have the following properties:
 *
 *   - generated: An object with the generated line and column positions.
 *   - original: An object with the original line and column positions.
 *   - source: The original source file (relative to the sourceRoot).
 *   - name: An optional original token name for this mapping.
 */
SourceMapGenerator.prototype.addMapping =
  function SourceMapGenerator_addMapping(aArgs) {
    // Optional fields read directly — `aArgs.X` returns undefined when absent;
    // downstream code uses `X != null` which treats undefined and null alike.
    // The required `generated` keeps getArg so the missing-arg throw is
    // preserved when validation is skipped.
    var generated = util.getArg(aArgs, 'generated');
    var original = aArgs.original != null ? aArgs.original : null;
    var source = aArgs.source != null ? aArgs.source : null;
    var name = aArgs.name != null ? aArgs.name : null;

    if (!this._skipValidation) {
      if (this._validateMapping(generated, original, source, name) === false) {
        return;
      }
    }

    // Resolve source/name to integer indices once here so MappingList.add
    // can store them as i32s in the slab. ArraySet.add is idempotent (its
    // own has() check internally), and indexOf is a fast Map.get afterward.
    var srcIdx = -1;
    if (source != null) {
      source = String(source);
      this._sources.add(source);
      srcIdx = this._sources.indexOf(source);
    }
    var nameIdx = -1;
    if (name != null) {
      name = String(name);
      this._names.add(name);
      nameIdx = this._names.indexOf(name);
    }

    // _validateMapping enforces numeric original.line/column when original is
    // provided; skipValidation users are on their own. -1 sentinel marks the
    // "no original" case (source-less mapping).
    var origLine = -1;
    var origCol = -1;
    if (original != null) {
      origLine = original.line;
      origCol = original.column;
    }

    this._mappings.add(
      generated.line,
      generated.column,
      origLine,
      origCol,
      srcIdx,
      nameIdx
    );
  };

/**
 * Set the source content for a source file.
 */
SourceMapGenerator.prototype.setSourceContent =
  function SourceMapGenerator_setSourceContent(aSourceFile, aSourceContent) {
    var source = aSourceFile;
    if (this._sourceRoot != null) {
      source = util.relative(this._sourceRoot, source);
    }

    if (aSourceContent != null) {
      // Add the source content to the _sourcesContents map.
      // Create a new _sourcesContents map if the property is null.
      if (!this._sourcesContents) {
        this._sourcesContents = Object.create(null);
      }
      this._sourcesContents[util.toSetString(source)] = aSourceContent;
    } else if (this._sourcesContents) {
      // Remove the source file from the _sourcesContents map.
      // If the _sourcesContents map is empty, set the property to null.
      delete this._sourcesContents[util.toSetString(source)];
      if (Object.keys(this._sourcesContents).length === 0) {
        this._sourcesContents = null;
      }
    }
  };

/**
 * Applies the mappings of a sub-source-map for a specific source file to the
 * source map being generated. Each mapping to the supplied source file is
 * rewritten using the supplied source map. Note: The resolution for the
 * resulting mappings is the minimium of this map and the supplied map.
 *
 * @param aSourceMapConsumer The source map to be applied.
 * @param aSourceFile Optional. The filename of the source file.
 *        If omitted, SourceMapConsumer's file property will be used.
 * @param aSourceMapPath Optional. The dirname of the path to the source map
 *        to be applied. If relative, it is relative to the SourceMapConsumer.
 *        This parameter is needed when the two source maps aren't in the same
 *        directory, and the source map to be applied contains relative source
 *        paths. If so, those relative source paths need to be rewritten
 *        relative to the SourceMapGenerator.
 */
SourceMapGenerator.prototype.applySourceMap =
  function SourceMapGenerator_applySourceMap(aSourceMapConsumer, aSourceFile, aSourceMapPath) {
    var sourceFile = aSourceFile;
    // If aSourceFile is omitted, we will use the file property of the SourceMap
    if (aSourceFile == null) {
      if (aSourceMapConsumer.file == null) {
        throw new Error(
          'SourceMapGenerator.prototype.applySourceMap requires either an explicit source file, ' +
          'or the source map\'s "file" property. Both were omitted.'
        );
      }
      sourceFile = aSourceMapConsumer.file;
    }
    var sourceRoot = this._sourceRoot;
    // Make "sourceFile" relative if an absolute Url is passed.
    if (sourceRoot != null) {
      sourceFile = util.relative(sourceRoot, sourceFile);
    }
    // Applying the SourceMap rebuilds the sources/names ArraySets and the
    // MappingList from scratch. The old code mutated mapping objects via the
    // unsortedForEach callback — that relied on the callback receiving the
    // actual stored reference, which slab-backed storage can't provide. We
    // walk the old slab, resolve indices through the old ArraySets, transform
    // mappings whose source matches `sourceFile`, and emit into a fresh
    // MappingList bound to the new ArraySets.
    var newSources = new ArraySet();
    var newNames = new ArraySet();
    var newMappings = new MappingList(newSources, newNames);

    var oldMappings = this._mappings;
    var oldBuf = oldMappings._buf;
    var oldCount = oldMappings._count;
    var oldSources = this._sources;
    var oldNames = this._names;

    for (var i = 0; i < oldCount; i++) {
      var off = i * FIELDS_PER_MAPPING;
      var genLine = oldBuf[off + F_GEN_LINE];
      var genCol  = oldBuf[off + F_GEN_COL];
      var srcIdx  = oldBuf[off + F_SRC_IDX];
      var origLine = oldBuf[off + F_ORIG_LINE];
      var origCol  = oldBuf[off + F_ORIG_COL];
      var nameIdx  = oldBuf[off + F_NAME_IDX];

      var source = srcIdx === -1 ? null : oldSources.at(srcIdx);
      var name   = nameIdx === -1 ? null : oldNames.at(nameIdx);

      if (source === sourceFile && origLine !== -1) {
        var original = aSourceMapConsumer.originalPositionFor({
          line: origLine,
          column: origCol === -1 ? 0 : origCol
        });
        if (original.source != null) {
          source = original.source;
          if (aSourceMapPath != null) {
            source = util.join(aSourceMapPath, source);
          }
          if (sourceRoot != null) {
            source = util.relative(sourceRoot, source);
          }
          // originalPositionFor guarantees numeric line/column when source
          // is non-null.
          origLine = original.line;
          origCol = original.column;
          if (original.name != null) {
            name = original.name;
          }
        }
      }

      var newSrcIdx = -1;
      if (source != null) {
        newSources.add(source);
        newSrcIdx = newSources.indexOf(source);
      }
      var newNameIdx = -1;
      if (name != null) {
        newNames.add(name);
        newNameIdx = newNames.indexOf(name);
      }

      newMappings.add(genLine, genCol, origLine, origCol, newSrcIdx, newNameIdx);
    }

    this._sources = newSources;
    this._names = newNames;
    this._mappings = newMappings;

    // Copy sourcesContents of applied map.
    aSourceMapConsumer.sources.forEach(function (sourceFile) {
      var content = aSourceMapConsumer.sourceContentFor(sourceFile);
      if (content != null) {
        if (aSourceMapPath != null) {
          sourceFile = util.join(aSourceMapPath, sourceFile);
        }
        if (sourceRoot != null) {
          sourceFile = util.relative(sourceRoot, sourceFile);
        }
        this.setSourceContent(sourceFile, content);
      }
    }, this);
  };

/**
 * A mapping can have one of the three levels of data:
 *
 *   1. Just the generated position.
 *   2. The Generated position, original position, and original source.
 *   3. Generated and original position, original source, as well as a name
 *      token.
 *
 * To maintain consistency, we validate that any new mapping being added falls
 * in to one of these categories.
 */
SourceMapGenerator.prototype._validateMapping =
  function SourceMapGenerator_validateMapping(aGenerated, aOriginal, aSource,
                                              aName) {
    // When aOriginal is truthy but has empty values for .line and .column,
    // it is most likely a programmer error. In this case we throw a very
    // specific error message to try to guide them the right way.
    // For example: https://github.com/Polymer/polymer-bundler/pull/519
    if (aOriginal && typeof aOriginal.line !== 'number' && typeof aOriginal.column !== 'number') {
      var message = 'original.line and original.column are not numbers -- you probably meant to omit ' +
      'the original mapping entirely and only map the generated position. If so, pass ' +
      'null for the original mapping instead of an object with empty or null values.'

      if (this._ignoreInvalidMapping) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(message);
        }
        return false;
      } else {
        throw new Error(message);
      }
    }

    if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
        && aGenerated.line > 0 && aGenerated.column >= 0
        && !aOriginal && !aSource && !aName) {
      // Case 1.
      return;
    }
    else if (aGenerated && 'line' in aGenerated && 'column' in aGenerated
             && aOriginal && 'line' in aOriginal && 'column' in aOriginal
             && aGenerated.line > 0 && aGenerated.column >= 0
             && aOriginal.line > 0 && aOriginal.column >= 0
             && aSource) {
      // Cases 2 and 3.
      return;
    }
    else {
      var message = 'Invalid mapping: ' + JSON.stringify({
        generated: aGenerated,
        source: aSource,
        original: aOriginal,
        name: aName
      });

      if (this._ignoreInvalidMapping) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(message);
        }
        return false;
      } else {
        throw new Error(message)
      }
    }
  };

// Fast VLQ encode lookup for values -15 to 15 (single char output)
var vlqEncodeTable = [];
(function() {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (var i = -15; i <= 15; i++) {
    // VLQ signed: negative becomes odd, positive becomes even
    var vlq = i < 0 ? ((-i) << 1) + 1 : (i << 1);
    vlqEncodeTable[i + 15] = chars[vlq];
  }
})();

/**
 * Serialize the accumulated mappings in to the stream of base 64 VLQs
 * specified by the source map format.
 */
SourceMapGenerator.prototype._serializeMappings =
  function SourceMapGenerator_serializeMappings() {
    var previousGeneratedColumn = 0;
    var previousGeneratedLine = 1;
    var previousOriginalColumn = 0;
    var previousOriginalLine = 0;
    var previousName = 0;
    var previousSource = 0;
    var result = '';
    var val;

    // Slab-direct read — bypass MappingList.toArray() materialization.
    // Source/name fields stored in the slab are already the int indices
    // we need to serialize (resolved when each mapping was added), so
    // there's no per-mapping `indexOf` lookup either.
    var ml = this._mappings;
    if (!ml._sorted) {
      ml._sort();
      ml._sorted = true;
    }
    var buf = ml._buf;
    var count = ml._count;

    for (var i = 0; i < count; i++) {
      var off = i * FIELDS_PER_MAPPING;
      var genLine = buf[off + F_GEN_LINE];
      var genCol  = buf[off + F_GEN_COL];
      var srcIdx  = buf[off + F_SRC_IDX];
      var origLine = buf[off + F_ORIG_LINE];
      var origCol  = buf[off + F_ORIG_COL];
      var nameIdx  = buf[off + F_NAME_IDX];

      var next = '';

      if (genLine !== previousGeneratedLine) {
        previousGeneratedColumn = 0;
        while (genLine !== previousGeneratedLine) {
          next += ';';
          previousGeneratedLine++;
        }
      } else {
        if (i > 0) {
          // Dedup: skip when every field equals the previous mapping.
          // Equivalent of the old
          // `compareByGeneratedPositionsInflated(a, b) === 0` check.
          if (ml._equalsPrev(i)) continue;
          next += ',';
        }
      }

      val = genCol - previousGeneratedColumn;
      next += (val >= -15 && val <= 15) ? vlqEncodeTable[val + 15] : base64VLQ.encode(val);
      previousGeneratedColumn = genCol;

      if (srcIdx !== -1) {
        val = srcIdx - previousSource;
        next += (val >= -15 && val <= 15) ? vlqEncodeTable[val + 15] : base64VLQ.encode(val);
        previousSource = srcIdx;

        // lines are stored 0-based in SourceMap spec version 3
        val = origLine - 1 - previousOriginalLine;
        next += (val >= -15 && val <= 15) ? vlqEncodeTable[val + 15] : base64VLQ.encode(val);
        previousOriginalLine = origLine - 1;

        val = origCol - previousOriginalColumn;
        next += (val >= -15 && val <= 15) ? vlqEncodeTable[val + 15] : base64VLQ.encode(val);
        previousOriginalColumn = origCol;

        if (nameIdx !== -1) {
          val = nameIdx - previousName;
          next += (val >= -15 && val <= 15) ? vlqEncodeTable[val + 15] : base64VLQ.encode(val);
          previousName = nameIdx;
        }
      }

      result += next;
    }

    return result;
  };

SourceMapGenerator.prototype._generateSourcesContent =
  function SourceMapGenerator_generateSourcesContent(aSources, aSourceRoot) {
    return aSources.map(function (source) {
      if (!this._sourcesContents) {
        return null;
      }
      if (aSourceRoot != null) {
        source = util.relative(aSourceRoot, source);
      }
      var key = util.toSetString(source);
      return Object.prototype.hasOwnProperty.call(this._sourcesContents, key)
        ? this._sourcesContents[key]
        : null;
    }, this);
  };

/**
 * Externalize the source map.
 */
SourceMapGenerator.prototype.toJSON =
  function SourceMapGenerator_toJSON() {
    var map = {
      version: this._version,
      sources: this._sources.toArray(),
      names: this._names.toArray(),
      mappings: this._serializeMappings()
    };
    if (this._file != null) {
      map.file = this._file;
    }
    if (this._sourceRoot != null) {
      map.sourceRoot = this._sourceRoot;
    }
    if (this._sourcesContents) {
      map.sourcesContent = this._generateSourcesContent(map.sources, map.sourceRoot);
    }

    return map;
  };

/**
 * Render the source map being generated to a string.
 */
SourceMapGenerator.prototype.toString =
  function SourceMapGenerator_toString() {
    return JSON.stringify(this.toJSON());
  };

exports.SourceMapGenerator = SourceMapGenerator;
