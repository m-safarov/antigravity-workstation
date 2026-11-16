import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseJsonc } = require('../lib/jsonc.js');

test('stripJsonComments removes single line and multi line comments', () => {
  const input = `
  {
    // Single line comment
    "key": "value", /* inline comment */
    /*
      multi line
      comment
    */
    "escaped": "http://example.com" // url test
  }
  `;
  const parsed = parseJsonc(input);
  assert.equal(parsed.key, 'value');
  assert.equal(parsed.escaped, 'http://example.com');
});

test('parseJsonc handles trailing commas', () => {
  const input = `{ "a": 1, "b": [1, 2, ], }`;
  const parsed = parseJsonc(input);
  assert.equal(parsed.a, 1);
  assert.deepEqual(parsed.b, [1, 2]);
});

test('JSONC preserves comma/closing-bracket text, escaped quotes and BOM', () => {
  const text = '\uFEFF{"custom":"a,}","other":"b,]","escaped":"\\\"c,}","array":[1,],}';
  assert.deepEqual(parseJsonc(text), { custom: 'a,}', other: 'b,]', escaped: '"c,}', array: [1] });
  assert.throws(() => parseJsonc('{"value":1/* comment */2}'), /parse error/);
});
