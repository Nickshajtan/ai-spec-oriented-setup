export function parseModelJson(content: string): Record<string, unknown> {
  const jsonText = extractJsonText(content.trim());

  try {
    const parsed = JSON.parse(jsonText);
    if (isObject(parsed)) return parsed;
  } catch {
    // handled below
  }

  throw new Error("Model returned invalid JSON.");
}

function extractJsonText(text: string): string {
  if (text.startsWith("{")) return text;

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]?.trim().startsWith("{")) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model output did not contain a JSON object.");
  }

  return text.slice(start, end + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
