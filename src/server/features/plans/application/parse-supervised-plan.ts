/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { parseModelPolicy } from './parse-model-policy.js';

import type {
  PlanLevel,
  PlanPriority,
  PlanProjectionResult,
  PlanReviewStatus,
  PlanStep,
  PlanStepDescription,
  PlanStepMeasurement,
  PlanTodoState,
  SupervisedPlan,
} from '../domain/supervised-plan.js';

type ParsedHeading = {
  id: string;
  title: string;
  level: PlanLevel;
  state: PlanTodoState;
  priority: PlanPriority;
  properties: Map<string, string>;
  descriptions: Map<string, string>;
};

const headingPattern = /^(\*{1,2}) (TODO|WIP|DONE|SUSPENDED) \[#([ABC])\] (.+)$/;
const propertyPattern = /^:([A-Z_]+):(?:[ \t](.*))?$/;
const descriptionPattern = /^- ([A-Za-z][A-Za-z ]*?) ::(?:[ \t](.*))?$/;

/**
 * Projects only the small, validated org-plan dialect used by supervised plans.
 * `planPath` is used solely for admission control and never retained in the model.
 */
export function parseSupervisedPlan(input: {
  source: string;
  planPath: string;
  workspacePath: string;
}): PlanProjectionResult {
  if (!isPlanPathWithinWorkspace(input.planPath, input.workspacePath))
    return unavailable('PATH_OUTSIDE_WORKSPACE');

  const lines = input.source.replace(/\r\n?/g, '\n').split('\n');
  const metadata = new Map<string, string>();
  const headings: ParsedHeading[] = [];
  const declarations = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#\+MODEL_POLICY_VERSION:/i.test(line));
  const firstHeading = lines.findIndex((line) => line.startsWith('*'));
  if (
    declarations.length > 1 ||
    declarations.some(
      ({ line, index }) => line !== '#+MODEL_POLICY_VERSION: 1' || index >= firstHeading,
    )
  )
    return unavailable('INVALID_MODEL_POLICY');
  const modelPolicyVersion = declarations.length ? 1 : undefined;

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const metadataMatch = /^#\+([A-Z_]+):(?:[ \t](.*))?$/.exec(line);
    if (metadataMatch) {
      metadata.set(metadataMatch[1]!, metadataMatch[2] ?? '');
      index += 1;
      continue;
    }

    if (!line.startsWith('*')) {
      index += 1;
      continue;
    }

    const headingMatch = headingPattern.exec(line);
    if (!headingMatch) return unavailable('MALFORMED_ORG');
    const level = headingMatch[1]!.length as PlanLevel;
    const propertiesStart = lines[index + 1];
    if (propertiesStart !== ':PROPERTIES:') return unavailable('MALFORMED_ORG');

    const properties = new Map<string, string>();
    index += 2;
    let closed = false;
    for (; index < lines.length; index += 1) {
      const propertyLine = lines[index]!;
      if (propertyLine === ':END:') {
        closed = true;
        index += 1;
        break;
      }
      const property = propertyPattern.exec(propertyLine);
      if (!property || properties.has(property[1]!)) return unavailable('MALFORMED_ORG');
      properties.set(property[1]!, property[2] ?? '');
    }
    if (!closed) return unavailable('MALFORMED_ORG');

    const descriptions = new Map<string, string>();
    let descriptionKey: string | undefined;
    let blankLines = 0;
    while (index < lines.length && !lines[index]!.startsWith('*')) {
      const description = descriptionPattern.exec(lines[index]!);
      if (description) {
        const key = description[1]!;
        if (descriptions.has(key)) return unavailable('MALFORMED_ORG');
        descriptions.set(key, description[2] ?? '');
        descriptionKey = key;
        blankLines = 0;
      } else if (descriptionKey && /^[ \t]+\S/.test(lines[index]!)) {
        descriptions.set(
          descriptionKey,
          `${descriptions.get(descriptionKey)}${'\n'.repeat(blankLines + 1)}${lines[index]!.replace(/^(?:  |\t)/, '')}`,
        );
        blankLines = 0;
      } else if (lines[index]!.trim() === '') {
        blankLines += 1;
      } else if (lines[index]!.trim() !== '') {
        return unavailable('MALFORMED_ORG');
      }
      index += 1;
    }

    const id = properties.get('ID');
    if (!id) return unavailable('MISSING_REQUIRED_FIELD');
    headings.push({
      id,
      title: headingMatch[4]!,
      level,
      state: headingMatch[2]! as PlanTodoState,
      priority: headingMatch[3]! as PlanPriority,
      properties,
      descriptions,
    });
  }

  const title = metadata.get('TITLE');
  if (!title) return unavailable('MISSING_TITLE');
  if (!headings.length) return unavailable('MALFORMED_ORG');
  if (new Set(headings.map((heading) => heading.id)).size !== headings.length)
    return unavailable('DUPLICATE_ID');

  const modelPolicies = new Map<string, ReturnType<typeof parseModelPolicy>>();
  try {
    for (const heading of headings)
      modelPolicies.set(
        heading.id,
        parseModelPolicy(heading.properties, heading.level, modelPolicyVersion),
      );
  } catch {
    return unavailable('INVALID_MODEL_POLICY');
  }

  if (!hasValidSuspension(headings)) return unavailable('MALFORMED_ORG');
  if (!hasValidWipPath(headings)) return unavailable('MULTIPLE_WIP');
  const built = buildSteps(headings, modelPolicies);
  if (!built) return unavailable('MISSING_REQUIRED_FIELD');

  const allSteps = headings;
  const allDone = allSteps.every((step) => step.state === 'DONE');
  const executionComplete = built.every(
    (step) =>
      step.state === 'DONE' &&
      step.reviewStatus === 'REVIEWED' &&
      step.children.every((child) => child.state === 'DONE'),
  );
  const currentStepId = findCurrentStepId(allSteps, allDone);
  if (!currentStepId) return unavailable('MALFORMED_ORG');

  return {
    kind: 'available',
    plan: freezePlan({
      title,
      ...(metadata.has('SUBTITLE') ? { subtitle: metadata.get('SUBTITLE') } : {}),
      ...(metadata.has('DATE') ? { date: metadata.get('DATE') } : {}),
      ...(metadata.has('KEYWORDS') ? { keywords: metadata.get('KEYWORDS') } : {}),
      ...(modelPolicyVersion ? { modelPolicyVersion } : {}),
      steps: built,
      totalSteps: allSteps.length,
      doneSteps: allSteps.filter((step) => step.state === 'DONE').length,
      allDone,
      executionComplete,
      currentStepId,
    }),
  };
}

