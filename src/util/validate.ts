// Minimal JSON-schema validator for the subset used by orchestrator output schemas.
// Agent output is untrusted: it is validated before any state transition depends on it.
export function validate(schema: any, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  if (!schema) return errs;
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: expected one of ${schema.enum.join('|')}`);
    return errs;
  }
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && (actual === 'integer' || actual === 'number')));
    if (!ok) {
      errs.push(`${path}: expected ${types.join('|')}, got ${actual}`);
      return errs;
    }
  }
  if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in v)) errs.push(`${path}.${r}: required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in v) errs.push(...validate(sub, v[k], `${path}.${k}`));
  }
  if (types.includes('array') && Array.isArray(value)) {
    value.forEach((item, i) => errs.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return errs.slice(0, 50);
}
