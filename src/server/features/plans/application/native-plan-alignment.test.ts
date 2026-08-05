import { describe, expect, it } from 'vitest';
import { NativePlanAlignmentRegistry } from './native-plan-alignment.js';

const plan = { title: 'Roadmap', totalSteps: 1, doneSteps: 0, allDone: false, currentStepId: 'l1', steps: [{ id: 'l1', title: 'Ship', level: 1 as const, state: 'WIP' as const, priority: 'A' as const, reviewStatus: 'UNREVIEWED' as const, description: {}, children: [] }] };

describe('NativePlanAlignmentRegistry', () => {
  it('compares only the owning thread and never changes the plan', () => {
    const registry = new NativePlanAlignmentRegistry();
    registry.replace('session-1', plan);
    expect(registry.read('session-1')).toBe('unknown');
    expect(registry.observe('session-1', 'thread-1', { threadId: 'other', plan: [] })).toBe('unknown');
    expect(registry.observe('session-1', 'thread-1', { threadId: 'thread-1', plan: [{ step: 'L1 1/1 — Ship', status: 'inProgress' }] })).toBe('aligned');
    expect(registry.observe('session-1', 'thread-1', { threadId: 'thread-1', plan: [{ step: 'L1 1/1 — Ship', status: 'completed' }] })).toBe('stale');
    registry.clear('session-1'); expect(registry.read('session-1')).toBe('unknown');
  });
});
