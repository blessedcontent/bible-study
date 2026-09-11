'use strict';

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"'
});

function decodeOnce(value) {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal, hexadecimal, named) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(
          decimal || hexadecimal,
          hexadecimal ? 16 : 10
        );

        if (
          !Number.isInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return match;
        }

        return String.fromCodePoint(codePoint);
      }

      return Object.hasOwn(NAMED_ENTITIES, named.toLowerCase())
        ? NAMED_ENTITIES[named.toLowerCase()]
        : match;
    }
  );
}

function decodeHtmlEntities(value) {
  let decoded = String(value);

  // A bounded repeat also repairs values that were accidentally encoded twice.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }

  return decoded;
}

module.exports = { decodeHtmlEntities };
