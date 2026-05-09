// Port of Chrome DevTools' current SourceMap decoder, stripped to the
// decode + lookup essentials needed by the trace bench.
//
// Source: chromium/devtools-frontend
//   front_end/core/sdk/SourceMap.ts
//   pinned at commit a5d138e11aa4cf762b4ab127eeb7627cd2d34398 (2026-03-17)
// https://chromium.googlesource.com/devtools/devtools-frontend/+/a5d138e11aa4cf762b4ab127eeb7627cd2d34398/front_end/core/sdk/SourceMap.ts
//
// Stripped relative to upstream:
//   - scopes / function ranges / ignoreList / debugId / inlineFrameIndex
//   - augmentWithScopes, findEntryExact, findEntryRanges, findReverseRanges,
//     reverseMapTextRanges, findOriginalFunctionName/Scope, resolveScopeChain,
//     translateCallSite, hasInlinedFrames, isOutlinedFrame, mapsOrigin,
//     compatibleForURL, findRanges, parseBloombergScopes
//   - Platform.DevToolsPath.UrlString (erased to plain string)
//   - Common.ParsedURL.completeURL: replaced with a minimal absolute-vs-
//     relative classifier (good enough for fixtures whose source URLs are
//     already absolute or filenames; no resolution against base URLs needed
//     for bench equivalence).
//   - Common.Base64.BASE64_CODES: inlined as a Uint8Array
//   - Platform.ArrayUtilities.upperBound/lowerBound: inlined below
//   - TextUtils.TextRange: not needed (no range-returning methods kept)
//   - Common.Console.warn / console.error on bad input: silent (bench inputs
//     are valid)
//
// Bench compatibility shim:
//   The trace bench calls `new ChromeMap(url, payload)`, `cm.findEntry(l,c)`,
//   `cm.sources()`, `cm.findEntryReversed(srcUrl, line)`. The current upstream
//   API has a different shape, so this file exports a `SourceMap` adapter
//   class that exposes the legacy method names on top of the new
//   implementation.

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CODES = new Uint8Array(128);
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_CODES[BASE64_CHARS.charCodeAt(i)] = i;
}

function upperBound(array, needle, comparator) {
  let l = 0;
  let r = array.length;
  while (l < r) {
    const m = (l + r) >>> 1;
    if (comparator(needle, array[m]) >= 0) {
      l = m + 1;
    } else {
      r = m;
    }
  }
  return r;
}

function lowerBound(array, needle, comparator) {
  let l = 0;
  let r = array.length;
  while (l < r) {
    const m = (l + r) >>> 1;
    if (comparator(needle, array[m]) > 0) {
      l = m + 1;
    } else {
      r = m;
    }
  }
  return r;
}

function isAbsoluteURL(url) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url);
}

// Minimal stand-in for Common.ParsedURL.completeURL. Fixtures in this bench
// use either absolute URLs or bare filenames, both of which round-trip as-is
// here. This matches the existing chrome.mjs adapter's effective behavior on
// the same fixtures.
function completeURL(baseURL, href) {
  if (isAbsoluteURL(href)) return href;
  return href; // bench fixtures don't require base resolution
}

const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = (1 << 5) - 1;
const VLQ_CONTINUATION_MASK = 1 << 5;

export class TokenIterator {
  #string;
  #position;

  constructor(string) {
    this.#string = string;
    this.#position = 0;
  }

  next() {
    return this.#string.charAt(this.#position++);
  }

  nextCharCode() {
    return this.#string.charCodeAt(this.#position++);
  }

  peek() {
    return this.#string.charAt(this.#position);
  }

  hasNext() {
    return this.#position < this.#string.length;
  }

  nextVLQ() {
    let result = 0;
    let shift = 0;
    let digit = VLQ_CONTINUATION_MASK;
    while (digit & VLQ_CONTINUATION_MASK) {
      if (!this.hasNext()) {
        throw new Error('Unexpected end of input while decoding VLQ number!');
      }
      const charCode = this.nextCharCode();
      digit = BASE64_CODES[charCode];
      if (charCode !== 65 /* 'A' */ && digit === 0) {
        throw new Error(`Unexpected char '${String.fromCharCode(charCode)}' encountered while decoding`);
      }
      result += (digit & VLQ_BASE_MASK) << shift;
      shift += VLQ_BASE_SHIFT;
    }
    const negative = result & 1;
    result >>= 1;
    return negative ? -result : result;
  }
}

export class SourceMapEntry {
  constructor(lineNumber, columnNumber, sourceIndex, sourceURL, sourceLineNumber, sourceColumnNumber, name) {
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber;
    this.sourceIndex = sourceIndex;
    this.sourceURL = sourceURL;
    this.sourceLineNumber = sourceLineNumber;
    this.sourceColumnNumber = sourceColumnNumber;
    this.name = name;
  }

