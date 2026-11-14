<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    startupFailureReason,
    startupRecoveryGuidance,
    startupToolLabel,
    type McpStartupStatus,
  } from '../../../shared/contracts/mcp-startup-failure.js';

  let { startup }: { startup: McpStartupStatus } = $props();
</script>

<section class="startup-details" aria-label={`${startupToolLabel(startup.serverName)} startup`}>
  {#if startup.failure}
    <p>{startupFailureReason(startup.failure.code)}</p>
    <dl>
      <div>
        <dt>Observed phase</dt>
        <dd>{startup.failure.phase}</dd>
      </div>
      <div>
        <dt>Child process</dt>
        <dd>
          Exit: {startup.failure.exitCode ?? 'Unavailable'}; signal: {startup.failure.signal ??
            'Unavailable'}.
        </dd>
      </div>
    </dl>
    {#if startup.failure.phase === 'startup'}
      <p class="secondary">
        Codex did not expose a finer startup phase. No underlying cause is established.
      </p>
    {/if}
    {#if startup.failure.exitCode === null && startup.failure.signal === null}
      <p class="secondary">Codex did not expose child exit or signal details.</p>
    {/if}
    <p>{startupRecoveryGuidance(startup.serverName)}</p>
    <details class="trace-reference">
      <summary>Trace reference</summary>
      <dl>
        <div>
          <dt>Thread</dt>
          <dd>
            <code
              >{startup.threadId ?? 'Unavailable; tool could not be attributed to a thread.'}</code
            >
          </dd>
        </div>
        <div>
          <dt>Failure</dt>
          <dd><code>{startup.failure.failureId}</code></dd>
        </div>
        <div>
          <dt>Observed at (UTC)</dt>
          <dd><time datetime={startup.observedAt}>{startup.observedAt}</time></dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd><code>{startup.attemptId}</code></dd>
        </div>
        <div>
          <dt>Relay runtime</dt>
          <dd><code>{startup.runtimeId}</code></dd>
        </div>
        <div>
          <dt>Artifact digest</dt>
          <dd><code>{startup.failure.artifactDigest ?? 'Unavailable'}</code></dd>
        </div>
      </dl>
    </details>
  {:else if startup.status === 'ready'}
    <p>
      Connection ready. Any earlier startup failures remain in the session trace and notification
      history.
    </p>
    <p class="secondary">
      Connection availability does not establish repository or language readiness.
    </p>
  {:else}
    <p>Startup is in progress. Readiness has not been established.</p>
  {/if}
</section>

<style>
  .startup-details {
    display: grid;
    gap: 0.6rem;
    min-inline-size: 0;
    inline-size: 100%;
    max-inline-size: 70ch;
    font-size: 1rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  p,
  dl,
  dd {
    margin: 0;
  }
  dl {
    display: grid;
    gap: 0.4rem;
  }
  dl > div {
    display: grid;
    grid-template-columns: minmax(0, 9rem) minmax(0, 1fr);
    gap: 0.5rem;
  }
  dt,
  .secondary {
    color: var(--theme-text-muted);
  }
  dd {
    min-inline-size: 0;
  }
  code,
  time {
    font-size: 0.875em;
  }
  summary {
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  summary:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 3px;
  }
  .trace-reference[open] > dl {
    margin-block-start: 0.6rem;
  }
  @media (max-width: 32rem) {
    dl > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.1rem;
    }
  }
</style>
