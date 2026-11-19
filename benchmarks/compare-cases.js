'use strict';

// Comparison cases: the same work on every library in libs.js, through its
// adapter.
//
//   setup(lib, fixture) → { run, checksum, async? }   (setup may be async)
//
// As in cases.js, run() is one timed unit of work and returns a number derived
// from the results. checksum() returns the answers in a form that doesn't
// depend on the library: an array of hashes, one per query (or one per
// generated line), so the driver can count how many answers differ from
// source-map-js's. Where libraries can give different answers that are all
// right, checksum() returns { answers, equivalent }: `equivalent` hashes only
// what a right answer has to have, so the driver can tell the two apart.
// Every library parses the same JSON string, because that's what callers
// usually have, and parsing it is part of what a library costs.
//
// Optional fields: `unit`, what the checksum has one hash per (default
// "queries"), and `equivalent`, what a different but right answer is.
//
// With `async: true`, the worker awaits each run(). Only source-map 0.8 needs
// it: its consumer is created asynchronously.

const { decode } = require('./codec');
const {
  random,
  mix,
  hashString,
  mixResult,
  mixMapping,
  pickSegments,
  hasSource,
  addMappingArgs,
} = require('./helpers');

const QUERIES = 10000;
const ALL_POSITIONS_QUERIES = 1000;

// --- Answers in a library-independent form --------------------------------

// Libraries resolve sources against sourceRoot in slightly different ways, so
// answers are compared by source index, not by string.
function sourceIndexes(lib, consumer) {
  const indexes = new Map();
  lib.sources(consumer).forEach((source, i) => {
    if (!indexes.has(source)) indexes.set(source, i);
  });
  return (source) =>
    source == null ? -1 : indexes.has(source) ? indexes.get(source) : -2;
}

function hashOriginal(sourceIndex, r) {
  let h = mix(0, sourceIndex(r.source));
  h = mix(h, r.line == null ? -1 : r.line);
  h = mix(h, r.column == null ? -1 : r.column);
  return hashString(h, r.name);
}

// lastColumn is left out: only some libraries compute it.
function hashGenerated(r) {
  return mix(
    mix(0, r.line == null ? -1 : r.line),
    r.column == null ? -1 : r.column
  );
}

function hashAllGenerated(results) {
  let h = mix(0, results.length);
  for (const r of results) h = mix(h, hashGenerated(r));
  return h;
}

// When several generated positions map to the queried original position,
// generatedPositionFor() may return any of them, and libraries pick different
// ones. An answer is right if it maps back to the query, so the equivalent
// form is the original position the answer maps to, per the fixture's own
// mappings.
function originalAt(fixture) {
  return (r) => {
    const segments = r.line == null ? undefined : fixture.lines[r.line - 1];
    if (!segments) return mix(0, -1);
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid][0] < r.column) lo = mid + 1;
      else hi = mid - 1;
    }
    const s = segments[lo];
    if (!s || s[0] !== r.column || s.length < 4) return mix(0, -2);
    return mix(mix(mix(0, s[1]), s[2]), s[3]);
  };
}

// allGeneratedPositionsFor() returns the same positions in different orders,
// so the equivalent form is order-independent.
function hashAllGeneratedUnordered(results) {
  return hashAllGenerated(
    [...results].sort((a, b) => a.line - b.line || a.column - b.column)
  );
}

// One hash per generated line of a serialized source map. Output field order
// and sourceRoot handling differ between libraries, so this decodes the
// mappings and hashes them with source and name strings.
function hashOutput(text) {
  const map = JSON.parse(text);
  const sources = map.sources || [];
  const names = map.names || [];
  return decode(map.mappings).map((segments) => {
    let h = mix(0, segments.length);
    for (const s of segments) {
      h = mix(h, s[0]);
      if (s.length === 1) continue;
      h = hashString(h, sources[s[1]]);
      h = mix(mix(h, s[2]), s[3]);
      if (s.length === 5) h = hashString(h, names[s[4]]);
    }
    return h;
  });
}

// --- Inputs ------------------------------------------------------------------

