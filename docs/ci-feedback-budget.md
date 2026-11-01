# CI feedback budget

The required pull-request path runs quality, Vitest, package smoke, and the stable Browser smoke job concurrently. Release waits for all four results. Browser smoke validates an explicit thirteen-case inventory and requires thirteen first-attempt passes; see [browser smoke contracts](browser-smoke.md).

Manual dispatch with `run_slow_tests` retains four browser-functional shards, exhaustive visual evidence, real-auth and authorization-stress lanes. Functional shard membership is mechanically checked by `npm run test:e2e:shards`; counts evolve with the suite. Each shard has a separate runner, port (4173–4176), Playwright result directory, and failed-trace artifact name.

The prior serial Verify job took about 6 minutes 28 seconds, including about 4 minutes 40 seconds of browser execution. The expected critical path is the slowest independent required lane rather than their sum. Treat a required lane exceeding 7 minutes, or browser shard imbalance above 50%, as a regression to investigate.

Manually dispatched CI retains exhaustive browser evidence, authorization-stress JSON and real-auth artifacts for 14 days; failed functional traces are retained for 3 days. Required Browser smoke JSON, screenshots and traces are retained for 3 days on every run.
