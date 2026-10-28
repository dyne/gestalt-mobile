/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PlanModelId, PlanModelPolicy } from '../domain/supervised-plan.js';
import { validPlanModel, validPlanEffort } from '../domain/supervised-plan.js';

const required = [
  'MODEL',
  'REASONING_EFFORT',
  'MODEL_RATIONALE',
  'MODEL_FALLBACKS',
  'MODEL_ESCALATION_TRIGGER',
];
const exception = [
  'EFFORT_NECESSITY_KIND',
  'EFFORT_NECESSITY',
  'EFFORT_EVIDENCE',
  'EFFORT_SCOPE',
  'RETURN_TO_MEDIUM',
  'SCOPE_REASSESSMENT',
];

/** Same schema as Agents model-policy-v1; no catalog or effective-setting inference. */
export function parseModelPolicy(
  properties: ReadonlyMap<string, string>,
  level: 1 | 2,
  version: 1 | undefined,
): PlanModelPolicy | undefined {
  const declared = [...required, ...exception].filter((key) => properties.has(key));
  const invalid = () => {
    throw new Error('INVALID_MODEL_POLICY');
  };
  if (properties.has('MODEL_POLICY_VERSION') || properties.has('MODEL_POLICY_ASSURANCE')) invalid();
  if (declared.length && (level === 2 || version === undefined)) invalid();
  if (version === undefined || level === 2) return undefined;
  if (required.some((key) => !properties.get(key)?.trim())) invalid();
  if (
    declared.some(
      (key) =>
        !properties.get(key)!.trim() || Buffer.byteLength(properties.get(key)!, 'utf8') > 1024,
    )
  )
    invalid();
  const model = properties.get('MODEL')!;
  const reasoningEffort = properties.get('REASONING_EFFORT')!;
  if (!validPlanModel(model) || !validPlanEffort(reasoningEffort)) invalid();
  const rawFallbacks = properties.get('MODEL_FALLBACKS')!;
  const allowedFallbacks = rawFallbacks === 'none' ? [] : rawFallbacks.split(' ');
  if (
    allowedFallbacks.some((id) => !validPlanModel(id) || id === model) ||
    new Set(allowedFallbacks).size !== allowedFallbacks.length
  )
    invalid();
  let necessity: PlanModelPolicy['necessity'] = null;
  if (reasoningEffort === 'medium') {
    if (exception.some((key) => properties.has(key))) invalid();
  } else if (exception.some((key) => properties.has(key))) {
    if (
      exception.slice(0, 5).some((key) => !properties.get(key)?.trim()) ||
      !['unresolved-correctness', 'specific-reasoning'].includes(
        properties.get('EFFORT_NECESSITY_KIND')!,
      ) ||
      (reasoningEffort === 'xhigh' && !properties.get('SCOPE_REASSESSMENT')?.trim())
    )
      invalid();
    necessity = Object.freeze({
      kind: properties.get('EFFORT_NECESSITY_KIND') as NonNullable<
        PlanModelPolicy['necessity']
      >['kind'],
      whyMediumInadequate: properties.get('EFFORT_NECESSITY')!,
      evidence: properties.get('EFFORT_EVIDENCE')!,
      affectedScope: properties.get('EFFORT_SCOPE')!,
      returnToMedium: properties.get('RETURN_TO_MEDIUM')!,
      ...(properties.has('SCOPE_REASSESSMENT')
        ? { scopeReassessment: properties.get('SCOPE_REASSESSMENT')! }
        : {}),
    });
  }
  return Object.freeze({
    version: 1,
    model: model as PlanModelId,
    reasoningEffort: reasoningEffort as PlanModelPolicy['reasoningEffort'],
    rationale: properties.get('MODEL_RATIONALE')!,
    allowedFallbacks: Object.freeze(allowedFallbacks as PlanModelId[]),
    escalationTrigger: properties.get('MODEL_ESCALATION_TRIGGER')!,
    necessity,
  });
}
