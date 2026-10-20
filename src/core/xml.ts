/**
 * A tiny, dependency-free XML parser.
 *
 * µVision project files are machine generated and well formed, but they are
 * UTF-8 (sometimes with BOM) and contain comments and CDATA sections, so a
 * regular-expression based reader is not enough.  This parser only keeps what
 * the tool needs: element names, attributes, direct text and children.
 */

export interface XMLElement {
  name: string;
  attributes: Record<string, string>;
  children: XMLElement[];
  /** Concatenated direct text nodes (entities decoded, not trimmed). */
  text: string;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  if (value.indexOf('&') < 0) {
    return value;
  }
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity] ?? match;
  });
}

function findTagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return source.length - 1;
}

export function parseXML(source: string): XMLElement {
  let index = 0;
  if (source.charCodeAt(0) === 0xfeff) {
    index = 1;
  }
  const stack: XMLElement[] = [];
  let root: XMLElement | undefined;
  const length = source.length;

  const appendText = (text: string): void => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.text += decodeEntities(text);
    }
  };

  while (index < length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      appendText(source.slice(index));
      break;
    }
    if (lt > index) {
      appendText(source.slice(index, lt));
    }

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      index = end < 0 ? length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const cdata = source.slice(lt + 9, end < 0 ? length : end);
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.text += cdata;
      }
      index = end < 0 ? length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      index = end < 0 ? length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2);
      const name = source.slice(lt + 2, end < 0 ? length : end).trim();
      // Pop until the matching element is found; tolerate stray closing tags.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      index = end < 0 ? length : end + 1;
      continue;
    }

    const end = findTagEnd(source, lt + 1);
    let tag = source.slice(lt + 1, end);
    index = end + 1;
    const selfClosing = tag.trimEnd().endsWith('/');
    if (selfClosing) {
      tag = tag.trimEnd().slice(0, -1);
    }
    const nameMatch = /^([^\s/>]+)/.exec(tag);
    if (!nameMatch) {
      continue;
    }
    const element: XMLElement = { name: nameMatch[1], attributes: {}, children: [], text: '' };
    const attributesSource = tag.slice(nameMatch[0].length);
    const attributePattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(attributesSource)) !== null) {
      element.attributes[attributeMatch[1]] = decodeEntities(attributeMatch[2] ?? attributeMatch[3] ?? '');
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(element);
    } else if (!root) {
      root = element;
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (!root) {
    throw new Error('Invalid XML document: no root element found');
  }
  return root;
}

export function child(element: XMLElement | undefined, name: string): XMLElement | undefined {
  return element?.children.find((candidate) => candidate.name === name);
}

export function children(element: XMLElement | undefined, name: string): XMLElement[] {
  return element ? element.children.filter((candidate) => candidate.name === name) : [];
}

export function childPath(element: XMLElement | undefined, path: string): XMLElement | undefined {
  let current = element;
  for (const part of path.split('/')) {
    current = child(current, part);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

export function childText(element: XMLElement | undefined, name: string, fallback = ''): string {
  const found = child(element, name);
  return found ? found.text.trim() : fallback;
}

export function pathText(element: XMLElement | undefined, path: string, fallback = ''): string {
  const found = childPath(element, path);
  return found ? found.text.trim() : fallback;
}

export function pathNumber(element: XMLElement | undefined, path: string, fallback = 0): number {
  const raw = pathText(element, path, '');
  if (raw === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function pathBool(element: XMLElement | undefined, path: string, fallback = false): boolean {
  const raw = pathText(element, path, '');
  if (raw === '') {
    return fallback;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}
