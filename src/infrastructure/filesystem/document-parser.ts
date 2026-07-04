import { existsSync } from 'fs';
import { extname } from 'path';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import * as toml from 'toml';
import { DocumentParser, ParsedDocument } from '../../domain/ports.js';
import { Heading, DocumentLink, CodeBlock } from '../../domain/entities.js';

/**
 * Parses raw file content into structured document data. Markdown, JSON, YAML
 * and TOML get format-aware parsing; everything else uses a generic parser that
 * still extracts fenced code blocks and comment headings.
 */
export class MultiFormatDocumentParser implements DocumentParser {
  constructor(private readonly projectPath: string) {}

  parse(filePath: string, rawContent: string, extension: string, defaultLanguage: string): ParsedDocument {
    switch (extension) {
      case '.md':
      case '.markdown':
      case '.mdown':
      case '.mkd':
      case '.mkdn':
        return this.parseMarkdown(rawContent);
      case '.json':
      case '.jsonc':
      case '.json5':
        return this.parseJson(rawContent);
      case '.yaml':
      case '.yml':
        return this.parseYamlFile(rawContent);
      case '.toml':
        return this.parseToml(rawContent);
      case '.adoc':
      case '.asciidoc':
      case '.adr':
        return this.parseAsciiDoc(rawContent);
      case '.rst':
        return this.parseRst(rawContent);
      case '.org':
        return this.parseOrg(rawContent);
      default:
        return this.parseCode(rawContent, defaultLanguage);
    }
  }

