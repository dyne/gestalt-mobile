/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Controlled planning only: every source mutation is emitted as an actual Native tool call.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function createProductionEditProvider(appRoot, final, report) {
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
          generations === 1 ? 'Production chosen variant' : 'Production discarded variant';
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
        after = before.replace('Production chosen variant', 'Production manual approved');
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
