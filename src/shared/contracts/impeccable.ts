/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const impeccableGroups = [
  {
    label: 'Build',
    actions: [
      { name: 'shape', argument: 'feature', description: 'Plan UX/UI before coding' },
      { name: 'document', description: 'Derive DESIGN.md from an existing interface' },
      { name: 'extract', argument: 'target', description: 'Create reusable tokens and components' },
    ],
  },
  {
    label: 'Evaluate',
    actions: [
      { name: 'critique', argument: 'target', description: 'Review UX and visual quality' },
      {
        name: 'audit',
        argument: 'target',
        description: 'Check accessibility, responsiveness, and performance',
      },
    ],
  },
  {
    label: 'Refine',
    actions: [
      { name: 'polish', argument: 'target', description: 'Final pre-release quality pass' },
      { name: 'bolder', argument: 'target', description: 'Make a bland design more distinctive' },
      { name: 'quieter', argument: 'target', description: 'Reduce visual noise' },
      { name: 'distill', argument: 'target', description: 'Simplify the interface' },
      {
        name: 'harden',
        argument: 'target',
        description: 'Handle errors, edge cases, and internationalization',
      },
      {
        name: 'onboard',
        argument: 'target',
        description: 'Improve first-run flows and empty states',
      },
    ],
  },
  {
    label: 'Enhance',
    actions: [
      { name: 'animate', argument: 'target', description: 'Add purposeful motion' },
      { name: 'colorize', argument: 'target', description: 'Improve strategic color use' },
      { name: 'typeset', argument: 'target', description: 'Strengthen typography' },
      { name: 'layout', argument: 'target', description: 'Fix spacing and visual hierarchy' },
      { name: 'delight', argument: 'target', description: 'Add memorable details' },
      {
        name: 'overdrive',
        argument: 'target',
        description: 'Pursue a highly ambitious visual treatment',
      },
    ],
  },
  {
    label: 'Fix',
    actions: [
      {
        name: 'clarify',
        argument: 'target',
        description: 'Improve labels, instructions, and errors',
      },
      { name: 'adapt', argument: 'target', description: 'Improve mobile and responsive behavior' },
      { name: 'optimize', argument: 'target', description: 'Diagnose UI performance' },
    ],
  },
  {
    label: 'Browser iteration',
    actions: [{ name: 'live', description: 'Explore visual variants interactively' }],
  },
] as const;

export type ImpeccableAction = (typeof impeccableGroups)[number]['actions'][number];

export function hasImpeccableSkill(skills?: readonly { name: string; enabled: boolean }[]) {
  return (
    skills?.some(
      ({ name, enabled }) => enabled && (name === 'impeccable' || name.endsWith(':impeccable')),
    ) ?? false
  );
}

export function parseImpeccableCommand(text: string) {
  const match = /^\/impeccable(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i.exec(text.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  const action = impeccableGroups
    .map((group) => group.actions.find((item) => item.name === name))
    .find(Boolean);
  return { action, target: match[2] ?? '' };
}

export function impeccablePrompt(
  action: ImpeccableAction,
  target: string,
  remoteLive: boolean,
): string {
  const prompt = `$impeccable ${action.name}${target ? ` ${target}` : ''}`;
  const context = target
    ? ''
    : '\nUse the current interface or feature from this conversation as the target.';
  if (!remoteLive) return prompt + context;
  return (
    prompt +
    context +
    `

The user opened an Impeccable editor through Gestalt's HTTPS dev preview. Load the Impeccable Live reference.
Resolve the target and apply the project setup from live-setup.md if the Live configuration is missing. The picker and the helper connection use the same origin as the dev preview.
Start or reuse the loopback helper with the skill's \`impeccable live-server --background\` launcher from this chat's workspace root. Gestalt injects the picker and forwards browser requests, so skip the localhost script injection and let the user interact in their preview tab. Continue with the skill's local live-poll, variant handling, and cleanup. Keep the helper and the poll on this machine.`
  );
}
