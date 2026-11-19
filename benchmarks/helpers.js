'use strict';

// Inputs and hashing shared by the before/after cases (cases.js) and the
// comparison cases (compare-cases.js). Inputs come from benchmarks/codec.js
// and a seeded PRNG, never from a library under test, so every library gets
// the same queries.

// mulberry32
function random(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(h, x) {
  return Math.imul(h ^ x, 0x01000193) | 0;
}

function hashString(h, s) {
  if (s == null) return mix(h, -1);
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return mix(h, s.length);
}

// Cheap enough for the timed loop: numbers and string lengths only.
function mixResult(h, r) {
  if (Array.isArray(r)) {
    h = mix(h, r.length);
    return r.length ? mixResult(h, r[0]) : h;
  }
  h = mix(h, r.line == null ? -1 : r.line);
  h = mix(h, r.column == null ? -1 : r.column);
  return mix(h, r.source == null ? -1 : r.source.length);
}

function mixMapping(h, m, full) {
  h = mix(h, m.generatedLine);
  h = mix(h, m.generatedColumn);
  h = mix(h, m.originalLine == null ? -1 : m.originalLine);
  h = mix(h, m.originalColumn == null ? -1 : m.originalColumn);
  if (!full) return h;
  return hashString(hashString(h, m.source), m.name);
}

// Picks `count` segments: at random (seeded) when `rand` is given, otherwise
// evenly spaced in generated order. Returns [lineIndex, segment] pairs.
function pickSegments(lines, count, rand, filter = () => true) {
  const lineOf = [];
  const segmentOf = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      if (!filter(lines[i][j])) continue;
      lineOf.push(i);
      segmentOf.push(j);
    }
  }
  const total = lineOf.length;
  const n = total === 0 ? 0 : rand ? count : Math.min(count, total);
  const picked = [];
  for (let k = 0; k < n; k++) {
    const index = rand
      ? Math.floor(rand() * total)
      : Math.floor((k * total) / n);
    picked.push([lineOf[index], lines[lineOf[index]][segmentOf[index]]]);
  }
  return picked;
}

const hasSource = (segment) => segment.length >= 4;

// Picks `count` original lines, each [source index, line index], at random
// from the distinct lines that have mappings. Picking segments instead would
// favor lines with many segments: issue-41.js.map has one line with 313k of
// its 314k segments, and allGeneratedPositionsFor() returns all of them.
function pickOriginalLines(lines, count, rand) {
  const seen = new Set();
  const distinct = [];
  for (const segments of lines) {
    for (const s of segments) {
      if (!hasSource(s)) continue;
      const key = `${s[1]}:${s[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push([s[1], s[2]]);
    }
  }
  const picked = [];
  for (let k = 0; k < count && distinct.length; k++) {
    picked.push(distinct[Math.floor(rand() * distinct.length)]);
  }
  return picked;
}

// One addMapping() argument per segment, in generated order.
function addMappingArgs(fixture) {
  const { sources, names = [] } = fixture.map;
  const args = [];
  fixture.lines.forEach((segments, line) => {
    for (const s of segments) {
      const generated = { line: line + 1, column: s[0] };
      if (s.length === 1) {
        args.push({ generated });
      } else {
        args.push({
          generated,
          source: sources[s[1]],
          original: { line: s[2] + 1, column: s[3] },
          name: s.length === 5 ? names[s[4]] : undefined,
        });
      }
    }
  });
  return args;
}

module.exports = {
  random,
  mix,
  hashString,
  mixResult,
  mixMapping,
  pickSegments,
  hasSource,
  pickOriginalLines,
  addMappingArgs,
};