export function isPlanPathWithinWorkspace(planPath: string, workspacePath: string): boolean {
  if (!isAbsolute(planPath) || !isAbsolute(workspacePath)) return false;
  const pathWithinWorkspace = relative(resolve(workspacePath), resolve(planPath));
  return (
    pathWithinWorkspace === '' ||
    (!pathWithinWorkspace.startsWith('..') && !isAbsolute(pathWithinWorkspace))
  );
}

function buildSteps(
  headings: readonly ParsedHeading[],
  modelPolicies: ReadonlyMap<string, ReturnType<typeof parseModelPolicy>>,
): readonly PlanStep[] | null {
  const parents: PlanStep[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    if (heading.level === 1) {
      const step = makeStep(heading);
      if (!step) return null;
      const modelPolicy = modelPolicies.get(heading.id);
      parents.push(modelPolicy ? { ...step, modelPolicy } : step);
      continue;
    }
    const parent = parents.at(-1);
    if (!parent) return null;
    const child = makeStep(heading);
    if (!child) return null;
    (parent.children as PlanStep[]).push(child);
  }
  return parents;
}

function makeStep(heading: ParsedHeading): PlanStep | null {
  const description = descriptionFor(heading);
  const measurement = measurementFor(heading);
  if (!description || measurement === null) return null;
  if (heading.level === 1) {
    const reviewStatus = heading.properties.get('REVIEW_STATUS');
    const skills = heading.properties.get('SKILLS');
    if ((reviewStatus !== 'UNREVIEWED' && reviewStatus !== 'REVIEWED') || skills === undefined)
      return null;
    return {
      id: heading.id,
      title: heading.title,
      level: heading.level,
      state: heading.state,
      priority: heading.priority,
      reviewStatus: reviewStatus as PlanReviewStatus,
      skills: skills.split(/\s+/).filter(Boolean),
      description,
      ...(measurement ? { measurement } : {}),
      children: [],
    };
  }
  if (heading.properties.has('REVIEW_STATUS') || heading.properties.has('SKILLS')) return null;
  return {
    id: heading.id,
    title: heading.title,
    level: heading.level,
    state: heading.state,
    priority: heading.priority,
    description,
    ...(measurement ? { measurement } : {}),
    children: [],
  };
}

