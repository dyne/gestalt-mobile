# Browser smoke contracts

`npm run test:e2e:smoke` protects the `@smoke` cases from the existing functional
harness. It discovers and validates the exact file/title/tag inventory before
execution, then requires thirteen first-attempt passes in a fresh JSON report.
Missing, additional, duplicate, skipped, retried or failing cases fail the command;
runner failures propagate. The command accepts only optional `--list`, so extra
filters cannot silently narrow the protection set. It uses two workers, no
retries, retained failure traces and failure screenshots.

The stable **Browser smoke** CI job runs on pull requests, main pushes and manual
dispatches. Main release depends on it. Reports, screenshots and traces under
`test-results/browser-smoke-*` are uploaded even on failure, retained for three
days. The comprehensive four-shard functional, visual evidence, real-auth and
authorization-stress lanes remain available through manual `run_slow_tests`.

The expected inventory is **13 cases**. Enumerate before execution:

```sh
npx playwright test --config playwright.smoke.config.ts --list --reporter=json
npx playwright test --config playwright.smoke.config.ts --reporter=list,json
```

Those raw Playwright commands support inspection; the CI command is the guarded
`npm run test:e2e:smoke`. Use `npm run test:e2e:smoke -- --list` for validated
discovery only. `scripts/browser-smoke-contract.mjs` owns the reviewed inventory;
update it deliberately with the selected assertions and this contract table.
The contract fixture preserves only sanitized identities/status structure from
the initial thirteen-case Playwright run. Guard tests mutate that captured
report to exercise zero/missing/extra/duplicate/skip/failure paths and test child
exit propagation without launching a browser.

Set `PLAYWRIGHT_JSON_OUTPUT_NAME` to a private report filename when retaining
either JSON report. `PLAYWRIGHT_PORT` controls the Vite port (default 4173),
`PLAYWRIGHT_OUTPUT_ID` distinguishes the `test-results/browser-smoke-*` output
directory, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` optionally selects an
installed Chrome executable. Every lane defaults to the system Chrome channel;
`PLAYWRIGHT_BROWSERS_PATH` never selects a bundled fallback. Missing Chrome fails
the run. No real provider, passkey, account, CLI or credential
is required: Vite serves the client, `mockAuthenticatedStatus` intercepts auth,
and each case installs local HTTP/WebSocket fixtures.

| Spec                      | Exact test title                                                                                       | Cases and browser assertions                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat-resilience.spec.ts` | `converges a live item through an overlapping snapshot, reconnect, and refresh (mobile)` / `(desktop)` | 2: send through the composer, assert the sent turn payload, display an intermediate streamed delta, reconcile overlapping history, reconnect a closed socket, retain one prompt/answer, and reload canonical history in order. |
| `interactions.spec.ts`    | `retries a failed quiz once and suppresses a duplicate accepted request (mobile)` / `(desktop)`        | 2: choose an answer, assert queued prompt and interaction payloads, retain the selection after a failed response, retry once, render resolved answers and assert exact delivery counts.                                        |
| `chat-cache.spec.ts`      | `upgrades v2 storage and restores redacted chat on reload before authoritative reconciliation`         | 1: migrate actual Chromium IndexedDB, preserve settings/drafts, redact sensitive cached values, reload with history held, display the cached prompt, then replace it with exactly one authoritative prompt/answer.             |
| `autopilot-ui.spec.ts`    | `keyboard toggle is idempotent and preserves focus through a socket update (mobile)` / `(desktop)`     | 2: keyboard Off/On actions, exact enabled payload order, idempotency key, rendered state and retained focus.                                                                                                                   |
| `autopilot-ui.spec.ts`    | `keyboard attention action sends safe payload without disturbing focus (mobile)` / `(desktop)`         | 2: focus the attention control, enter guidance, activate Resume with Enter, and assert the resume payload and accepted fixture response.                                                                                       |
| `autopilot-ui.spec.ts`    | `200 percent attention remains operable`                                                               | 1: focusable attention/Resume controls clear navigation, touch target size, no visible horizontal overflow and browser diagnostics.                                                                                            |
| `file-browser.spec.ts`    | `selecting a file opens the shared preview from Git and restores focus to that file`                   | 1: select `note.txt`, assert the requested preview path, render contents, close with Escape, restore focus, and reopen with Enter.                                                                                             |
| `session-start.spec.ts`   | `sends a selected named skill profile only when creating a new session`                                | 1: select `focused`, create a session, and assert the complete session request including `skillProfile: focused`.                                                                                                              |
| `kimi-provider.spec.ts`   | `restricts chat model switching to the session provider and badges kimi sessions`                      | 1: show the Kimi session/model badge, offer only Kimi models, and hide Autopilot in both Sessions and Chat.                                                                                                                    |

The four paired journeys use **390×844 mobile and 1280×800 desktop at 100%**.
The separate font-scale case uses **390×844, minimal-dark, 200%**. Cache runs at
390×844; file/profile/Kimi cases use Playwright's default 1280×720 viewport.
This is a focused sample, not a complete viewport/theme/font-scale matrix.

The browser lane asserts client behavior against intercepted relay contracts;
it does not prove real provider processing, server authorization or durability.
The existing server test
`src/server/features/autopilot/toggle/endpoint.test.ts` →
`rejects kimi session toggles in both directions` asserts real endpoint rejection
for both enable and disable (`409 AUTOPILOT_PROVIDER_UNSUPPORTED`) and preserves
the Codex plan-required response. Its focused command is:

```sh
npx vitest run src/server/features/autopilot/toggle/endpoint.test.ts -t 'rejects kimi session toggles in both directions'
```

In restricted host runs, direct `AUTOPILOT_EVIDENCE_DIR` to an owned evidence
directory; its selected font-scale case writes
`zoom200-attention-390x844-dark.png` there. Other screenshots and traces use each
test's unique Playwright output directory, including the viewport in paired
test identities. The broader harness also supports `PLAYWRIGHT_EVIDENCE_DIR`,
`ACTIVITY_EVIDENCE_DIR`, `SESSIONS_EVIDENCE_DIR` and `EFFICIENCY_EVIDENCE_DIR` for
their respective specs; these are useful when running the full suite.
