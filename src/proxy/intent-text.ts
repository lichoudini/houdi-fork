export function normalizeIntentText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function stripQuotedExecutionNoise(text: string): string {
  const cleaned = text
    .replace(/(?:^|\n)\s*(?:contenido citado \(mensaje respondido\):|contexto citado:)\s*[\s\S]*$/i, " ")
    .replace(/\$\s+[^\n]+\n\[exit\s+\d+[^\]]*\][\s\S]*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || text.trim();
}