const measurementProperties = {
  STARTED_AT: 'startedAt',
  UPDATED_AT: 'updatedAt',
  COMPLETED_AT: 'completedAt',
  ELAPSED_SECONDS: 'elapsedSeconds',
  WEEKLY_REMAINING_START: 'weeklyRemainingStart',
  WEEKLY_REMAINING_CURRENT: 'weeklyRemainingCurrent',
  WEEKLY_REMAINING_END: 'weeklyRemainingEnd',
  WEEKLY_PERCENT_USED: 'weeklyPercentUsed',
  TOKENS_START: 'tokensStart',
  TOKENS_CURRENT: 'tokensCurrent',
  TOKENS_END: 'tokensEnd',
  TOKENS_USED: 'tokensUsed',
} as const;

function measurementFor(heading: ParsedHeading): PlanStepMeasurement | null | undefined {
  const measurement: Record<string, number | string> = {};
  for (const [property, field] of Object.entries(measurementProperties)) {
    const value = heading.properties.get(property);
    if (value === undefined) continue;
    if (property.endsWith('_AT')) {
      const instant = normalizeUtcIsoInstant(value);
      if (!instant) return null;
      measurement[field] = instant;
      continue;
    }
    if (!/^\d+$/.test(value)) return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || (property.startsWith('WEEKLY_') && number > 100))
      return null;
    measurement[field] = number;
  }
  return Object.keys(measurement).length === 0 ? undefined : (measurement as PlanStepMeasurement);
}

function normalizeUtcIsoInstant(value: string): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue, , zone] = match;
  const [year, month, day, hour, minute, second] = [
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
  ].map(Number);
  const offset = zone === 'Z' ? null : zone.slice(1).split(':').map(Number);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (offset && (offset[0]! > 23 || offset[1]! > 59))
  )
    return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  if (zone === 'Z') {
    const canonical = instant.toISOString();
    return value === canonical || value === canonical.replace('.000Z', 'Z') ? value : null;
  }
  return instant.toISOString().replace('.000Z', 'Z');
}

function descriptionFor(heading: ParsedHeading): PlanStepDescription | null {
  const fields =
    heading.level === 1 ? ['Effort', 'Goal', 'Notes'] : ['Why', 'Change', 'Tests', 'Done when'];
  if (!fields.every((field) => heading.descriptions.has(field))) return null;
  const description = heading.descriptions;
  return heading.level === 1
    ? {
        effort: description.get('Effort'),
        goal: description.get('Goal'),
        notes: description.get('Notes'),
      }
    : {
        why: description.get('Why'),
        change: description.get('Change'),
        tests: description.get('Tests'),
        doneWhen: description.get('Done when'),
      };
}

