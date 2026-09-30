# Contributing

Thank you for your interest in contributing to this library! Contributions are
very appreciated.

--------------------------------------------------------------------------------

<!-- `yarn toc` to regenerate the Table of Contents -->

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
## Table of Contents

- [Filing Issues](#filing-issues)
- [Getting Started](#getting-started)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Running Tests](#running-tests)
- [Writing New Tests](#writing-new-tests)
- [Benchmarks](#benchmarks)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->



## Filing Issues

If you are filing an issue for a bug or other misbehavior, please provide:

* **A test case.** The more minimal the better, but sometimes a larger test case
  cannot be helped. This should be in the form of a gist, node script,
  repository, etc.

* **Steps to reproduce the bug.** The more exact and specific the better.

* **The result you expected.**

* **The actual result.**

## Getting Started

```
$ git clone https://github.com/7rulnik/source-map-js.git
$ cd source-map-js/
$ yarn install
```

The package is consumed directly from `source-map.js` + `lib/` — there is no
build step.

## Submitting Pull Requests

Make sure that tests pass locally before creating a pull request.

Use a feature branch and pull request for each change, with logical commits. If
your reviewer asks you to make changes before the pull request is accepted,
fixup your existing commit(s) rather than adding follow up commits, and then
force push to the remote branch to update the pull request.

## Running Tests

Tests run on Node's built-in test runner (`node --test`). CI runs against
Node 22, 24, and 26.

```shell
$ yarn test                # all suites
$ yarn test:public         # public-API tests
$ yarn test:internal       # internal-helper tests
$ yarn test:conformance    # ECMA-426 conformance suite
$ yarn test:coverage       # with coverage thresholds enforced
```

## Writing New Tests

Tests live under `test/{public,internal,conformance}/` and are picked up by the
`test-*.js` glob in `package.json`. Each file uses Node's test runner directly:

```js
const test = require('node:test').test;
const assert = require('node:assert');
const sourceMap = require('../../source-map');

test('issue #123: doing the foo bar', () => {
  assert.doesNotThrow(() => {
    new sourceMap.SourceMapConsumer(/* ... */);
  });
});
```

Use `test('name', { todo: true }, fn)` (or `test.todo`) for known-failing
specs you want surfaced but not blocking — these show up as `# TODO` in the
output instead of failing the run.

Shared fixtures and helpers live in `test/util.js`:

```js
const util = require('../util');
```

## Benchmarks

Three suites under `benchmarks/`, each ported from a different upstream — see
the per-directory README for details.

```shell
$ yarn bench:mozilla-0.6.1            # parse + serialize (mozilla 0.6.1)
$ yarn bench:mozilla-master           # cold/warm consumer (mozilla master)
$ yarn bench:jridgewell:trace         # originalPositionFor + generatedPositionFor
$ yarn bench:jridgewell:generate      # addMapping + serialization
```