  private parseMarkdown(content: string): ParsedDocument {
    const { data, body } = this.extractFrontMatter(content);
    const lines = body.split('\n');
    const headings: Heading[] = [];
    const links: DocumentLink[] = [];
    const codeBlocks: CodeBlock[] = [];

    let inCodeBlock = false;
    let codeBlockStart = 0;
    let codeBlockLang = '';
    let codeBlockContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```') || line.startsWith('~~~')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockStart = i;
          codeBlockLang = line.slice(3).trim() || 'text';
          codeBlockContent = '';
        } else {
          inCodeBlock = false;
          codeBlocks.push({
            language: codeBlockLang,
            content: codeBlockContent.trim(),
            startLine: codeBlockStart + 1,
            endLine: i + 1,
          });
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = headingMatch[2].trim();
        const anchor = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
        headings.push({ level, text, anchor });
      }

      const linkMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const match of linkMatches) {
        const text = match[1];
        const url = match[2];
        const isInternal = !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:');
        const targetPath = isInternal ? this.resolveLinkPath(url) : undefined;
        links.push({ text, url, isInternal, targetPath });
      }
    }

    return {
      content: body.trim(),
      language: 'markdown',
      title: data.title || headings.find((h) => h.level === 1)?.text,
      description: data.description || data.summary,
      tags: this.collectFrontMatterTags(data),
      headings,
      links,
      codeBlocks,
    };
  }

  /**
   * Extracts front matter from the start of a document, supporting YAML
   * (`---`, gray-matter default, including `--- json`/`---json` annotated
   * JSON blocks), TOML (`+++ ... +++`), and bare leading `{ ... }` JSON
   * blocks with no fences at all. Never throws — malformed front matter
   * simply falls back to "no front matter" with the original content as body.
   */
  private extractFrontMatter(content: string): { data: Record<string, any>; body: string } {
    const normalized = content.replace(/^﻿/, '');
    const firstLine = normalized.slice(0, normalized.indexOf('\n') === -1 ? normalized.length : normalized.indexOf('\n'));

    try {
      if (/^\+\+\+\s*$/.test(firstLine.trimEnd())) {
        const parsed = matter(normalized, {
          delimiters: '+++',
          language: 'toml',
          engines: { toml: { parse: (str: string) => toml.parse(str) } },
        });
        return { data: (parsed.data as Record<string, any>) || {}, body: parsed.content };
      }

      if (/^---/.test(normalized)) {
        const parsed = matter(normalized, {
          engines: { json: { parse: JSON.parse }, JSON: { parse: JSON.parse } },
        });
        return { data: (parsed.data as Record<string, any>) || {}, body: parsed.content };
      }
    } catch {
      // fall through to bare-JSON / no-front-matter handling below
    }

    const bare = this.tryParseBareJsonFrontMatter(normalized);
    if (bare) return bare;

    return { data: {}, body: normalized };
  }

  /**
   * Handles documents that open directly with a JSON object (no `---`/`+++`
   * fences at all) — finds the balanced `{...}` block at the very start of
   * the content and, if it parses as a JSON object, treats it as front matter.
   */
  private tryParseBareJsonFrontMatter(content: string): { data: Record<string, any>; body: string } | null {
    const trimmed = content.replace(/^\s+/, '');
    if (!trimmed.startsWith('{')) return null;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let endIndex = -1;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === stringChar) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    if (endIndex === -1) return null;

    try {
      const data = JSON.parse(trimmed.slice(0, endIndex + 1));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const body = trimmed.slice(endIndex + 1).replace(/^\s*\r?\n/, '');
        return { data: data as Record<string, any>, body };
      }
    } catch {
      return null;
    }

    return null;
  }

  /** Merges `tags`/`categories`/`aliases`/`keywords` front-matter fields into one tag list. */
  private collectFrontMatterTags(data: Record<string, any>): string[] {
    const toArray = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
      if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
      return [];
    };

    const tags = [
      ...toArray(data.tags),
      ...toArray(data.categories),
      ...toArray(data.aliases),
      ...toArray(data.keywords),
    ];

    return Array.from(new Set(tags));
  }

  private parseJson(content: string): ParsedDocument {
    try {
      const parsed = JSON.parse(content);
      return {
        content: this.extractTextFromObject(parsed),
        language: 'json',
        title: parsed.title || parsed.name,
        description: parsed.description,
        tags: parsed.tags || [],
        headings: [],
        links: [],
        codeBlocks: [],
      };
    } catch {
      return this.emptyParsed(content, 'json');
    }
  }

  private parseYamlFile(content: string): ParsedDocument {
    try {
      const parsed = parseYaml(content);
      const textContent = typeof parsed === 'string' ? parsed : this.extractTextFromObject(parsed);
      return {
        content: textContent,
        language: 'yaml',
        title: parsed?.title || parsed?.name,
        description: parsed?.description,
        tags: parsed?.tags || [],
        headings: [],
        links: [],
        codeBlocks: [],
      };
    } catch {
      return this.emptyParsed(content, 'yaml');
    }
  }

  private parseToml(content: string): ParsedDocument {
    try {
      const parsed = toml.parse(content);
      return {
        content: this.extractTextFromObject(parsed),
        language: 'toml',
        title: parsed.title || parsed.name,
        description: parsed.description,
        tags: parsed.tags || [],
        headings: [],
        links: [],
        codeBlocks: [],
      };
    } catch {
      return this.emptyParsed(content, 'toml');
    }
  }

  /**
   * AsciiDoc: extracts the document title (`= Title`), section headings
   * (`==`, `===`, ... — level = number of leading `=`), `link:`/bare-URL
   * links, `[source,lang]` + `----` listing blocks, and a handful of
   * document attributes (`:description:`, `:keywords:`/`:tags:`).
   */
  private parseAsciiDoc(content: string): ParsedDocument {
    try {
      const lines = content.split('\n');
      const headings: Heading[] = [];
      const links: DocumentLink[] = [];
      const codeBlocks: CodeBlock[] = [];
      let title: string | undefined;
      let description: string | undefined;
      const tags: string[] = [];

      let inListing = false;
      let listingStart = 0;
      let listingLang = 'text';
      let listingContent = '';
      let pendingLang: string | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (inListing) {
          if (/^-{4,}\s*$/.test(line)) {
            inListing = false;
            codeBlocks.push({
              language: listingLang,
              content: listingContent.trim(),
              startLine: listingStart + 1,
              endLine: i + 1,
            });
            listingContent = '';
            continue;
          }
          listingContent += line + '\n';
          continue;
        }

        if (/^-{4,}\s*$/.test(line)) {
          inListing = true;
          listingStart = i;
          listingLang = pendingLang || 'text';
          pendingLang = null;
          listingContent = '';
          continue;
        }

        const sourceMatch = line.match(/^\[source(?:,\s*([\w+-]+))?[^\]]*\]\s*$/);
        if (sourceMatch) {
          pendingLang = sourceMatch[1] || 'text';
          continue;
        }

        const attrMatch = line.match(/^:([\w-]+):\s*(.*)$/);
        if (attrMatch) {
          const [, name, value] = attrMatch;
          const key = name.toLowerCase();
          if (key === 'description' || key === 'summary') {
            description = description ?? value.trim();
          } else if ((key === 'keywords' || key === 'tags') && value.trim()) {
            for (const tag of value.split(',').map((t) => t.trim()).filter(Boolean)) tags.push(tag);
          }
          continue;
        }

        const headingMatch = line.match(/^(={1,6})\s+(.+?)\s*$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const text = headingMatch[2].trim();
          const anchor = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
          headings.push({ level, text, anchor });
          if (level === 1 && title === undefined) title = text;
          continue;
        }

        const linkMacroRegex = /link:(\S+?)\[([^\]]*)\]/g;
        let linkMatch: RegExpExecArray | null;
        while ((linkMatch = linkMacroRegex.exec(line)) !== null) {
          const url = linkMatch[1];
          const text = linkMatch[2] || url;
          const isInternal = !/^https?:\/\//.test(url) && !url.startsWith('mailto:');
          links.push({ text, url, isInternal, targetPath: isInternal ? this.resolveLinkPath(url) : undefined });
        }

        const stripped = line.replace(/link:\S+?\[[^\]]*\]/g, ' ');
        const bareUrlRegex = /https?:\/\/[^\s[\]]+/g;
        let bareMatch: RegExpExecArray | null;
        while ((bareMatch = bareUrlRegex.exec(stripped)) !== null) {
          const url = bareMatch[0].replace(/[.,;:]+$/, '');
          links.push({ text: url, url, isInternal: false, targetPath: undefined });
        }
      }

      if (inListing && listingContent.trim() !== '') {
        codeBlocks.push({
          language: listingLang,
          content: listingContent.trim(),
          startLine: listingStart + 1,
          endLine: lines.length,
        });
      }

      return {
        content,
        language: 'asciidoc',
        title,
        description,
        tags: Array.from(new Set(tags)),
        headings,
        links,
        codeBlocks,
      };
    } catch {
      return this.emptyParsed(content, 'asciidoc');
    }
  }

  /**
   * reStructuredText: titles/section headings are inferred from
   * underline/overline adornment lines (level assigned by the order in
   * which distinct adornment characters first appear), `.. code-block::`
   * / `::`-indented literal blocks, and `` `text <url>`_ `` / bare links.
   */
  private parseRst(content: string): ParsedDocument {
    try {
      const lines = content.split('\n');
      const headings: Heading[] = [];
      const links: DocumentLink[] = [];
      const codeBlocks: CodeBlock[] = [];
      let title: string | undefined;

      const PUNCT = new Set([
        '!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '?', '@',
        '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~',
      ]);

      const adornmentChar = (line: string): string | null => {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed.length === 0) return null;
        const ch = trimmed[0];
        if (!PUNCT.has(ch)) return null;
        for (const c of trimmed) {
          if (c !== ch) return null;
        }
        return ch;
      };

      const levelMap = new Map<string, number>();
      let nextLevel = 1;
      const levelFor = (key: string): number => {
        let lvl = levelMap.get(key);
        if (lvl === undefined) {
          lvl = Math.min(nextLevel, 6);
          nextLevel = Math.min(nextLevel + 1, 6);
          levelMap.set(key, lvl);
        }
        return lvl;
      };

      const findIndentedBlock = (startIdx: number): number => {
        let j = startIdx;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && /^[ \t]+\S/.test(lines[j])) return j;
        return -1;
      };

      let inLiteralBlock = false;
      let literalIndent = 0;
      let literalStart = 0;
      let literalLang = 'text';
      let literalContent = '';
      let pendingLang: string | null = null;

      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        if (inLiteralBlock) {
          if (line.trim() === '') {
            literalContent += '\n';
            i++;
            continue;
          }
          const indent = line.length - line.trimStart().length;
          if (indent >= literalIndent) {
            literalContent += line.slice(literalIndent) + '\n';
            i++;
            continue;
          }
          inLiteralBlock = false;
          codeBlocks.push({
            language: literalLang,
            content: literalContent.trim(),
            startLine: literalStart + 1,
            endLine: i,
          });
          literalContent = '';
          continue;
        }

        const directiveMatch = line.match(/^\s*\.\.\s+code-block::\s*(\S+)?/);
        if (directiveMatch) {
          pendingLang = directiveMatch[1] || 'text';
          i++;
          continue;
        }

        if (pendingLang !== null) {
          const blockStart = findIndentedBlock(i);
          if (blockStart !== -1) {
            inLiteralBlock = true;
            literalIndent = lines[blockStart].length - lines[blockStart].trimStart().length;
            literalStart = blockStart;
            literalLang = pendingLang;
            literalContent = '';
            pendingLang = null;
            i = blockStart;
            continue;
          }
          pendingLang = null;
        }

        if (line.trim() !== '' && /::\s*$/.test(line)) {
          const blockStart = findIndentedBlock(i + 1);
          if (blockStart !== -1) {
            inLiteralBlock = true;
            literalIndent = lines[blockStart].length - lines[blockStart].trimStart().length;
            literalStart = blockStart;
            literalLang = 'text';
            literalContent = '';
            i = blockStart;
            continue;
          }
        }

        if (i + 2 < lines.length) {
          const overCh = adornmentChar(line);
          const candidateText = lines[i + 1];
          if (
            overCh &&
            candidateText.trim() !== '' &&
            adornmentChar(lines[i + 2]) === overCh &&
            lines[i + 2].replace(/\s+$/, '').length >= candidateText.trim().length
          ) {
            const headingText = candidateText.trim();
            const level = levelFor('over:' + overCh);
            const anchor = headingText.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
            headings.push({ level, text: headingText, anchor });
            if (title === undefined) title = headingText;
            i += 3;
            continue;
          }
        }

        if (i + 1 < lines.length && line.trim() !== '') {
          const underCh = adornmentChar(lines[i + 1]);
          if (underCh && lines[i + 1].replace(/\s+$/, '').length >= line.trim().length) {
            const headingText = line.trim();
            const level = levelFor(underCh);
            const anchor = headingText.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
            headings.push({ level, text: headingText, anchor });
            if (title === undefined) title = headingText;
            i += 2;
            continue;
          }
        }

        const linkRegex = /`([^`<]+)<([^>]+)>`_/g;
        let linkMatch: RegExpExecArray | null;
        while ((linkMatch = linkRegex.exec(line)) !== null) {
          const text = linkMatch[1].trim();
          const url = linkMatch[2].trim();
          const isInternal = !/^https?:\/\//.test(url) && !url.startsWith('mailto:');
          links.push({ text, url, isInternal, targetPath: isInternal ? this.resolveLinkPath(url) : undefined });
        }

        const stripped = line.replace(/`[^`<]+<[^>]+>`_/g, ' ');
        const bareUrlRegex = /https?:\/\/[^\s`<>]+/g;
        let bareMatch: RegExpExecArray | null;
        while ((bareMatch = bareUrlRegex.exec(stripped)) !== null) {
          const url = bareMatch[0].replace(/[.,;:]+$/, '');
          links.push({ text: url, url, isInternal: false, targetPath: undefined });
        }

        i++;
      }

      if (inLiteralBlock && literalContent.trim() !== '') {
        codeBlocks.push({
          language: literalLang,
          content: literalContent.trim(),
          startLine: literalStart + 1,
          endLine: lines.length,
        });
      }

      return {
        content,
        language: 'restructuredtext',
        title,
        description: undefined,
        tags: [],
        headings,
        links,
        codeBlocks,
      };
    } catch {
      return this.emptyParsed(content, 'restructuredtext');
    }
  }

  /**
   * Org-mode: `#+TITLE:`, `*`-prefixed headings (level = star count, trailing
   * `:tag:` blocks pulled into document tags), `#+BEGIN_SRC lang ... #+END_SRC`
   * blocks, and `[[link][text]]` / `[[link]]` links.
   */
  private parseOrg(content: string): ParsedDocument {
    try {
      const lines = content.split('\n');
      const headings: Heading[] = [];
      const links: DocumentLink[] = [];
      const codeBlocks: CodeBlock[] = [];
      let title: string | undefined;
      const tags = new Set<string>();

      let inSrcBlock = false;
      let srcStart = 0;
      let srcLang = 'text';
      let srcContent = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (inSrcBlock) {
          if (/^\s*#\+END_SRC\s*$/i.test(line)) {
            inSrcBlock = false;
            codeBlocks.push({
              language: srcLang,
              content: srcContent.trim(),
              startLine: srcStart + 1,
              endLine: i + 1,
            });
            srcContent = '';
            continue;
          }
          srcContent += line + '\n';
          continue;
        }

        const srcStartMatch = line.match(/^\s*#\+BEGIN_SRC(?:\s+(\S+))?/i);
        if (srcStartMatch) {
          inSrcBlock = true;
          srcStart = i;
          srcLang = srcStartMatch[1] || 'text';
          srcContent = '';
          continue;
        }

        const titleMatch = line.match(/^#\+TITLE:\s*(.+)$/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
          continue;
        }

        const headingMatch = line.match(/^(\*+)\s+(.+)$/);
        if (headingMatch) {
          let text = headingMatch[2].trim();
          text = text.replace(/^(TODO|DONE|NEXT|WAITING|CANCELLED)\s+/, '');
          text = text.replace(/^\[#[A-Za-z0-9]\]\s+/, '');
          const tagMatch = text.match(/\s+(:[\w@%#]+:)+\s*$/);
          if (tagMatch) {
            const tagBlock = tagMatch[0].trim();
            for (const tag of tagBlock.split(':').map((t) => t.trim()).filter(Boolean)) tags.add(tag);
            text = text.slice(0, tagMatch.index).trim();
          }
          const level = Math.min(headingMatch[1].length, 6);
          const anchor = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
          headings.push({ level, text, anchor });
          continue;
        }

        const linkRegex = /\[\[([^\]]+)\](?:\[([^\]]+)\])?\]/g;
        let linkMatch: RegExpExecArray | null;
        while ((linkMatch = linkRegex.exec(line)) !== null) {
          const url = linkMatch[1];
          const text = linkMatch[2] || url;
          const isInternal = !/^https?:\/\//.test(url) && !url.startsWith('mailto:');
          links.push({ text, url, isInternal, targetPath: isInternal ? this.resolveLinkPath(url) : undefined });
        }
      }

      if (inSrcBlock && srcContent.trim() !== '') {
        codeBlocks.push({ language: srcLang, content: srcContent.trim(), startLine: srcStart + 1, endLine: lines.length });
      }

      return {
        content,
        language: 'org',
        title: title || headings.find((h) => h.level === 1)?.text,
        description: undefined,
        tags: Array.from(tags),
        headings,
        links,
        codeBlocks,
      };
    } catch {
      return this.emptyParsed(content, 'org');
    }
  }

  private parseGeneric(content: string, language: string): ParsedDocument {
    const lines = content.split('\n');
    const headings: Heading[] = [];
    const codeBlocks: CodeBlock[] = [];

    let inCodeBlock = false;
    let codeBlockStart = 0;
    let codeBlockContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockStart = i;
          codeBlockContent = '';
        } else {
          inCodeBlock = false;
          codeBlocks.push({
            language,
            content: codeBlockContent.trim(),
            startLine: codeBlockStart + 1,
            endLine: i + 1,
          });
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += line + '\n';
        continue;
      }

      const headingMatch = line.match(/^(\/\/|#|\/\*)\s*(#{0,6})\s*(.+)$/);
      if (headingMatch) {
        const text = headingMatch[3].trim();
        const anchor = text.toLowerCase().replace(/[^\w]+/g, '-');
        headings.push({ level: 1, text, anchor });
      }
    }

    return { content, language, tags: [], headings, links: [], codeBlocks };
  }

  /**
   * Lightweight, language-aware code structure extraction. Runs the
   * existing generic parser first (fenced code blocks + `//`/`#`/`/*`
   * comment headings are always preserved), then — best-effort, via
   * well-tested regexes rather than a real parser — appends top-level
   * symbol names (functions, classes, types, ...) as searchable headings
   * and the leading doc comment/docstring as the description. Any failure
   * in the enrichment step is swallowed and the generic result is returned
   * unchanged; this path must never throw.
   */
  private parseCode(content: string, language: string): ParsedDocument {
    const base = this.parseGeneric(content, language);

    try {
      const extra = this.extractCodeSymbols(content, language);
      if (!extra || (extra.headings.length === 0 && !extra.description)) {
        return base;
      }
      return {
        ...base,
        headings: [...base.headings, ...extra.headings],
        description: base.description ?? extra.description,
      };
    } catch {
      return base;
    }
  }

  private extractCodeSymbols(content: string, language: string): { headings: Heading[]; description?: string } | null {
    switch (language) {
      case 'javascript':
      case 'typescript':
        return this.extractJsTsSymbols(content);
      case 'python':
        return this.extractPythonSymbols(content);
      case 'go':
        return this.extractGoSymbols(content);
      case 'rust':
        return this.extractRustSymbols(content);
      case 'java':
      case 'kotlin':
      case 'csharp':
        return this.extractJvmLikeSymbols(content);
      default:
        return null;
    }
  }

  private toSymbolHeading(text: string, level: 1 | 2): Heading {
    const anchor = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/-+$/, '');
    return { level, text, anchor };
  }

  private makeSymbolPusher(headings: Heading[]): (name: string, level: 1 | 2) => void {
    const seen = new Set<string>();
    return (name: string, level: 1 | 2) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const key = `${level}:${trimmed}`;
      if (seen.has(key)) return;
      seen.add(key);
      headings.push(this.toSymbolHeading(trimmed, level));
    };
  }

  /** JS/TS: `function`/`class`/`interface`/`type`/`export const` names + first JSDoc block. */
  private extractJsTsSymbols(content: string): { headings: Heading[]; description?: string } {
    const headings: Heading[] = [];
    const push = this.makeSymbolPusher(headings);

    const patterns: Array<[RegExp, 1 | 2]> = [
      [/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm, 1],
      [/^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, 1],
      [/^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, 2],
      [/^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, 2],
      [/^[ \t]*export\s+const\s+([A-Za-z_$][\w$]*)/gm, 2],
    ];

    for (const [regex, level] of patterns) {
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        push(m[1], level);
      }
    }

    let description: string | undefined;
    const docMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (docMatch) {
      description =
        docMatch[1]
          .split('\n')
          .map((l) => l.replace(/^\s*\*\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;
    }

    return { headings, description };
  }

  /** Python: `def`/`class` names + the module's leading docstring. */
  private extractPythonSymbols(content: string): { headings: Heading[]; description?: string } {
    const headings: Heading[] = [];
    const push = this.makeSymbolPusher(headings);

    let m: RegExpExecArray | null;
    const classRegex = /^[ \t]*class\s+([A-Za-z_]\w*)/gm;
    while ((m = classRegex.exec(content)) !== null) push(m[1], 1);
    const defRegex = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
    while ((m = defRegex.exec(content)) !== null) push(m[1], 2);

    let description: string | undefined;
    const docMatch = content.match(/^(?:[ \t]*\r?\n|[ \t]*#[^\n]*\r?\n)*[ \t]*("""|''')([\s\S]*?)\1/);
    if (docMatch) {
      description =
        docMatch[2]
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .join(' ')
          .trim() || undefined;
    }

    return { headings, description };
  }

  /** Go: `func` (including methods) + `type ... struct/interface` names, plus the leading `//` package doc. */
  private extractGoSymbols(content: string): { headings: Heading[]; description?: string } {
    const headings: Heading[] = [];
    const push = this.makeSymbolPusher(headings);

    let m: RegExpExecArray | null;
    const funcRegex = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/gm;
    while ((m = funcRegex.exec(content)) !== null) push(m[1], 1);
    const typeRegex = /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm;
    while ((m = typeRegex.exec(content)) !== null) push(m[1], 1);

    let description: string | undefined;
    const docMatch = content.match(/^((?:\/\/[^\n]*\n)+)package\s+\w+/);
    if (docMatch) {
      description =
        docMatch[1]
          .split('\n')
          .map((l) => l.replace(/^\/\/\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;
    }

    return { headings, description };
  }

  /** Rust: `fn`, `struct`/`enum`/`trait` names, `impl [Trait for] Type` blocks, plus leading `//!` module doc. */
  private extractRustSymbols(content: string): { headings: Heading[]; description?: string } {
    const headings: Heading[] = [];
    const push = this.makeSymbolPusher(headings);

    let m: RegExpExecArray | null;
    const fnRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/gm;
    while ((m = fnRegex.exec(content)) !== null) push(m[1], 2);

    const typeRegex = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm;
    while ((m = typeRegex.exec(content)) !== null) push(m[1], 1);

    const implRegex = /^[ \t]*impl(?:<[^>]*>)?\s+([\w:<>]+)(?:\s+for\s+([\w:<>]+))?/gm;
    while ((m = implRegex.exec(content)) !== null) {
      const text = m[2] ? `${m[1]} for ${m[2]}` : m[1];
      push(text, 1);
    }

    let description: string | undefined;
    const docMatch = content.match(/^((?:\/\/!.*\n)+)/);
    if (docMatch) {
      description =
        docMatch[1]
          .split('\n')
          .map((l) => l.replace(/^\/\/!\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;
    }

    return { headings, description };
  }

  /** Java/Kotlin/C#: `class`/`interface`/`enum`/`record`/`object` names + method signatures. */
  private extractJvmLikeSymbols(content: string): { headings: Heading[]; description?: string } {
    const headings: Heading[] = [];
    const push = this.makeSymbolPusher(headings);

    let m: RegExpExecArray | null;

    const typeRegex =
      /^[ \t]*(?:(?:public|private|protected|internal|sealed|abstract|final|static|data|open|inner)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/gm;
    while ((m = typeRegex.exec(content)) !== null) push(m[1], 1);

    const kotlinFunRegex =
      /^[ \t]*(?:(?:public|private|protected|internal|override|suspend|open|inline)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/gm;
    while ((m = kotlinFunRegex.exec(content)) !== null) push(m[1], 2);

    const methodRegex =
      /^[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*(?:public|private|protected|internal)\s+(?:static\s+|final\s+|override\s+|virtual\s+|async\s+|abstract\s+)*[\w<>[\],.\s]+?\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:\{|;|=>)/gm;
    while ((m = methodRegex.exec(content)) !== null) push(m[1], 2);

    let description: string | undefined;
    const docMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (docMatch) {
      description =
        docMatch[1]
          .split('\n')
          .map((l) => l.replace(/^\s*\*\s?/, '').trim())
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;
    }

    return { headings, description };
  }

  private emptyParsed(content: string, language: string): ParsedDocument {
    return { content, language, tags: [], headings: [], links: [], codeBlocks: [] };
  }

  private extractTextFromObject(obj: unknown, depth: number = 0): string {
    if (depth > 10) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
    if (Array.isArray(obj)) {
      return obj.map((item) => this.extractTextFromObject(item, depth + 1)).filter(Boolean).join(' ');
    }
    if (obj && typeof obj === 'object') {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        if (['title', 'name', 'description', 'summary', 'text', 'content'].includes(key)) {
          parts.push(String(value));
        } else {
          parts.push(this.extractTextFromObject(value, depth + 1));
        }
      }
      return parts.filter(Boolean).join(' ');
    }
    return '';
  }

  private resolveLinkPath(link: string): string {
    const resolved = link
      .replace(/^~\//, this.projectPath + '/')
      .replace(/^\.\//, this.projectPath + '/')
      .replace(/^\.\.\//, this.projectPath + '/');

    if (!extname(resolved) && !existsSync(resolved)) {
      const extensions = ['.md', '.markdown', '.json', '.yaml', '.yml', '.ts', '.tsx', '.js'];
      for (const ext of extensions) {
        if (existsSync(resolved + ext)) {
          return resolved + ext;
        }
      }
    }

    return resolved;
  }
}
