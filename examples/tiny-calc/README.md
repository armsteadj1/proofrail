# tiny-calc

A three-function calculator used as the Proofrail example and test fixture.

`divide(a, b)` throws on a zero divisor. `percent(part, whole)` rounds half up.

From the repository root:

```sh
node dist/cli.js verify examples/tiny-calc
```

The least-proven claim is `percent-rounds-half-up`: its only executable proof
expects a test named "percent rounds half up" that does not exist yet. Add that
test to `test/calc.test.js`, then run:

```sh
node dist/cli.js recheck percent-rounds-half-up examples/tiny-calc
```
