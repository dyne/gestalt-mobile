/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Controlled planning only: every source mutation is emitted as an actual Native tool call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function productionModelWorkload(lane) {
  assert.ok(['', 'accept-steer', 'manual-discard', 'recovery'].includes(lane));
  return lane === 'manual-discard' ? 'owning-edit-only' : 'owning-edit-and-confinement';
}

// Proof-only exact static-HTML expectation, matching the pinned helper's HTML
// tag removal. Refuse CSP/other adapters instead of guessing restoration bytes.
export function withoutProofInjection(source) {
  assert.equal(source.includes('data-impeccable-csp-original'), false);
  const pairs = [...source.matchAll(/<!--\s*impeccable-live-start\s*-->/g)];
  assert.ok(pairs.length <= 1);
  const result = source.replace(
    /([ \t]*)<!--\s*impeccable-live-start\s*-->[\s\S]*?<!--\s*impeccable-live-end\s*-->([ \t]*(?:\r\n|\n|\r|$)?)/g,
    (_all, indent, trailing) => (/[\r\n]/.test(trailing) || indent ? indent : trailing),
  );
  assert.equal(result.includes('impeccable-live-start'), false);
  assert.equal(result.includes('impeccable-live-end'), false);
  return result;
}

/** One proof-owned authenticated Stop. Expiry records an observation failure,
 * never cancels or detaches the actual operation. The returned drain is the
 * exact raw operation; a caller must join it before closing or claiming cleanup.
 */
