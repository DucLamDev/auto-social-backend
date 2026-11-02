/**
 * Some AI providers double-escape their JSON, so a body arrives with literal
 * "\n" sequences instead of line breaks and forums show "Setup\n- Version"
 * verbatim. Repair only text that is clearly in that state: escaped breaks
 * outnumber real ones (a code sample with a single "\n" stays untouched).
 */
export function repairEscapedNewlines(text: string): string {
  const literal = text.match(/(?:\\r)?\\n/g)?.length ?? 0;
  const real = text.match(/\n/g)?.length ?? 0;
  if (literal < 2 || literal <= real) return text;
  return text.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}