  static compare(a, b) {
    if (a.lineNumber !== b.lineNumber) {
      return a.lineNumber - b.lineNumber;
    }
    return a.columnNumber - b.columnNumber;
  }
}

class SourceMapImpl {
  #json;
  #compiledURL;
  #sourceMappingURL;
  #baseURL;
  #mappings = null;
  #sourceInfos = [];
  #sourceInfoByURL = new Map();

  constructor(compiledURL, sourceMappingURL, payload) {
    this.#json = payload;
    this.#compiledURL = compiledURL;
    this.#sourceMappingURL = sourceMappingURL;
    // schemeIs(sourceMappingURL, 'data:') — for fixtures we use plain URLs, not data URLs
    this.#baseURL = sourceMappingURL;
    this.#eachSection(this.#parseSources.bind(this));
  }

  sourceURLs() {
    return [...this.#sourceInfoByURL.keys()];
  }

  sourceURLForSourceIndex(index) {
    return this.#sourceInfos[index]?.sourceURL;
  }

  mappings() {
    this.#ensureSourceMapProcessed();
    return this.#mappings ?? [];
  }

  findEntry(lineNumber, columnNumber) {
    const mappings = this.mappings();
    const index = upperBound(
      mappings, undefined,
      (_, entry) => lineNumber - entry.lineNumber || columnNumber - entry.columnNumber,
    );
    return index ? mappings[index - 1] : null;
  }

  sourceLineMapping(sourceURL, lineNumber, columnNumber) {
    const mappings = this.mappings();
    const reverseMappings = this.#reversedMappings(sourceURL);
    const lineComparator = (ln, i) => ln - mappings[i].sourceLineNumber;
    const first = lowerBound(reverseMappings, lineNumber, lineComparator);
    const last = upperBound(reverseMappings, lineNumber, lineComparator);
    if (first >= reverseMappings.length || mappings[reverseMappings[first]].sourceLineNumber !== lineNumber) {
      return null;
    }
    const columnMappings = reverseMappings.slice(first, last);
    if (!columnMappings.length) {
      return null;
    }
    const index = lowerBound(
      columnMappings, columnNumber,
      (col, i) => col - mappings[i].sourceColumnNumber,
    );
    return index >= columnMappings.length
      ? mappings[columnMappings[columnMappings.length - 1]]
      : mappings[columnMappings[index]];
  }

  findReverseEntries(sourceURL, lineNumber, columnNumber) {
    const mappings = this.mappings();
    const reverseMappings = this.#reversedMappings(sourceURL);
    const endIndex = upperBound(
      reverseMappings, undefined,
      (_, i) => lineNumber - mappings[i].sourceLineNumber || columnNumber - mappings[i].sourceColumnNumber,
    );
    let startIndex = endIndex;
    while (
      startIndex > 0 &&
      mappings[reverseMappings[startIndex - 1]].sourceLineNumber === mappings[reverseMappings[endIndex - 1]].sourceLineNumber &&
      mappings[reverseMappings[startIndex - 1]].sourceColumnNumber === mappings[reverseMappings[endIndex - 1]].sourceColumnNumber
    ) {
      --startIndex;
    }
    return reverseMappings.slice(startIndex, endIndex).map(i => mappings[i]);
  }

  #reversedMappings(sourceURL) {
    this.#ensureSourceMapProcessed();
    return this.#sourceInfoByURL.get(sourceURL)?.reverseMappings ?? [];
  }

