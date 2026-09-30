/* -*- Mode: js; js-indent-level: 2; -*- */
/*
 * Copyright 2011 Mozilla Foundation and contributors
 * Licensed under the New BSD license. See LICENSE or:
 * http://opensource.org/licenses/BSD-3-Clause
 */

var intToCharMap = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');

// Lookup table: base64 char code -> 6-bit value. Invalid chars hold 255 as a sentinel.
// Exported so the VLQ decoder can index it directly without a function call.
var charToIntMap = new Uint8Array(128);
charToIntMap.fill(255);
for (var i = 0; i < 64; i++) {
  charToIntMap[intToCharMap[i].charCodeAt(0)] = i;
}
exports.charToIntMap = charToIntMap;

/**
 * Encode an integer in the range of 0 to 63 to a single base 64 digit.
 */
exports.encode = function (number) {
  if (0 <= number && number < intToCharMap.length) {
    return intToCharMap[number];
  }
  throw new TypeError("Must be between 0 and 63: " + number);
};

/**
 * Decode a single base 64 character code digit to an integer. Returns -1 on
 * failure.
 */
exports.decode = function (charCode) {
  if (charCode >= 0 && charCode < 128) {
    var v = charToIntMap[charCode];
    if (v !== 255) {
      return v;
    }
  }
  return -1;
};
