/** Add two numbers. */
export function add(a, b) {
  return a + b;
}

/** Divide a by b. Throws RangeError when b is zero. */
export function divide(a, b) {
  if (b === 0) {
    throw new RangeError('divide by zero');
  }
  return a / b;
}

/** Percentage of whole represented by part, rounded half up to an integer. */
export function percent(part, whole) {
  return Math.round((part / whole) * 100);
}
