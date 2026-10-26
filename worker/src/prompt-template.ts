/** Fills {{name}} marks in one pass, so inserted data is never read as a mark; a missing or unused value is a bug. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const text = template.replace(/\{\{(\w+)\}\}/g, (_mark, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Prompt value is missing: ${name}`);
    used.add(name); return values[name];
  });
  for (const name of Object.keys(values)) if (!used.has(name)) throw new Error(`Prompt value is unused: ${name}`);
  return text;
}
