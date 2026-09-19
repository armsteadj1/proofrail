import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, divide } from '../src/calc.js';

test('add is commutative', () => {
  assert.equal(add(2, 3), add(3, 2));
});

test('divide returns the quotient', () => {
  assert.equal(divide(10, 4), 2.5);
});
