// The values of field facts: what the request sent at the fact's `at`,
// checked, never converted. A number must be a finite JSON number (not
// "1981"), a text a string of at most MAX_FIELD_TEXT characters, a flag
// true or false. Anything else is missing as "wrong_kind": a rule then does
// not match on it (three-valued logic), and `facts.<name>.missing` is true.

import {
  FactMissingError, FactUnavailableError, MAX_FIELD_TEXT,
  type FactProvider, type FactResult, type FieldFactQuery,
} from '@pointsman/module-api';

const SOURCE = 'request';

export class FieldFactProvider implements FactProvider<FieldFactQuery> {
  async lookup(query: FieldFactQuery): Promise<FactResult> {
    const v = query.value;
    switch (query.type) {
      case 'field_number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw wrong('a number');
        return { values: { value: v }, source: SOURCE };
      case 'field_text':
        if (typeof v !== 'string' || v.length > MAX_FIELD_TEXT) throw wrong(`a text of at most ${MAX_FIELD_TEXT} characters`);
        return { values: { value: v }, source: SOURCE };
      case 'field_flag':
        if (typeof v !== 'boolean') throw wrong('true or false');
        return { values: { value: v }, source: SOURCE };
      default:
        throw new FactUnavailableError(`no field type ${(query as { type: string }).type}`);
    }
  }
}

// The message names the expected kind only, never the value: it may be logged.
const wrong = (expected: string) => new FactMissingError('wrong_kind', `expected ${expected}`);
