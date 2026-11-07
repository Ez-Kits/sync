import { expect, test } from "vite-plus/test";
import { deepEqual } from "../src/sync-client/deep-equal";

class Todo {
  relation?: Todo;
  constructor(public id: number) {}
}
class Other {
  constructor(public id: number) {}
}

test.each<[string, unknown, unknown]>([
  ["numbers", 1, 1],
  ["NaN", Number.NaN, Number.NaN],
  ["null", null, null],
  ["undefined", undefined, undefined],
  ["arrays", [1, [2]], [1, [2]]],
  ["plain objects in any key order", { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }],
  ["null-prototype objects", Object.create(null), Object.create(null)],
  ["class instances", new Todo(1), new Todo(1)],
  ["dates", new Date(1), new Date(1)],
  ["invalid dates", new Date(Number.NaN), new Date(Number.NaN)],
  ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  [
    "views over different offsets",
    new Uint8Array([0, 1]).subarray(1),
    new Uint8Array([1, 9]).subarray(0, 1),
  ],
  ["data views", new DataView(new ArrayBuffer(2)), new DataView(new ArrayBuffer(2))],
  ["array buffers", new Uint8Array([1]).buffer, new Uint8Array([1]).buffer],
  ["maps", new Map([[{ a: 1 }, [1]]]), new Map([[{ a: 1 }, [1]]])],
  ["sets", new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  ["symbol keys", { [Symbol.for("k")]: 1 }, { [Symbol.for("k")]: 1 }],
])("%s are equal", (_name, a, b) => {
  expect(deepEqual(a, b)).toBe(true);
});

test.each<[string, unknown, unknown]>([
  ["different primitives", 1, 2],
  ["+0 and -0", 0, -0],
  ["null and an object", null, {}],
  ["an object and null", {}, null],
  ["a primitive and an object", 1, {}],
  ["array lengths", [1], [1, 2]],
  ["array items", [1, [2]], [1, [3]]],
  ["a hole and undefined", Object.assign([], { length: 1 }), [undefined]],
  ["an array and an object", [], {}],
  ["missing keys", { a: 1 }, { b: 1 }],
  ["an undefined value and a missing key", { a: undefined, b: 1 }, { b: 1, c: undefined }],
  ["key counts", { a: 1 }, { a: 1, b: 1 }],
  ["values", { a: { b: 1 } }, { a: { b: 2 } }],
  ["class instances by value", new Todo(1), new Todo(2)],
  ["classes", new Todo(1), new Other(1)],
  ["a class and a plain object", new Todo(1), { id: 1 }],
  ["dates", new Date(1), new Date(2)],
  ["typed array bytes", new Uint8Array([1]), new Uint8Array([2])],
  ["typed array lengths", new Uint8Array([1]), new Uint8Array([1, 2])],
  ["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
  ["array buffers", new Uint8Array([1]).buffer, new Uint8Array([2]).buffer],
  ["map sizes", new Map([[1, 1]]), new Map()],
  ["map values", new Map([[1, 1]]), new Map([[1, 2]])],
  ["map keys", new Map([[1, 1]]), new Map([[2, 1]])],
  [
    "map order",
    new Map([
      [1, 1],
      [2, 2],
    ]),
    new Map([
      [2, 2],
      [1, 1],
    ]),
  ],
  ["set sizes", new Set([1]), new Set()],
  ["set values", new Set([1]), new Set([2])],
  ["set order", new Set([1, 2]), new Set([2, 1])],
  ["a function per object", { f: () => 1 }, { f: () => 1 }],
  ["regular expressions, whose state is hidden", /a/, /a/],
  ["errors, whose state is hidden", new Error("a"), new Error("a")],
  ["boxed values, whose state is hidden", Object(1), Object(1)],
  ["weak maps, whose state is hidden", new WeakMap(), new WeakMap()],
])("%s differ", (_name, a, b) => {
  expect(deepEqual(a, b)).toBe(false);
});

test("the same object is equal to itself, whatever it holds", () => {
  const value = { a: /x/ };
  expect(deepEqual(value, value)).toBe(true);
  // Which is why a result mutated in place compares equal.
  const rows = [1];
  const same = rows;
  rows.push(2);
  expect(deepEqual(rows, same)).toBe(true);
});

test("cycles terminate and compare by what they hold", () => {
  const cycle = (id: number, leaf: number) => {
    const parent = new Todo(id);
    const child = new Todo(leaf);
    parent.relation = child;
    child.relation = parent;
    return parent;
  };
  expect(deepEqual(cycle(1, 2), cycle(1, 2))).toBe(true);
  expect(deepEqual(cycle(1, 2), cycle(1, 3))).toBe(false);

  const selfA: unknown[] = [];
  selfA.push(selfA);
  const selfB: unknown[] = [];
  selfB.push(selfB);
  expect(deepEqual(selfA, selfB)).toBe(true);
});

test("a shared object is compared against each of its counterparts", () => {
  const shared = { id: 1 };
  expect(deepEqual([shared, shared], [{ id: 1 }, { id: 1 }])).toBe(true);
  expect(deepEqual([shared, shared], [{ id: 1 }, { id: 2 }])).toBe(false);
});
