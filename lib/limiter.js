'use strict';

// A fixed-window counter per source address plus one global counter. The global
// one caps the total no matter how many addresses the traffic comes from.
const GLOBAL_KEY = 'global';

function makeLimiter(perAddressLimit, globalLimit, windowMs) {
  const counts = new Map();
  const keysFor = (source) => [GLOBAL_KEY, `addr:${source}`];
  return {
    // Seconds until this source may try again, 0 when it is not blocked.
    retryAfter(source) {
      const t = Date.now();
      let wait = 0;
      for (const key of keysFor(source)) {
        const entry = counts.get(key);
        const limit = key === GLOBAL_KEY ? globalLimit : perAddressLimit;
        if (!entry || entry.count < limit) continue;
        wait = Math.max(wait, entry.start + windowMs - t);
      }
      return Math.max(0, Math.ceil(wait / 1000));
    },
    record(source) {
      const t = Date.now();
      // Dropping lapsed windows here keeps the map from growing with every address seen.
      for (const [key, entry] of counts) {
        if (t - entry.start >= windowMs) counts.delete(key);
      }
      for (const key of keysFor(source)) {
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { count: 1, start: t });
      }
    },
    // Only the source's own window: clearing the global one too would hand a
    // spread-out guesser a fresh budget every time the owner signs in.
    reset(source) {
      counts.delete(`addr:${source}`);
    },
  };
}

module.exports = { makeLimiter };
