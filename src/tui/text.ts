import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const MAX_GRAPHEME_CODE_UNITS = 4096;
const controls = /[\u0000-\u001f\u007f-\u009f]/gu;
const tagDelimiter = /[ =/>'"]/u;
const referenceDelimiter = /[ ;<&]/u;

type XmlState =
  | 'text'
  | 'attribute-single'
  | 'attribute-double'
  | 'comment'
  | 'cdata'
  | 'pi'
  | 'tag';
interface HighlightSpan {
  text: string;
  color?: string;
}

function columns(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Convert terminal controls to printable text; tabs use four-column stops. */
export function visibleText(value: string, startColumn = 0): string {
  let column = columns(startColumn);
  let result = '';
  for (const part of segmenter.segment(value)) {
    const text =
      part.segment === '\t'
        ? ' '.repeat(4 - (column % 4))
        : (part.segment.length > MAX_GRAPHEME_CODE_UNITS ? '…' : part.segment).replace(
            controls,
            (character) =>
              `\\x${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
          );
    result += text;
    column += stringWidth(text);
  }
  return result;
}

/** Clip display cells, replacing the visible half of a wide grapheme with spaces. */
export function sliceColumns(value: string, start: number, width: number): string {
  const left = columns(start);
  const size = columns(width);
  if (size === 0) return '';
  const right = left + size;
  const safe = visibleText(value);
  let column = 0;
  let result = '';
  for (const part of segmenter.segment(safe)) {
    const text = part.segment.length > MAX_GRAPHEME_CODE_UNITS ? '…' : part.segment;
    const cells = stringWidth(text);
    const end = column + cells;
    if (column >= right) break;
    if (end > left || (cells === 0 && column >= left)) {
      result +=
        column < left || end > right
          ? ' '.repeat(Math.max(0, Math.min(end, right) - Math.max(column, left)))
          : text;
    }
    column = end;
  }
  return result;
}

/** Produce exactly width safe display cells, without splitting graphemes. */
export function fitText(value: string, width: number): string {
  const size = columns(width);
  const text = sliceColumns(value, 0, size);
  return text + ' '.repeat(Math.max(0, size - stringWidth(text)));
}

function xmlState(value: string | undefined): XmlState {
  switch (value) {
    case 'attribute-single':
    case 'attribute-double':
    case 'comment':
    case 'cdata':
    case 'pi':
    case 'tag':
      return value;
    default:
      return 'text';
  }
}

/** Lex only the supplied visible line, including a preview continuation state. */
export function highlightXml(value: string, initialState?: string): readonly HighlightSpan[] {
  const safe = visibleText(value);
  const spans: HighlightSpan[] = [];
  let state = xmlState(initialState);
  let position = 0;
  let tagName = false;

  const append = (end: number, color?: string): void => {
    const text = safe.slice(position, end);
    const previous = spans.at(-1);
    if (previous && previous.color === color) previous.text += text;
    else if (text) spans.push(color === undefined ? { text } : { text, color });
    position = end;
  };

  while (position < safe.length) {
    if (state === 'comment' || state === 'cdata' || state === 'pi') {
      const delimiter = state === 'comment' ? '-->' : state === 'cdata' ? ']]>' : '?>';
      const color = state === 'comment' ? 'gray' : state === 'cdata' ? 'green' : 'magenta';
      const end = safe.indexOf(delimiter, position);
      append(end === -1 ? safe.length : end + delimiter.length, color);
      if (end !== -1) state = 'text';
      continue;
    }
    if (state === 'attribute-single' || state === 'attribute-double') {
      const end = safe.indexOf(state === 'attribute-single' ? "'" : '"', position);
      append(end === -1 ? safe.length : end + 1, 'green');
      if (end !== -1) state = 'tag';
      continue;
    }
    const character = safe[position]!;
    if (state === 'tag') {
      if (safe.startsWith('/>', position)) {
        append(position + 2, 'cyan');
        state = 'text';
      } else if (character === '>') {
        append(position + 1, 'cyan');
        state = 'text';
      } else if (character === "'" || character === '"') {
        append(position + 1, 'green');
        state = character === "'" ? 'attribute-single' : 'attribute-double';
      } else if (character === '=' || character === '/' || character === ' ') {
        let end = position + 1;
        if (character === ' ') while (safe[end] === ' ') end++;
        append(end, 'gray');
      } else {
        let end = position + 1;
        while (end < safe.length && !tagDelimiter.test(safe[end]!)) end++;
        append(end, tagName ? 'cyan' : 'yellow');
        tagName = false;
      }
      continue;
    }
    if (safe.startsWith('<!--', position)) {
      append(position + 4, 'gray');
      state = 'comment';
    } else if (safe.startsWith('<![CDATA[', position)) {
      append(position + 9, 'green');
      state = 'cdata';
    } else if (safe.startsWith('<?', position)) {
      append(position + 2, 'magenta');
      state = 'pi';
    } else if (character === '<') {
      append(position + (safe[position + 1] === '/' ? 2 : 1), 'cyan');
      state = 'tag';
      tagName = true;
    } else if (character === '&') {
      let end = position + 1;
      while (end < safe.length && !referenceDelimiter.test(safe[end]!)) end++;
      if (safe[end] === ';') end++;
      append(end, 'cyan');
    } else {
      let end = position + 1;
      while (end < safe.length && safe[end] !== '<' && safe[end] !== '&') end++;
      append(end);
    }
  }
  return spans;
}

/** Cursor positions are UTF-16 offsets in the original, unsanitized input. */
export function previousGrapheme(value: string, cursor: number): number {
  const position = Math.min(value.length, columns(cursor));
  let previous = 0;
  for (const part of segmenter.segment(value)) {
    if (part.index >= position) break;
    previous = part.index;
  }
  return previous;
}

export function nextGrapheme(value: string, cursor: number): number {
  const position = Math.min(value.length, columns(cursor));
  for (const part of segmenter.segment(value)) {
    const end = part.index + part.segment.length;
    if (end > position) return end;
  }
  return value.length;
}
