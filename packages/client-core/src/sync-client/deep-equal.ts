/**
 * Whether two query results hold the same values: what `liveQuery` compares by default.
 * Primitives compare with `Object.is`; arrays, plain objects and class instances need the same
 * prototype and own properties; dates, binary data, maps and sets (in iteration order) compare
 * by content. Anything else whose state a comparison cannot see, such as a `RegExp` or an
 * `Error`, is equal only to itself, as is a function. So a miss costs a delivery at worst; only
 * `#private` fields of a class stay out of sight. Cycles are safe.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return equal(a, b, new Map());
}

function equal(a: unknown, b: unknown, seen: Map<object, Set<object>>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  // A pair met again is being compared or was equal: any difference is reported from there.
  const counterparts = seen.get(a) ?? new Set<object>();
  if (counterparts.has(b)) return true;
  seen.set(a, counterparts.add(b));

  if (ArrayBuffer.isView(a)) {
    const view = b as ArrayBufferView;
    return sameBytes(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  switch (Object.prototype.toString.call(a)) {
    case "[object Array]":
    case "[object Object]":
      break;
    case "[object Date]":
      if (!Object.is((a as Date).getTime(), (b as Date).getTime())) return false;
      break;
    case "[object ArrayBuffer]":
      return sameBytes(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));
    case "[object Map]":
    case "[object Set]":
      if (!equal([...(a as Set<unknown>)], [...(b as Set<unknown>)], seen)) return false;
      break;
    default:
      return false;
  }

  const keys = Reflect.ownKeys(a);
  if (keys.length !== Reflect.ownKeys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      equal(
        (a as Record<PropertyKey, unknown>)[key],
        (b as Record<PropertyKey, unknown>)[key],
        seen,
      ),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
