import { repairEscapedNewlines } from './escaped-text';

describe('repairEscapedNewlines', () => {
  it('turns double-escaped AI output back into real lines', () => {
    expect(repairEscapedNewlines('Environment Setup\\n- Version: 24.04\\n\\n### Context\\nDetails\\tinline'))
      .toBe('Environment Setup\n- Version: 24.04\n\n### Context\nDetails\tinline');
    expect(repairEscapedNewlines('Line one\\r\\nLine two\\r\\nLine three')).toBe('Line one\nLine two\nLine three');
  });

  it('leaves normal text and code samples with a literal "\\n" alone', () => {
    expect(repairEscapedNewlines('Plain text\nwith real lines')).toBe('Plain text\nwith real lines');
    expect(repairEscapedNewlines('Use printf "a\\nb" here')).toBe('Use printf "a\\nb" here');
    expect(repairEscapedNewlines('Intro\n\n```\nprintf("x\\n");\nputs("y\\n");\n```\nEnd')).toBe('Intro\n\n```\nprintf("x\\n");\nputs("y\\n");\n```\nEnd');
  });
});
