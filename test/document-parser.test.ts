import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiFormatDocumentParser } from '../src/infrastructure/filesystem/document-parser.js';

// `projectPath` is only used to resolve internal wikilink-style link targets
// against the filesystem — none of the cases below exercise that path, so a
// throwaway directory (that doesn't even need to exist) is sufficient.
const projectPath = mkdtempSync(join(tmpdir(), 'docgraph-parser-'));
const parser = new MultiFormatDocumentParser(projectPath);

test('AsciiDoc: extracts the document title and section headings', () => {
  const content = `= My Great Guide
:description: A guide about things.
:tags: alpha, beta

== Getting Started

Some intro text.

[source,javascript]
----
console.log('hi');
----
`;
  const result = parser.parse(join(projectPath, 'guide.adoc'), content, '.adoc', 'text');

  assert.equal(result.language, 'asciidoc');
  assert.equal(result.title, 'My Great Guide');
  assert.equal(result.description, 'A guide about things.');
  assert.deepEqual(result.tags.slice().sort(), ['alpha', 'beta']);
  assert.ok(
    result.headings.some((h) => h.text === 'Getting Started' && h.level === 2),
    `expected a level-2 "Getting Started" heading, got ${JSON.stringify(result.headings)}`,
  );
  assert.equal(result.codeBlocks.length, 1);
  assert.equal(result.codeBlocks[0].language, 'javascript');
  assert.equal(result.codeBlocks[0].content, "console.log('hi');");
});

test('AsciiDoc: malformed input (unterminated listing block) does not throw', () => {
  const content = '= Broken Doc\n\n[source,text]\n----\nno closing delimiter\n';
  assert.doesNotThrow(() => parser.parse(join(projectPath, 'broken.adoc'), content, '.adoc', 'text'));
  const result = parser.parse(join(projectPath, 'broken.adoc'), content, '.adoc', 'text');
  assert.equal(typeof result, 'object');
  assert.equal(result.title, 'Broken Doc');
});

test('reStructuredText: infers title and section heading from underline adornment', () => {
  const content = `My Great Title
==============

Some intro text.

Section One
-----------

Body text.
`;
  const result = parser.parse(join(projectPath, 'doc.rst'), content, '.rst', 'text');

  assert.equal(result.language, 'restructuredtext');
  assert.equal(result.title, 'My Great Title');
  assert.ok(
    result.headings.some((h) => h.text === 'Section One'),
    `expected a "Section One" heading, got ${JSON.stringify(result.headings)}`,
  );
  // The title-level heading must be a lower level number than the section.
  const titleHeading = result.headings.find((h) => h.text === 'My Great Title');
  const sectionHeading = result.headings.find((h) => h.text === 'Section One');
  assert.ok(titleHeading && sectionHeading && titleHeading.level < sectionHeading.level);
});

test('reStructuredText: malformed/inconsistent adornment lines do not throw', () => {
  const content = '====\nshort\n=\n\n.. code-block:: python\nnever indented\n';
  assert.doesNotThrow(() => parser.parse(join(projectPath, 'broken.rst'), content, '.rst', 'text'));
  const result = parser.parse(join(projectPath, 'broken.rst'), content, '.rst', 'text');
  assert.equal(typeof result, 'object');
  assert.ok(Array.isArray(result.headings));
});

test('Org-mode: extracts #+TITLE and star-prefixed headings by level', () => {
  const content = `#+TITLE: My Org Doc
#+AUTHOR: someone

* Heading One
Some text.

** Subheading
More text.
`;
  const result = parser.parse(join(projectPath, 'notes.org'), content, '.org', 'text');

  assert.equal(result.language, 'org');
  assert.equal(result.title, 'My Org Doc');
  assert.ok(result.headings.some((h) => h.text === 'Heading One' && h.level === 1));
  assert.ok(result.headings.some((h) => h.text === 'Subheading' && h.level === 2));
});

test('Org-mode: malformed input (unterminated #+BEGIN_SRC block) does not throw', () => {
  const content = '* Heading\n#+BEGIN_SRC python\nprint("never closed")\n';
  assert.doesNotThrow(() => parser.parse(join(projectPath, 'broken.org'), content, '.org', 'text'));
  const result = parser.parse(join(projectPath, 'broken.org'), content, '.org', 'text');
  assert.equal(typeof result, 'object');
  assert.ok(result.headings.some((h) => h.text === 'Heading'));
});

test('Markdown: TOML front matter (+++ ... +++) yields title and tags', () => {
  const content = `+++
title = "TOML Doc"
tags = ["infra", "ops"]
+++

# Body Heading

Some content here.
`;
  const result = parser.parse(join(projectPath, 'toml-fm.md'), content, '.md', 'text');

  assert.equal(result.language, 'markdown');
  assert.equal(result.title, 'TOML Doc');
  assert.deepEqual(result.tags.slice().sort(), ['infra', 'ops']);
  assert.ok(result.headings.some((h) => h.text === 'Body Heading'));
});

test('Markdown: YAML front matter still works alongside the new formats', () => {
  const content = `---
title: YAML Doc
tags:
  - alpha
  - beta
---

# Heading

Body text.
`;
  const result = parser.parse(join(projectPath, 'yaml-fm.md'), content, '.md', 'text');

  assert.equal(result.title, 'YAML Doc');
  assert.deepEqual(result.tags.slice().sort(), ['alpha', 'beta']);
  assert.ok(result.headings.some((h) => h.text === 'Heading'));
});

test('Markdown: malformed TOML front matter falls back gracefully without throwing', () => {
  const content = '+++\ntitle = "unterminated string\n+++\n\n# Still Parsed\n';
  assert.doesNotThrow(() => parser.parse(join(projectPath, 'broken-fm.md'), content, '.md', 'text'));
  const result = parser.parse(join(projectPath, 'broken-fm.md'), content, '.md', 'text');
  assert.equal(typeof result, 'object');
  assert.ok(Array.isArray(result.headings));
});

test('TypeScript code path: surfaces exported symbol names as headings and leading JSDoc as description', () => {
  const content = `/**
 * Utility functions for widget management.
 */
export function createWidget(name: string): unknown {
  return { name };
}

export class WidgetRegistry {
  private widgets: unknown[] = [];
}
`;
  const result = parser.parse(join(projectPath, 'widget.ts'), content, '.ts', 'typescript');

  assert.equal(result.language, 'typescript');
  assert.ok(
    result.headings.some((h) => h.text === 'createWidget'),
    `expected "createWidget" among headings, got ${JSON.stringify(result.headings)}`,
  );
  assert.ok(
    result.headings.some((h) => h.text === 'WidgetRegistry'),
    `expected "WidgetRegistry" among headings, got ${JSON.stringify(result.headings)}`,
  );
  assert.equal(result.description, 'Utility functions for widget management.');
});

test('TypeScript code path: malformed/incomplete syntax does not throw', () => {
  const content = 'export function (\nclass {{{ broken\n/** unterminated doc\n';
  assert.doesNotThrow(() => parser.parse(join(projectPath, 'broken.ts'), content, '.ts', 'typescript'));
  const result = parser.parse(join(projectPath, 'broken.ts'), content, '.ts', 'typescript');
  assert.equal(typeof result, 'object');
  assert.ok(Array.isArray(result.headings));
});