/** Match the helper's ordered nested-suspension-v1 lifecycle dialect. */
function hasValidSuspension(headings: readonly ParsedHeading[]): boolean {
  const parents = headings.filter((heading) => heading.level === 1);
  const suspended = parents.filter((heading) => heading.state === 'SUSPENDED');
  let parent: ParsedHeading | undefined;
  const pausedChildren = new Set<ParsedHeading>();
  for (const heading of headings) {
    if (heading.level === 1) parent = heading;
    const dependency = heading.properties.get('SUSPENDED_FOR');
    if (heading.level === 1 && heading.state === 'SUSPENDED') {
      const index = parents.findIndex((candidate) => candidate.id === dependency);
      if (
        index < 0 ||
        index >= parents.indexOf(heading) ||
        heading.properties.get('REVIEW_STATUS') !== 'UNREVIEWED'
      )
        return false;
    } else if (dependency !== undefined) return false;
    if (heading.level === 2) {
      if (!parent) return false;
      if (heading.state === 'SUSPENDED' && parent.state !== 'SUSPENDED') return false;
      if (heading.state === 'SUSPENDED') {
        if (pausedChildren.has(parent)) return false;
        pausedChildren.add(parent);
      }
      if (parent.state === 'SUSPENDED' && heading.state === 'WIP') return false;
      if (parent.state === 'DONE' && heading.state !== 'DONE') return false;
      if (parent.state === 'TODO' && heading.state !== 'TODO') return false;
    }
  }
  // Earlier-only targets exclude cycles; immediate-inner linkage excludes
  // forks and disconnected stacks while dependency review/unwind is pending.
  for (let index = 1; index < suspended.length; index += 1)
    if (suspended[index]!.properties.get('SUSPENDED_FOR') !== suspended[index - 1]!.id)
      return false;
  return (
    !suspended.length ||
    !parents.some(
      (heading) =>
        heading.state === 'WIP' && parents.indexOf(heading) >= parents.indexOf(suspended[0]!),
    )
  );
}

function hasValidWipPath(headings: readonly ParsedHeading[]): boolean {
  const wipByLevel = new Map<PlanLevel, ParsedHeading[]>();
  for (const heading of headings) {
    if (heading.state !== 'WIP') continue;
    const sameLevel = wipByLevel.get(heading.level) ?? [];
    sameLevel.push(heading);
    wipByLevel.set(heading.level, sameLevel);
  }
  if ([...wipByLevel.values()].some((steps) => steps.length > 1)) return false;
  const l2Wip = wipByLevel.get(2)?.[0];
  if (!l2Wip) return true;
  const parentIndex = headings.indexOf(l2Wip) - 1;
  for (let index = parentIndex; index >= 0; index -= 1) {
    if (headings[index]!.level === 1) return headings[index]!.state === 'WIP';
  }
  return false;
}

function findCurrentStepId(headings: readonly ParsedHeading[], allDone: boolean): string | null {
  const wip = headings
    .filter((heading) => heading.state === 'WIP')
    .sort((a, b) => b.level - a.level)[0];
  if (wip) return wip.id;
  const review = headings.find(
    (heading) =>
      heading.level === 1 &&
      heading.state === 'DONE' &&
      heading.properties.get('REVIEW_STATUS') === 'UNREVIEWED',
  );
  if (review) return review.id;
  const suspended = headings.find(
    (heading) => heading.level === 1 && heading.state === 'SUSPENDED',
  );
  const todo = headings.find(
    (heading) =>
      heading.state === 'TODO' &&
      (!suspended || headings.indexOf(heading) < headings.indexOf(suspended)),
  );
  if (todo) return todo.id;
  if (suspended) return suspended.id;

  return allDone ? (headings.findLast((heading) => heading.level === 1)?.id ?? null) : null;
}

function freezePlan(plan: SupervisedPlan): SupervisedPlan {
  const freezeStep = (step: PlanStep): PlanStep =>
    Object.freeze({
      ...step,
      ...(step.skills ? { skills: Object.freeze([...step.skills]) } : {}),
      description: Object.freeze({ ...step.description }),
      children: Object.freeze(step.children.map(freezeStep)),
    });
  return Object.freeze({ ...plan, steps: Object.freeze(plan.steps.map(freezeStep)) });
}

function unavailable(
  reason: import('../domain/supervised-plan.js').PlanUnavailableReason,
): PlanProjectionResult {
  return { kind: 'unavailable', reason };
}
