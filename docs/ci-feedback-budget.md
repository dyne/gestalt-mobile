# CI feedback budget

The required pull-request path runs quality, Vitest, build, four isolated browser-functional shards, package smoke, and the serial real-auth journey concurrently. Release waits for every required result.

The browser-functional inventory is mechanically checked as 163 tests across four shards (47, 37, 43, and 36 tests). Each shard has a separate runner, port (4173–4176), Playwright result directory, and failed-trace artifact name.

The prior serial Verify job took about 6 minutes 28 seconds, including about 4 minutes 40 seconds of browser execution. The expected critical path is the slowest independent required lane rather than their sum. Treat a required lane exceeding 7 minutes, or browser shard imbalance above 50%, as a regression to investigate.

Scheduled or manually dispatched CI retains exhaustive browser evidence and authorization-stress JSON for 14 days. Real-auth artifacts are retained for 14 days on every run; failed functional traces are retained for 3 days.
