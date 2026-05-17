# Dispatcher contract tests

These tests assert that our `Agent` honors the undici `Dispatcher` contract
end-to-end. Rather than vendoring `undici/test/fixtures/`, we drive our
Agent through undici's public consumer surface (`request`, `fetch`,
`stream`, `pipeline`, `RetryHandler`) and assert the observable behavior
matches the spec.

Run with `pnpm -C packages/node exec vitest run tests/contract`.
