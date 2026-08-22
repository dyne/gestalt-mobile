/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type OrgDocumentSection = Readonly<{
  level: number;
  title: string;
  state?: 'TODO' | 'WIP' | 'DONE';
  priority?: 'A' | 'B' | 'C';
  properties: readonly (readonly [string, string])[];
  descriptions: readonly (readonly [string, string])[];
  body: readonly string[];
}>;

export type OrgDocument = Readonly<{
  metadata: readonly (readonly [string, string])[];
  preamble: readonly string[];
  sections: readonly OrgDocumentSection[];
}>;

const headingPattern = /^(\*+)\s+(?:(TODO|WIP|DONE)\s+)?(?:\[#([ABC])\]\s+)?(.+)$/;
const metadataPattern = /^#\+([A-Z][A-Z0-9_-]*):\s*(.*)$/i;
const propertyPattern = /^:([A-Z][A-Z0-9_]*):\s*(.*)$/;
const descriptionPattern = /^-\s+([^:]+?)\s+::\s*(.*)$/;

/** Projects ordinary Org text into safe display data without interpreting markup as HTML. */
export function parseOrgDocument(source: string): OrgDocument {
  const metadata: Array<readonly [string, string]> = [];
  const preamble: string[] = [];
  const sections: OrgDocumentSection[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let current: {
    level: number;
    title: string;
    state?: 'TODO' | 'WIP' | 'DONE';
    priority?: 'A' | 'B' | 'C';
    properties: Array<readonly [string, string]>;
    descriptions: Array<readonly [string, string]>;
    body: string[];
  } | null = null;
  let inProperties = false;

  const retainCurrent = (): void => {
    if (!current) return;
    sections.push({
      ...current,
      properties: [...current.properties],
      descriptions: [...current.descriptions],
      body: compactLines(current.body),
    });
  };

  for (const line of lines) {
    const heading = headingPattern.exec(line);
    if (heading) {
      retainCurrent();
      current = {
        level: heading[1]!.length,
        title: heading[4]!.trim(),
        ...(heading[2] ? { state: heading[2] as 'TODO' | 'WIP' | 'DONE' } : {}),
        ...(heading[3] ? { priority: heading[3] as 'A' | 'B' | 'C' } : {}),
        properties: [],
        descriptions: [],
        body: [],
      };
      inProperties = false;
      continue;
    }

    if (!current) {
      const item = metadataPattern.exec(line);
      if (item) metadata.push([item[1]!.toUpperCase(), item[2]!.trim()]);
      else preamble.push(line);
      continue;
    }

    if (line === ':PROPERTIES:') {
      inProperties = true;
      continue;
    }
    if (inProperties && line === ':END:') {
      inProperties = false;
      continue;
    }
    if (inProperties) {
      const property = propertyPattern.exec(line);
      if (property) current.properties.push([property[1]!, property[2]!.trim()]);
      continue;
    }
    const description = descriptionPattern.exec(line);
    if (description) current.descriptions.push([description[1]!.trim(), description[2]!.trim()]);
    else current.body.push(line);
  }
  retainCurrent();

  return {
    metadata,
    preamble: compactLines(preamble),
    sections,
  };
}

function compactLines(lines: readonly string[]): string[] {
  const compact = [...lines];
  while (compact[0]?.trim() === '') compact.shift();
  while (compact.at(-1)?.trim() === '') compact.pop();
  return compact;
}
