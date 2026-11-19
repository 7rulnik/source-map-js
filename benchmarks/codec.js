'use strict';

// A small VLQ decoder for the "mappings" field. The cases use it to build
// their queries and addMapping() arguments without going through the library
// under test, so base and head always get exactly the same inputs.

const CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHAR_TO_INT = new Int8Array(128).fill(-1);
for (let i = 0; i < CHARS.length; i++) CHAR_TO_INT[CHARS.charCodeAt(i)] = i;

const COMMA = 44;
const SEMICOLON = 59;

// Returns one array per generated line. Each segment is
// [generatedColumn] or [generatedColumn, source, originalLine, originalColumn]
// or [generatedColumn, source, originalLine, originalColumn, name], with every
// field absolute and 0-based.
function decode(mappings) {
  const lines = [];
  let line = [];
  let generatedColumn = 0;
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  let pos = 0;
  const end = mappings.length;

  function readVlq() {
    let value = 0;
    let shift = 0;
    let digit;
    do {
      const code = mappings.charCodeAt(pos++);
      digit = code < 128 ? CHAR_TO_INT[code] : -1;
      if (digit < 0) {
        throw new Error(`Invalid VLQ character at offset ${pos - 1}`);
      }
      value += (digit & 31) * 2 ** shift;
      shift += 5;
    } while (digit & 32);
    return value % 2 === 1 ? -(value - 1) / 2 : value / 2;
  }

  function atSegmentEnd() {
    if (pos >= end) return true;
    const code = mappings.charCodeAt(pos);
    return code === COMMA || code === SEMICOLON;
  }

  while (pos < end) {
    const code = mappings.charCodeAt(pos);
    if (code === SEMICOLON) {
      lines.push(line);
      line = [];
      generatedColumn = 0;
      pos++;
      continue;
    }
    if (code === COMMA) {
      pos++;
      continue;
    }
    generatedColumn += readVlq();
    if (atSegmentEnd()) {
      line.push([generatedColumn]);
      continue;
    }
    source += readVlq();
    originalLine += readVlq();
    originalColumn += readVlq();
    if (atSegmentEnd()) {
      line.push([generatedColumn, source, originalLine, originalColumn]);
      continue;
    }
    name += readVlq();
    line.push([generatedColumn, source, originalLine, originalColumn, name]);
  }
  lines.push(line);
  return lines;
}

exports.decode = decode;