export function failureStopOperation({
  expected,
  read,
  stop,
  verify,
  now = Date.now,
  deadline,
  evidence,
}) {
  expected = structuredClone(expected);
  let operation;
  const current = () => {
    const value = read();
    for (const key of ['liveId', 'relayId', 'rootThreadId', 'controllerEpoch', 'targetIdentity'])
      assert.equal(value.run[key], expected.run[key], 'PROOF_FAILURE_OWNER_CHANGED');
    assert.deepEqual(value.run.app, expected.run.app, 'PROOF_FAILURE_APP_CHANGED');
    assert.equal(value.captureId, expected.captureId, 'PROOF_FAILURE_CAPTURE_CHANGED');
    assert.ok(
      Number.isSafeInteger(value.run.generation) && value.run.generation >= expected.run.generation,
    );
    return value;
  };
  return () => {
    if (operation) return operation;
    const observed = {
      dispatched: false,
      pending: false,
      drained: false,
      deadlineExceeded: false,
      verified: false,
    };
    let timer;
    const drain = (async () => {
      try {
        assert.ok(Number.isFinite(deadline) && now() < deadline, 'PROOF_FAILURE_STOP_DEADLINE');
        const before = current();
        assert.ok(['active', 'recoveryRequired', 'error'].includes(before.run.state));
        const fresh = current();
        assert.deepEqual(fresh, before, 'PROOF_FAILURE_FENCE_CHANGED');
        observed.dispatched = true;
        observed.pending = true;
        timer = setTimeout(
          () => {
            observed.deadlineExceeded = true;
            evidence({ ...observed });
          },
          Math.max(1, deadline - now()),
        );
        const stopped = await stop({ liveId: fresh.run.liveId, generation: fresh.run.generation });
        observed.pending = false;
        observed.drained = true;
        assert.equal(stopped.state, 'idle');
        const after = current();
        assert.equal(after.run.state, 'idle');
        assert.equal(after.run.controlsRestored, true);
        assert.ok(now() < deadline && !observed.deadlineExceeded, 'PROOF_FAILURE_STOP_DEADLINE');
        await verify(after);
        assert.deepEqual(current(), after, 'PROOF_FAILURE_FENCE_CHANGED');
        assert.ok(now() < deadline && !observed.deadlineExceeded, 'PROOF_FAILURE_STOP_DEADLINE');
        observed.verified = true;
        evidence({ ...observed });
        return { ...observed };
      } catch (error) {
        observed.pending = false;
        observed.drained = observed.dispatched;
        evidence({ ...observed, failed: true });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    // Preserve actual settlement, including a rejection; expiry is not drainage.
    drain.catch(() => {});
    operation = { drain, observed };
    return operation;
  };
}

export function liveEventFromRequest(body) {
  const messages = (body.input ?? []).filter(
    (item) => item.type === 'message' && item.role === 'user',
  );
  for (const message of messages.reverse()) {
    for (const part of [...(message.content ?? [])].reverse()) {
      if (typeof part.text !== 'string' || part.text.length > 262144) continue;
      const line = part.text.trim().split('\n').at(-1);
      try {
        const event = JSON.parse(line);
        if (['generate', 'steer', 'manual_edit_apply', 'accept', 'discard'].includes(event.type)) {
          assert.equal(Object.hasOwn(event, 'token'), false);
          return event;
        }
      } catch (error) {
        if (error?.code === 'ERR_ASSERTION') throw error;
      }
    }
  }
  throw new Error('EDIT_EVENT_REQUEST_UNAVAILABLE');
}

function replacementPatch(file, before, after) {
  assert.notEqual(before, after);
  const oldLines = before.trimEnd().split('\n');
  const newLines = after.trimEnd().split('\n');
  let start = 0;
  while (oldLines[start] === newLines[start] && start < oldLines.length) start++;
  let end = 0;
  while (
    end < oldLines.length - start &&
    end < newLines.length - start &&
    oldLines.at(-1 - end) === newLines.at(-1 - end)
  )
    end++;
  // Keep the unrelated injected bootstrap URL (and its browser bearer) out of
  // the controlled planner response as well as out of model request payloads.
  return `*** Begin Patch\n*** Update File: ${file}\n@@\n${oldLines
    .slice(start, oldLines.length - end)
    .map((line) => `-${line}`)
    .join('\n')}\n${newLines
    .slice(start, newLines.length - end)
    .map((line) => `+${line}`)
    .join('\n')}\n*** End Patch`;
}

export function createProductionEditProvider(appRoot, final, report, { lane = '' } = {}) {
  assert.ok(['', 'accept-steer', 'manual-discard'].includes(lane), 'EDIT_PROVIDER_LANE_INVALID');
  const operations = new Map();
  let generations = 0;
  return (body, toolCall) => {
    const event = liveEventFromRequest(body);
    const key = JSON.stringify([event.type, event.id, event.message, event.batch]);
    let operation = operations.get(key);
    if (!operation) {
      let file = 'index.html';
      let before = readFileSync(join(appRoot, file), 'utf8');
      let after = before;
      let data = {};
      if (event.type === 'generate') {
        generations++;
        const scaffold = event.scaffold;
        assert.equal(scaffold?.sourceWritten, false);
        assert.equal(scaffold.file, 'index.html');
        assert.equal(event.count, 2);
        const label =
          generations === 1 && lane !== 'manual-discard'
            ? 'Production chosen variant'
            : 'Production discarded variant';
        const marker = '<!-- Variants: insert below this line -->';
        assert.ok(scaffold.wrapperBlock.includes(marker));
        const block = scaffold.wrapperBlock.replace(
          marker,
          `${marker}\n  <div data-impeccable-variant="1"><h1 class="hero-title">${label}</h1></div>\n  <div data-impeccable-variant="2"><h1 class="hero-title">${label} alternate</h1></div>`,
        );
        const lines = before.split('\n');
        after = [
          ...lines.slice(0, scaffold.replaceStartLine - 1),
          block,
          ...lines.slice(scaffold.replaceEndLine),
        ].join('\n');
      } else if (event.type === 'steer') {
        assert.ok(String(event.message).includes('production steer'));
        file = 'app.js';
        before = readFileSync(join(appRoot, file), 'utf8');
        after = before.replace("marker = 'original'", "marker = 'steered'");
      } else if (event.type === 'manual_edit_apply') {
        const entries = event.batch?.entries;
        assert.ok(Array.isArray(entries) && entries.length === 1);
        assert.equal(typeof entries[0].id, 'string');
        assert.ok(
          entries[0].ops.some((operation) => operation.newText === 'Production manual approved'),
        );
        const original = lane === 'manual-discard' ? 'Owning app' : 'Production chosen variant';
        assert.equal(before.split(original).length, 2);
        after = before.replace(original, 'Production manual approved');
        data = {
          status: 'done',
          appliedEntryIds: entries.map((entry) => entry.id),
          failed: [],
          files: [file],
          notes: [],
        };
      } else {
        assert.equal(event._acceptResult?.handled, true);
        assert.equal(event._completionAck?.ok, true);
        assert.ok(!before.includes('impeccable-variants-start'));
        assert.ok(
          before.includes(
            event.type === 'accept' ? 'Production chosen variant' : 'Production manual approved',
          ),
        );
        assert.ok(!before.includes('Production discarded variant'));
      }
      operation = { file, after, data, step: 0, changed: after !== before };
      operations.set(key, operation);
      (report.editFlowEvents ??= []).push({
        type: event.type,
        plannedSourceTool: operation.changed,
      });
      if (operation.changed) {
        operation.step++;
        return toolCall('apply_patch', replacementPatch(join(appRoot, file), before, after), true);
      }
    }
    if (operation.changed)
      assert.equal(readFileSync(join(appRoot, operation.file), 'utf8'), operation.after);
    assert.ok(operation.step <= 1);
    operation.step++;
    return final(
      `edit-${operations.size}`,
      JSON.stringify({
        status: event.type === 'steer' ? 'steer_done' : 'done',
        file: operation.file,
        data: operation.data,
      }),
    );
  };
}