function originalPositionQueries(fixture, rand) {
  return pickSegments(fixture.lines, QUERIES, rand).map(([line, s]) => ({
    line: line + 1,
    column: s[0],
  }));
}

function generatedPositionQueries(fixture, count, rand) {
  const { sources } = fixture.map;
  return pickSegments(fixture.lines, count, rand, hasSource).map(([, s]) => ({
    source: sources[s[1]],
    line: s[2] + 1,
    column: s[3],
  }));
}

// A consumer that has answered one query in each direction, so every lazy
// index the library builds is in place before timing starts.
async function readyConsumer(lib, fixture) {
  const consumer = await lib.consumer(fixture.text);
  lib.originalPositionFor(consumer, { line: 1, column: 0 });
  lib.generatedPositionFor(
    consumer,
    generatedPositionQueries(fixture, 1, undefined)[0]
  );
  return consumer;
}

// For the parse cases, which create their own consumers.
async function readySourceIndexes(lib, fixture) {
  const consumer = await readyConsumer(lib, fixture);
  const sourceIndex = sourceIndexes(lib, consumer);
  lib.destroy(consumer);
  return sourceIndex;
}

// Creates a consumer, calls `work` on it and destroys it. For source-map 0.8
// this is async, and destroy() frees its WebAssembly memory.
function withConsumer(lib, text, work) {
  if (lib.async) {
    return {
      async: true,
      async run() {
        const consumer = await lib.consumer(text);
        const result = work(consumer);
        lib.destroy(consumer);
        return result;
      },
    };
  }
  return { run: () => work(lib.consumer(text)) };
}

function lookups(lookup, queries, hash, equivalent) {
  return {
    run() {
      let h = 0;
      for (let i = 0; i < queries.length; i++) {
        h = mixResult(h, lookup(queries[i]));
      }
      return h;
    },
    checksum() {
      const results = queries.map(lookup);
      const answers = results.map(hash);
      return equivalent
        ? { answers, equivalent: results.map(equivalent) }
        : answers;
    },
  };
}

function buildGenerator(lib, fixture, args) {
  const generator = lib.generator({
    file: fixture.map.file,
    sourceRoot: fixture.map.sourceRoot,
  });
  for (let i = 0; i < args.length; i++) lib.addMapping(generator, args[i]);
  return generator;
}

// Keeps the last built object reachable, so building it can't be optimized
// away.
let keep;

// --- Cases -------------------------------------------------------------------

