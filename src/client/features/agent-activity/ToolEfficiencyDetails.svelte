<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type {
    EfficiencyTotal,
    ToolEfficiencyGroup,
    ToolEfficiencySnapshot,
  } from '../../../shared/contracts/tool-efficiency.js';
  import type { AgentActivitySnapshot } from './contracts.js';

  let {
    sessionId,
    snapshot = null,
    activity = null,
  }: {
    sessionId: string;
    snapshot?: ToolEfficiencySnapshot | null;
    activity?: AgentActivitySnapshot | null;
  } = $props();
  const current = $derived(snapshot?.sessionId === sessionId ? snapshot : null);
  const families: Record<ToolEfficiencyGroup['family'], string> = {
    command: 'Commands',
    mcp: 'MCP tools',
    contextMode: 'Context-mode',
    executionWrapper: 'Execution wrappers',
    dynamic: 'Dynamic tools',
    collaboration: 'Collaboration',
  };
  const runtimes = $derived([...new Set(current?.groups.map((group) => group.runtimeId) ?? [])]);
  function actor(group: ToolEfficiencyGroup): string {
    if (group.actor === 'root') return 'Root (l0)';
    const child =
      activity?.sessionId === sessionId
        ? activity.subagents.find((child) => child.id === group.threadId)
        : undefined;
    return group.actor === 'child'
      ? `Child (${child?.canonicalTaskName ?? child?.nickname ?? group.threadId})`
      : 'Unknown actor';
  }
  function amount(total: EfficiencyTotal, unit = ''): string {
    return total.value === null
      ? 'Unknown'
      : `${total.value.toLocaleString()}${unit ? ` ${unit}` : ''}`;
  }
  function coverage(total: EfficiencyTotal, calls: number): string {
    return `${total.measuredCalls} of ${calls} calls measured${total.coverage === 'partial' ? ' · partial' : ''}`;
  }
  function byteScope(group: ToolEfficiencyGroup): string {
    return group.deliveredScope === 'commandOutputUtf8'
      ? 'Command output, UTF-8'
      : group.deliveredScope === 'serializedMcpContent'
        ? 'Serialized MCP content'
        : group.deliveredScope === 'serializedDynamicContent'
          ? 'Serialized dynamic content'
          : 'Result scope unknown';
  }
  function completeness(value: ToolEfficiencyGroup['completeness']['capture']): string {
    return `${value.complete} complete · ${value.partial} partial · ${value.unknown} unknown · ${value.missing} unmeasured`;
  }
</script>

<section class="tool-efficiency" aria-label="Tool efficiency">
  <details>
    <summary
      >Tool efficiency <span
        >{current?.coverage === 'partial' ? 'Partial coverage' : 'No measurements yet'}</span
      ></summary
    >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The bounded observations region needs keyboard scrolling.) -->
    <div class="observations" role="region" aria-label="Tool efficiency observations" tabindex="0">
      <p>Observed calls only. Provider usage is tracked separately.</p>
      {#if current?.missingCorrelation}<p>
          Some events could not be attributed to an agent and are excluded.
        </p>{/if}
      {#if current?.retentionLimited}<p>
          Observation retention is limited. Additional calls are excluded.
        </p>{/if}
      {#if current?.groups.length}
        <ul>
          {#each current.groups as group (JSON.stringify( [group.runtimeId, group.threadId, group.actor, group.family] ))}
            <li>
              <h3>{actor(group)} · {families[group.family]}</h3>
              <p class="scope">
                Runtime {runtimes.indexOf(group.runtimeId) + 1} · {group.layer === 'wrapper'
                  ? 'Wrapper scope'
                  : 'Tool scope'} · {group.calls} observed {group.calls === 1 ? 'call' : 'calls'} · {group.completedCalls}
                completed · {group.failedCalls} failed
              </p>
              <dl>
                <div>
                  <dt>Duration</dt>
                  <dd>
                    <span>{amount(group.durationMs, 'ms')}</span><small
                      >{coverage(group.durationMs, group.calls)}</small
                    >
                  </dd>
                </div>
                <div>
                  <dt>Delivered bytes</dt>
                  <dd>
                    <span>{amount(group.deliveredBytes, 'B')}</span><small
                      >{byteScope(group)} · {coverage(group.deliveredBytes, group.calls)}</small
                    >
                  </dd>
                </div>
              </dl>
              <details class="quality">
                <summary>Quality and counters</summary>
                <dl>
                  {#each [{ name: 'Raw bytes', total: group.rawBytes, unit: 'B' }, { name: 'Processed bytes', total: group.processedBytes, unit: 'B' }, { name: 'Truncated calls', total: group.truncatedCalls, unit: '' }, { name: 'Retries', total: group.retries, unit: '' }, { name: 'Reused calls', total: group.reusedCalls, unit: '' }] as metric (metric.name)}
                    <div>
                      <dt>{metric.name}</dt>
                      <dd>
                        {amount(metric.total, metric.unit)}<small
                          >{coverage(metric.total, group.calls)}</small
                        >
                      </dd>
                    </div>
                  {/each}
                </dl>
                <dl class="completeness">
                  {#each ['capture', 'display', 'evidence'] as scope (scope)}
                    <div>
                      <dt>{scope[0].toUpperCase() + scope.slice(1)} completeness</dt>
                      <dd>
                        {completeness(
                          group.completeness[scope as keyof ToolEfficiencyGroup['completeness']],
                        )}
                      </dd>
                    </div>
                  {/each}
                </dl>
              </details>
            </li>
          {/each}
        </ul>
        <p>
          Byte scopes are separate. Wrapper and tool measurements can overlap; they are not added
          together.
        </p>
      {:else}
        <p>
          No measured tool calls yet. Older activity and calls without correlation may have no
          measurements.
        </p>
      {/if}
      {#if current?.observedAt}<p class="scope">
          Last observation <time datetime={current.observedAt}
            >{new Date(current.observedAt).toLocaleString()}</time
          >
        </p>{/if}
    </div>
  </details>
</section>

<style>
  .tool-efficiency {
    min-inline-size: 0;
    max-inline-size: 100%;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    padding-block: 0.5rem;
    box-sizing: border-box;
  }
  summary > span {
    color: var(--theme-text-muted);
    margin-inline-start: 0.5rem;
  }
  .observations {
    max-block-size: min(28rem, 60vh);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem;
    border-block-start: 1px solid var(--theme-border);
  }
  .observations:focus-visible {
    outline-offset: -3px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    padding-block: 1rem;
    border-block-end: 1px solid var(--theme-border);
  }
  h3 {
    font-size: 1rem;
    line-height: 1.4;
    margin: 0 0 0.35rem;
  }
  p {
    max-inline-size: 70ch;
    margin: 0 0 0.75rem;
    line-height: 1.5;
  }
  .scope,
  small {
    color: var(--theme-text-muted);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    gap: 0.75rem 1.25rem;
    margin: 0.75rem 0;
  }
  dl > div {
    min-inline-size: 0;
  }
  dt {
    font-weight: 600;
    margin-block-end: 0.15rem;
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  small {
    display: block;
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .completeness {
    display: block;
  }
  .completeness > div {
    margin-block: 0.6rem;
  }
</style>
