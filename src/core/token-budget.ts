import { XmlError } from './errors.js';

type State = 'text' | 'reference' | 'tag' | 'markup-prefix' | 'comment' | 'pi' | 'cdata';

/** A pre-parser resource guard, deliberately not an XML grammar validator. */
export class TokenBudget {
  private state: State = 'text';
  private length = 0;
  private prefix = '';
  private quote = '';
  private tail = '';

  constructor(private readonly maxTokenCodeUnits: number) {
    if (!Number.isSafeInteger(maxTokenCodeUnits) || maxTokenCodeUnits <= 0) {
      throw new RangeError('maxTokenCodeUnits must be a positive safe integer');
    }
  }

  scan(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (this.state === 'cdata') {
        if (char === '>' && this.tail === ']]') {
          this.state = 'text';
          this.tail = '';
        } else {
          this.tail = char === ']' ? `${this.tail}]`.slice(-2) : '';
        }
        continue;
      }
      if (this.state === 'text') {
        if (char === '<' || char === '&') {
          this.length = 1;
          this.checkLength();
          this.state = char === '<' ? 'markup-prefix' : 'reference';
          this.prefix = char === '<' ? '<' : '';
        }
        continue;
      }
      this.length++;
      this.checkLength();
      if (this.state === 'reference') {
        if (char === ';') this.state = 'text';
      } else if (this.state === 'markup-prefix') {
        this.prefix += char;
        if (this.prefix === '<!DOCTYPE') {
          throw new XmlError('ERR_XML_DTD', 'DOCTYPE declarations are not supported');
        }
        if (this.prefix === '<!--') {
          this.state = 'comment';
          this.tail = '';
        } else if (this.prefix === '<?') {
          this.state = 'pi';
          this.tail = '';
        } else if (this.prefix === '<![CDATA[') {
          this.state = 'cdata';
          this.tail = '';
        } else if (
          !['<!--', '<?', '<![CDATA[', '<!DOCTYPE'].some((value) => value.startsWith(this.prefix))
        ) {
          this.state = 'tag';
          this.quote = '';
          this.scanTagCharacter(char);
        }
      } else if (this.state === 'tag') {
        this.scanTagCharacter(char);
      } else if (this.state === 'comment') {
        if (char === '>' && this.tail === '--') {
          this.state = 'text';
          this.tail = '';
        } else {
          this.tail = char === '-' ? `${this.tail}-`.slice(-2) : '';
        }
      } else if (this.state === 'pi') {
        if (char === '>' && this.tail === '?') {
          this.state = 'text';
          this.tail = '';
        } else {
          this.tail = char === '?' ? '?' : '';
        }
      }
    }
  }

  private scanTagCharacter(char: string): void {
    if (this.quote) {
      if (char === this.quote) this.quote = '';
    } else if (char === '"' || char === "'") {
      this.quote = char;
    } else if (char === '>') {
      this.state = 'text';
    }
  }

  private checkLength(): void {
    if (this.length > this.maxTokenCodeUnits) {
      throw new XmlError(
        'ERR_XML_LIMIT',
        `XML markup or reference exceeds ${this.maxTokenCodeUnits} code units`,
      );
    }
  }
}