const CASES = [
  {
    name: 'parse',
    description:
      'create a consumer from the JSON string and answer the first originalPositionFor()',
    async setup(lib, fixture) {
      const first = { line: 1, column: 0 };
      const { run, async } = withConsumer(lib, fixture.text, (c) =>
        mixResult(0, lib.originalPositionFor(c, first))
      );
      const sourceIndex = await readySourceIndexes(lib, fixture);
      return {
        run,
        async,
        async checksum() {
          const c = await lib.consumer(fixture.text);
          const answer = [
            hashOriginal(sourceIndex, lib.originalPositionFor(c, first)),
          ];
          lib.destroy(c);
          return answer;
        },
      };
    },
  },
  {
    name: 'parse-both',
    description:
      'parse, then the first generatedPositionFor(), which builds the original-order index in libraries that build it lazily',
    equivalent:
      'another of the generated positions that map to the queried original position',
    async setup(lib, fixture) {
      const first = { line: 1, column: 0 };
      const firstOriginal = generatedPositionQueries(fixture, 1, undefined)[0];
      const { run, async } = withConsumer(lib, fixture.text, (c) => {
        const h = mixResult(0, lib.originalPositionFor(c, first));
        return mixResult(h, lib.generatedPositionFor(c, firstOriginal));
      });
      const sourceIndex = await readySourceIndexes(lib, fixture);
      const equivalent = originalAt(fixture);
      return {
        run,
        async,
        async checksum() {
          const c = await lib.consumer(fixture.text);
          const original = hashOriginal(
            sourceIndex,
            lib.originalPositionFor(c, first)
          );
          const generated = lib.generatedPositionFor(c, firstOriginal);
          lib.destroy(c);
          return {
            answers: [original, hashGenerated(generated)],
            equivalent: [original, equivalent(generated)],
          };
        },
      };
    },
  },
  {
    name: 'opf-random',
    description: `originalPositionFor() × ${QUERIES} random generated positions`,
    async setup(lib, fixture) {
      const c = await readyConsumer(lib, fixture);
      const sourceIndex = sourceIndexes(lib, c);
      return lookups(
        (q) => lib.originalPositionFor(c, q),
        originalPositionQueries(fixture, random(1)),
        (r) => hashOriginal(sourceIndex, r)
      );
    },
  },
  {
    name: 'opf-ascending',
    description: `originalPositionFor() × ${QUERIES} generated positions in ascending order`,
    async setup(lib, fixture) {
      const c = await readyConsumer(lib, fixture);
      const sourceIndex = sourceIndexes(lib, c);
      return lookups(
        (q) => lib.originalPositionFor(c, q),
        originalPositionQueries(fixture, undefined),
        (r) => hashOriginal(sourceIndex, r)
      );
    },
  },
  {
    name: 'gpf-random',
    description: `generatedPositionFor() × ${QUERIES} random original positions`,
    equivalent:
      'another of the generated positions that map to the queried original position',
    async setup(lib, fixture) {
      const c = await readyConsumer(lib, fixture);
      return lookups(
        (q) => lib.generatedPositionFor(c, q),
        generatedPositionQueries(fixture, QUERIES, random(2)),
        hashGenerated,
        originalAt(fixture)
      );
    },
  },
  {
    // With a column: trace-mapping only matches the exact column, while
    // source-map without a column returns every mapping on the line.
    name: 'agpf-random',
    description: `allGeneratedPositionsFor() × ${ALL_POSITIONS_QUERIES} random original positions (with a column)`,
    equivalent: 'the same positions in a different order',
    async setup(lib, fixture) {
      const c = await readyConsumer(lib, fixture);
      return lookups(
        (q) => lib.allGeneratedPositionsFor(c, q),
        generatedPositionQueries(fixture, ALL_POSITIONS_QUERIES, random(3)),
        hashAllGenerated,
        hashAllGeneratedUnordered
      );
    },
  },
  {
    name: 'each-generated',
    description: 'eachMapping() in generated order',
    unit: 'generated lines',
    async setup(lib, fixture) {
      const c = await readyConsumer(lib, fixture);
      const sourceIndex = sourceIndexes(lib, c);
      return {
        run() {
          let h = 0;
          lib.eachMapping(c, (m) => {
            h = mixMapping(h, m, false);
          });
          return h;
        },
        checksum() {
          const lines = fixture.lines.map(() => 0);
          lib.eachMapping(c, (m) => {
            const i = m.generatedLine - 1;
            let h = mix(lines[i], m.generatedColumn);
            if (m.source != null) {
              h = mix(h, sourceIndex(m.source));
              h = mix(mix(h, m.originalLine), m.originalColumn);
              h = hashString(h, m.name);
            }
            lines[i] = h;
          });
          return lines;
        },
      };
    },
  },
  {
    name: 'add-mapping',
    description:
      'create a generator and addMapping() every segment, in generated order',
    unit: 'generated lines',
    setup(lib, fixture) {
      const args = addMappingArgs(fixture);
      return {
        run() {
          keep = buildGenerator(lib, fixture, args);
          return args.length;
        },
        checksum: () =>
          hashOutput(lib.toString(buildGenerator(lib, fixture, args))),
      };
    },
  },
  {
    name: 'to-string',
    description: 'serialize a generator holding every segment to a JSON string',
    unit: 'generated lines',
    setup(lib, fixture) {
      const generator = buildGenerator(lib, fixture, addMappingArgs(fixture));
      return {
        run: () => lib.toString(generator).length,
        checksum: () => hashOutput(lib.toString(generator)),
      };
    },
  },
];

exports.CASES = CASES;
exports.load = (id) => require('./libs').findLib(id).load();
