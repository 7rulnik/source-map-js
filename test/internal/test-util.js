/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2014 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var test = require('node:test').test;
var assert = require('node:assert');

var libUtil = require('../../lib/util');

test('test urls', () => {
  var assertUrl = function (url) {
    assert.equal(url, libUtil.urlGenerate(libUtil.urlParse(url)));
  };
  assertUrl('http://');
  assertUrl('http://www.example.com');
  assertUrl('http://user:pass@www.example.com');
  assertUrl('http://www.example.com:80');
  assertUrl('http://www.example.com/');
  assertUrl('http://www.example.com/foo/bar');
  assertUrl('http://www.example.com/foo/bar/');
  assertUrl('http://user:pass@www.example.com:80/foo/bar/');

  assertUrl('//');
  assertUrl('//www.example.com');
  assertUrl('file:///www.example.com');

  assert.equal(libUtil.urlParse(''), null);
  assert.equal(libUtil.urlParse('.'), null);
  assert.equal(libUtil.urlParse('..'), null);
  assert.equal(libUtil.urlParse('a'), null);
  assert.equal(libUtil.urlParse('a/b'), null);
  assert.equal(libUtil.urlParse('a//b'), null);
  assert.equal(libUtil.urlParse('/a'), null);
  assert.equal(libUtil.urlParse('data:foo,bar'), null);

  var parsed = libUtil.urlParse('http://x-y.com/bar');
  assert.equal(parsed.scheme, 'http');
  assert.equal(parsed.host, 'x-y.com');
  assert.equal(parsed.path, '/bar');

  var webpackURL = 'webpack:///webpack/bootstrap 67e184f9679733298d44'
  parsed = libUtil.urlParse(webpackURL);
  assert.equal(parsed.scheme, 'webpack');
  assert.equal(parsed.host, '');
  assert.equal(parsed.path, '/webpack/bootstrap 67e184f9679733298d44');
  assert.equal(webpackURL, libUtil.urlGenerate(parsed));
});