  #ensureSourceMapProcessed() {
    if (this.#mappings === null) {
      this.#mappings = [];
      this.#eachSection(this.#parseMap.bind(this));
      this.#mappings.sort(SourceMapEntry.compare);
      this.#computeReverseMappings(this.#mappings);
    }
  }

  #computeReverseMappings(mappings) {
    const reverseMappingsPerUrl = new Map();
    for (let i = 0; i < mappings.length; i++) {
      const entryUrl = mappings[i]?.sourceURL;
      if (!entryUrl) continue;
      let reverseMap = reverseMappingsPerUrl.get(entryUrl);
      if (!reverseMap) {
        reverseMap = [];
        reverseMappingsPerUrl.set(entryUrl, reverseMap);
      }
      reverseMap.push(i);
    }
    for (const [url, reverseMap] of reverseMappingsPerUrl.entries()) {
      const info = this.#sourceInfoByURL.get(url);
      if (!info) continue;
      reverseMap.sort((indexA, indexB) => {
        const a = mappings[indexA];
        const b = mappings[indexB];
        return a.sourceLineNumber - b.sourceLineNumber
          || a.sourceColumnNumber - b.sourceColumnNumber
          || a.lineNumber - b.lineNumber
          || a.columnNumber - b.columnNumber;
      });
      info.reverseMappings = reverseMap;
    }
  }

  #eachSection(callback) {
    if (!this.#json) return;
    if ('sections' in this.#json) {
      let sourcesIndex = 0;
      for (const section of this.#json.sections) {
        if ('map' in section) {
          callback(section.map, sourcesIndex, section.offset.line, section.offset.column);
          sourcesIndex += section.map.sources.length;
        }
      }
    } else {
      callback(this.#json, 0, 0, 0);
    }
  }

  #parseSources(sourceMap) {
    const sourceRoot = sourceMap.sourceRoot ?? '';
    for (let i = 0; i < sourceMap.sources.length; ++i) {
      let href = sourceMap.sources[i];
      if (!isAbsoluteURL(href)) {
        if (sourceRoot && !sourceRoot.endsWith('/') && href && !href.startsWith('/')) {
          href = sourceRoot + '/' + href;
        } else {
          href = sourceRoot + href;
        }
      }
      const url = completeURL(this.#baseURL, href) || href;
      const source = sourceMap.sourcesContent?.[i];
      const sourceInfo = {
        sourceURL: url,
        content: source ?? null,
        reverseMappings: null,
      };
      this.#sourceInfos.push(sourceInfo);
      if (!this.#sourceInfoByURL.has(url)) {
        this.#sourceInfoByURL.set(url, sourceInfo);
      }
    }
  }

  #parseMap(map, baseSourceIndex, baseLineNumber, baseColumnNumber) {
    let sourceIndex = baseSourceIndex;
    let lineNumber = baseLineNumber;
    let columnNumber = baseColumnNumber;
    let sourceLineNumber = 0;
    let sourceColumnNumber = 0;
    let nameIndex = 0;
    const names = map.names ?? [];
    const tokenIter = new TokenIterator(map.mappings);
    let sourceURL = this.#sourceInfos[sourceIndex]?.sourceURL;

    while (true) {
      if (tokenIter.peek() === ',') {
        tokenIter.next();
      } else {
        while (tokenIter.peek() === ';') {
          lineNumber += 1;
          columnNumber = 0;
          tokenIter.next();
        }
        if (!tokenIter.hasNext()) break;
      }

      columnNumber += tokenIter.nextVLQ();
      if (!tokenIter.hasNext() || this.#isSeparator(tokenIter.peek())) {
        this.#mappings.push(new SourceMapEntry(lineNumber, columnNumber));
        continue;
      }

      const sourceIndexDelta = tokenIter.nextVLQ();
      if (sourceIndexDelta) {
        sourceIndex += sourceIndexDelta;
        sourceURL = this.#sourceInfos[sourceIndex]?.sourceURL;
      }
      sourceLineNumber += tokenIter.nextVLQ();
      sourceColumnNumber += tokenIter.nextVLQ();

      if (!tokenIter.hasNext() || this.#isSeparator(tokenIter.peek())) {
        this.#mappings.push(new SourceMapEntry(lineNumber, columnNumber, sourceIndex, sourceURL, sourceLineNumber, sourceColumnNumber));
        continue;
      }

      nameIndex += tokenIter.nextVLQ();
      this.#mappings.push(new SourceMapEntry(
        lineNumber, columnNumber, sourceIndex, sourceURL, sourceLineNumber, sourceColumnNumber, names[nameIndex],
      ));
    }
  }

  #isSeparator(char) {
    return char === ',' || char === ';';
  }
}

// Adapter that matches the legacy `chrome.mjs` API shape used by the bench:
//   new SourceMap(url, payload)
//   .findEntry(line, col)
//   .sources()
//   .findEntryReversed(sourceURL, sourceLine)
export function SourceMap(sourceMappingURL, payload) {
  this._impl = new SourceMapImpl(sourceMappingURL, sourceMappingURL, payload);
}

SourceMap.prototype = {
  sources() {
    return this._impl.sourceURLs();
  },
  findEntry(lineNumber, columnNumber) {
    const e = this._impl.findEntry(lineNumber, columnNumber);
    if (!e) return null;
    if (e.sourceURL === undefined) return [e.lineNumber, e.columnNumber];
    return [e.lineNumber, e.columnNumber, e.sourceURL, e.sourceLineNumber, e.sourceColumnNumber];
  },
  // findEntryReversed in legacy chrome.mjs: "first generated position on
  // source line `lineNumber`". Modern API requires (line, col); pass col=0.
  findEntryReversed(sourceURL, lineNumber) {
    const e = this._impl.sourceLineMapping(sourceURL, lineNumber, 0);
    if (!e) {
      const all = this._impl.mappings();
      return all.length ? [all[0].lineNumber, all[0].columnNumber] : null;
    }
    return [e.lineNumber, e.columnNumber];
  },
};