test('test normalize()', () => {
  assert.equal(libUtil.normalize('/..'), '/');
  assert.equal(libUtil.normalize('/../'), '/');
  assert.equal(libUtil.normalize('/../../../..'), '/');
  assert.equal(libUtil.normalize('/../../../../a/b/c'), '/a/b/c');
  assert.equal(libUtil.normalize('/a/b/c/../../../d/../../e'), '/e');

  assert.equal(libUtil.normalize('..'), '..');
  assert.equal(libUtil.normalize('../'), '../');
  assert.equal(libUtil.normalize('../../a/'), '../../a/');
  assert.equal(libUtil.normalize('a/..'), '.');
  assert.equal(libUtil.normalize('a/../../..'), '../..');

  assert.equal(libUtil.normalize('/.'), '/');
  assert.equal(libUtil.normalize('/./'), '/');
  assert.equal(libUtil.normalize('/./././.'), '/');
  assert.equal(libUtil.normalize('/././././a/b/c'), '/a/b/c');
  assert.equal(libUtil.normalize('/a/b/c/./././d/././e'), '/a/b/c/d/e');

  assert.equal(libUtil.normalize(''), '.');
  assert.equal(libUtil.normalize('.'), '.');
  assert.equal(libUtil.normalize('./'), '.');
  assert.equal(libUtil.normalize('././a'), 'a');
  assert.equal(libUtil.normalize('a/./'), 'a/');
  assert.equal(libUtil.normalize('a/././.'), 'a');

  assert.equal(libUtil.normalize('/a/b//c////d/////'), '/a/b/c/d/');
  assert.equal(libUtil.normalize('///a/b//c////d/////'), '///a/b/c/d/');
  assert.equal(libUtil.normalize('a/b//c////d'), 'a/b/c/d');

  assert.equal(libUtil.normalize('.///.././../a/b//./..'), '../../a')

  assert.equal(libUtil.normalize('http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.normalize('http://www.example.com/'), 'http://www.example.com/');
  assert.equal(libUtil.normalize('http://www.example.com/./..//a/b/c/.././d//'), 'http://www.example.com/a/b/d/');
});

test('test join()', () => {
  assert.equal(libUtil.join('a', 'b'), 'a/b');
  assert.equal(libUtil.join('a/', 'b'), 'a/b');
  assert.equal(libUtil.join('a//', 'b'), 'a/b');
  assert.equal(libUtil.join('a', 'b/'), 'a/b/');
  assert.equal(libUtil.join('a', 'b//'), 'a/b/');
  assert.equal(libUtil.join('a/', '/b'), '/b');
  assert.equal(libUtil.join('a//', '//b'), '//b');

  assert.equal(libUtil.join('a', '..'), '.');
  assert.equal(libUtil.join('a', '../b'), 'b');
  assert.equal(libUtil.join('a/b', '../c'), 'a/c');

  assert.equal(libUtil.join('a', '.'), 'a');
  assert.equal(libUtil.join('a', './b'), 'a/b');
  assert.equal(libUtil.join('a/b', './c'), 'a/b/c');

  assert.equal(libUtil.join('a', 'http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('a', 'data:foo,bar'), 'data:foo,bar');


  assert.equal(libUtil.join('', 'b'), 'b');
  assert.equal(libUtil.join('.', 'b'), 'b');
  assert.equal(libUtil.join('', 'b/'), 'b/');
  assert.equal(libUtil.join('.', 'b/'), 'b/');
  assert.equal(libUtil.join('', 'b//'), 'b/');
  assert.equal(libUtil.join('.', 'b//'), 'b/');

  assert.equal(libUtil.join('', '..'), '..');
  assert.equal(libUtil.join('.', '..'), '..');
  assert.equal(libUtil.join('', '../b'), '../b');
  assert.equal(libUtil.join('.', '../b'), '../b');

  assert.equal(libUtil.join('', '.'), '.');
  assert.equal(libUtil.join('.', '.'), '.');
  assert.equal(libUtil.join('', './b'), 'b');
  assert.equal(libUtil.join('.', './b'), 'b');

  assert.equal(libUtil.join('', 'http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('.', 'http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('', 'data:foo,bar'), 'data:foo,bar');
  assert.equal(libUtil.join('.', 'data:foo,bar'), 'data:foo,bar');


  assert.equal(libUtil.join('..', 'b'), '../b');
  assert.equal(libUtil.join('..', 'b/'), '../b/');
  assert.equal(libUtil.join('..', 'b//'), '../b/');

  assert.equal(libUtil.join('..', '..'), '../..');
  assert.equal(libUtil.join('..', '../b'), '../../b');

  assert.equal(libUtil.join('..', '.'), '..');
  assert.equal(libUtil.join('..', './b'), '../b');

  assert.equal(libUtil.join('..', 'http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('..', 'data:foo,bar'), 'data:foo,bar');


  assert.equal(libUtil.join('a', ''), 'a');
  assert.equal(libUtil.join('a', '.'), 'a');
  assert.equal(libUtil.join('a/', ''), 'a');
  assert.equal(libUtil.join('a/', '.'), 'a');
  assert.equal(libUtil.join('a//', ''), 'a');
  assert.equal(libUtil.join('a//', '.'), 'a');
  assert.equal(libUtil.join('/a', ''), '/a');
  assert.equal(libUtil.join('/a', '.'), '/a');
  assert.equal(libUtil.join('', ''), '.');
  assert.equal(libUtil.join('.', ''), '.');
  assert.equal(libUtil.join('.', ''), '.');
  assert.equal(libUtil.join('.', '.'), '.');
  assert.equal(libUtil.join('..', ''), '..');
  assert.equal(libUtil.join('..', '.'), '..');
  assert.equal(libUtil.join('http://foo.org/a', ''), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a', '.'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a/', ''), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a/', '.'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a//', ''), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a//', '.'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org', ''), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org', '.'), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org/', ''), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org/', '.'), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org//', ''), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org//', '.'), 'http://foo.org/');
  assert.equal(libUtil.join('//www.example.com', ''), '//www.example.com/');
  assert.equal(libUtil.join('//www.example.com', '.'), '//www.example.com/');


  assert.equal(libUtil.join('http://foo.org/a', 'b'), 'http://foo.org/a/b');
  assert.equal(libUtil.join('http://foo.org/a/', 'b'), 'http://foo.org/a/b');
  assert.equal(libUtil.join('http://foo.org/a//', 'b'), 'http://foo.org/a/b');
  assert.equal(libUtil.join('http://foo.org/a', 'b/'), 'http://foo.org/a/b/');
  assert.equal(libUtil.join('http://foo.org/a', 'b//'), 'http://foo.org/a/b/');
  assert.equal(libUtil.join('http://foo.org/a/', '/b'), 'http://foo.org/b');
  assert.equal(libUtil.join('http://foo.org/a//', '//b'), 'http://b');

  assert.equal(libUtil.join('http://foo.org/a', '..'), 'http://foo.org/');
  assert.equal(libUtil.join('http://foo.org/a', '../b'), 'http://foo.org/b');
  assert.equal(libUtil.join('http://foo.org/a/b', '../c'), 'http://foo.org/a/c');

  assert.equal(libUtil.join('http://foo.org/a', '.'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/a', './b'), 'http://foo.org/a/b');
  assert.equal(libUtil.join('http://foo.org/a/b', './c'), 'http://foo.org/a/b/c');

  assert.equal(libUtil.join('http://foo.org/a', 'http://www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('http://foo.org/a', 'data:foo,bar'), 'data:foo,bar');


  assert.equal(libUtil.join('http://foo.org', 'a'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/', 'a'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org//', 'a'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org', '/a'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org/', '/a'), 'http://foo.org/a');
  assert.equal(libUtil.join('http://foo.org//', '/a'), 'http://foo.org/a');


  assert.equal(libUtil.join('http://', 'www.example.com'), 'http://www.example.com');
  assert.equal(libUtil.join('file:///', 'www.example.com'), 'file:///www.example.com');
  assert.equal(libUtil.join('http://', 'ftp://example.com'), 'ftp://example.com');

  assert.equal(libUtil.join('http://www.example.com', '//foo.org/bar'), 'http://foo.org/bar');
  assert.equal(libUtil.join('//www.example.com', '//foo.org/bar'), '//foo.org/bar');
});

// TODO Issue #128: Define and test this function properly.
test('test relative()', () => {
  assert.equal(libUtil.relative('/the/root', '/the/root/one.js'), 'one.js');
  assert.equal(libUtil.relative('http://the/root', 'http://the/root/one.js'), 'one.js');
  assert.equal(libUtil.relative('/the/root', '/the/rootone.js'), '../rootone.js');
  assert.equal(libUtil.relative('http://the/root', 'http://the/rootone.js'), '../rootone.js');
  assert.equal(libUtil.relative('/the/root', '/therootone.js'), '/therootone.js');
  assert.equal(libUtil.relative('http://the/root', '/therootone.js'), '/therootone.js');

  assert.equal(libUtil.relative('', '/the/root/one.js'), '/the/root/one.js');
  assert.equal(libUtil.relative('.', '/the/root/one.js'), '/the/root/one.js');
  assert.equal(libUtil.relative('', 'the/root/one.js'), 'the/root/one.js');
  assert.equal(libUtil.relative('.', 'the/root/one.js'), 'the/root/one.js');

  assert.equal(libUtil.relative('/', '/the/root/one.js'), 'the/root/one.js');
  assert.equal(libUtil.relative('/', 'the/root/one.js'), 'the/root/one.js');
});

test('test computeSourceURL', () => {
  // Tests with sourceMapURL.
  assert.equal(libUtil.computeSourceURL('', 'src/test.js', 'http://example.com'),
               'http://example.com/src/test.js');
  assert.equal(libUtil.computeSourceURL(undefined, 'src/test.js', 'http://example.com'),
               'http://example.com/src/test.js');
  assert.equal(libUtil.computeSourceURL('src', 'test.js', 'http://example.com'),
               'http://example.com/src/test.js');
  assert.equal(libUtil.computeSourceURL('src/', 'test.js', 'http://example.com'),
               'http://example.com/src/test.js');
  assert.equal(libUtil.computeSourceURL('src', '/test.js', 'http://example.com'),
               'http://example.com/src/test.js');
  assert.equal(libUtil.computeSourceURL('http://mozilla.com', 'src/test.js', 'http://example.com'),
               'http://mozilla.com/src/test.js');
  assert.equal(libUtil.computeSourceURL('', 'test.js', 'http://example.com/src/test.js.map'),
               'http://example.com/src/test.js');

  // Legacy code won't pass in the sourceMapURL.
  assert.equal(libUtil.computeSourceURL('', 'src/test.js'), 'src/test.js');
  assert.equal(libUtil.computeSourceURL(undefined, 'src/test.js'), 'src/test.js');
  assert.equal(libUtil.computeSourceURL('src', 'test.js'), 'src/test.js');
  assert.equal(libUtil.computeSourceURL('src/', 'test.js'), 'src/test.js');
  assert.equal(libUtil.computeSourceURL('src', '/test.js'), 'src/test.js');
  assert.equal(libUtil.computeSourceURL('src', '../test.js'), 'test.js');
  assert.equal(libUtil.computeSourceURL('src/dir', '../././../test.js'), 'test.js');

  // This gives different results with the old algorithm and the new
  // spec-compliant algorithm.
  assert.equal(libUtil.computeSourceURL('http://example.com/dir', '/test.js'),
               'http://example.com/dir/test.js');
});

function mapping(o) {
  return Object.assign({
    source: 'a.js',
    originalLine: 1,
    originalColumn: 0,
    generatedLine: 1,
    generatedColumn: 0,
    name: null,
  }, o);
}

test('compareByOriginalPositions falls through to generated cols/lines and name', () => {
  var cmp = libUtil.compareByOriginalPositions;
  var base = mapping({});

  // Equal source/originalLine/originalColumn: differ on generatedColumn.
  assert.ok(cmp(mapping({ generatedColumn: 1 }), base) > 0);
  assert.ok(cmp(base, mapping({ generatedColumn: 1 })) < 0);

  // onlyCompareOriginal short-circuits before generated comparisons.
  assert.equal(cmp(mapping({ generatedColumn: 1 }), base, true), 0);

  // Differ on generatedLine.
  assert.ok(cmp(mapping({ generatedLine: 2 }), base) > 0);
  assert.ok(cmp(base, mapping({ generatedLine: 2 })) < 0);

  // Differ on name.
  assert.ok(cmp(mapping({ name: 'b' }), mapping({ name: 'a' })) > 0);
  assert.ok(cmp(mapping({ name: 'a' }), mapping({ name: 'b' })) < 0);
  assert.equal(cmp(mapping({ name: 'a' }), mapping({ name: 'a' })), 0);
});

test('compareByOriginalPositions handles null sources via strcmp', () => {
  var cmp = libUtil.compareByOriginalPositions;
  // strcmp's null branches: null is "greater than" any string.
  assert.ok(cmp(mapping({ source: null }), mapping({ source: 'a.js' })) > 0);
  assert.ok(cmp(mapping({ source: 'a.js' }), mapping({ source: null })) < 0);
  assert.equal(cmp(mapping({ source: null }), mapping({ source: null })), 0);
});

test('compareByOriginalPositionsNoSource compares generated cols/lines and name', () => {
  var cmp = libUtil.compareByOriginalPositionsNoSource;
  var base = mapping({ source: 'ignored' });

  // onlyCompareOriginal short-circuits.
  assert.equal(cmp(mapping({ generatedColumn: 1 }), base, true), 0);

  // Differ on generatedColumn.
  assert.ok(cmp(mapping({ generatedColumn: 1 }), base) > 0);

  // Differ on generatedLine.
  assert.ok(cmp(mapping({ generatedLine: 2 }), base) > 0);

  // Differ on name.
  assert.ok(cmp(mapping({ name: 'b' }), mapping({ name: 'a' })) > 0);
  assert.ok(cmp(mapping({ name: 'a' }), mapping({ name: 'b' })) < 0);
});

test('compareByGeneratedPositionsDeflated compares source, original, name', () => {
  var cmp = libUtil.compareByGeneratedPositionsDeflated;
  var base = mapping({});

  // onlyCompareGenerated short-circuits.
  assert.equal(cmp(mapping({ source: 'b.js' }), base, true), 0);

  // Differ on source (also exercises strcmp non-null path).
  assert.ok(cmp(mapping({ source: 'b.js' }), mapping({ source: 'a.js' })) > 0);

  // Differ on originalLine.
  assert.ok(cmp(mapping({ originalLine: 2 }), base) > 0);

  // Differ on originalColumn.
  assert.ok(cmp(mapping({ originalColumn: 1 }), base) > 0);

  // Differ on name.
  assert.ok(cmp(mapping({ name: 'b' }), mapping({ name: 'a' })) > 0);
});

test('compareByGeneratedPositionsDeflatedNoLine compares source, original, name', () => {
  var cmp = libUtil.compareByGeneratedPositionsDeflatedNoLine;
  var base = mapping({});

  // onlyCompareGenerated short-circuits.
  assert.equal(cmp(mapping({ source: 'b.js' }), base, true), 0);

  // Differ on source.
  assert.ok(cmp(mapping({ source: 'b.js' }), mapping({ source: 'a.js' })) > 0);

  // Differ on originalLine.
  assert.ok(cmp(mapping({ originalLine: 2 }), base) > 0);

  // Differ on originalColumn.
  assert.ok(cmp(mapping({ originalColumn: 1 }), base) > 0);

  // Differ on name.
  assert.ok(cmp(mapping({ name: 'b' }), mapping({ name: 'a' })) > 0);
});

test('compareByGeneratedPositionsInflated compares source, original, name', () => {
  var cmp = libUtil.compareByGeneratedPositionsInflated;
  var base = mapping({});

  // Differ on source.
  assert.ok(cmp(mapping({ source: 'b.js' }), mapping({ source: 'a.js' })) > 0);

  // Differ on originalLine.
  assert.ok(cmp(mapping({ originalLine: 2 }), base) > 0);

  // Differ on originalColumn.
  assert.ok(cmp(mapping({ originalColumn: 1 }), base) > 0);

  // Differ on name.
  assert.ok(cmp(mapping({ name: 'b' }), mapping({ name: 'a' })) > 0);
});
