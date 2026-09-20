export interface SearchDocument {
  title: string;
  description: string;
  section: string;
  url: string;
  body: string;
}

export interface SearchResult extends SearchDocument {
  excerpt: string;
}

const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export function queryTerms(query: string): string[] {
  return [
    ...new Set(normalize(query).match(/[\p{L}\p{N}_@.-]+/gu) ?? [])
  ].slice(0, 12);
}

function excerptFor(doc: SearchDocument, terms: string[]): string {
  if (terms.some(term => normalize(doc.description).includes(term)))
    return doc.description;
  const body = normalize(doc.body);
  const start = Math.min(
    ...terms.map(term => body.indexOf(term)).filter(index => index >= 0)
  );
  if (!Number.isFinite(start)) return doc.description;
  const from = Math.max(
    0,
    doc.body.lastIndexOf(" ", Math.max(0, start - 65)) + 1
  );
  const limit = from + 200;
  const boundary = doc.body.lastIndexOf(" ", limit);
  const to =
    limit < doc.body.length && boundary > start ? boundary : doc.body.length;
  return `${from > 0 ? "…" : ""}${doc.body.slice(from, to).trim()}${to < doc.body.length ? "…" : ""}`;
}

export function searchDocuments(
  docs: SearchDocument[],
  query: string
): SearchResult[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const phrase = normalize(query.trim());
  return docs
    .map(doc => {
      const title = normalize(doc.title);
      const description = normalize(doc.description);
      const body = normalize(doc.body);
      const section = normalize(doc.section);
      let score = title === phrase ? 120 : title.includes(phrase) ? 60 : 0;
      for (const term of terms) {
        if (title.includes(term)) score += 24;
        else if (description.includes(term)) score += 10;
        else if (section.includes(term)) score += 5;
        else if (body.includes(term)) score += 1;
        else return { doc, score: 0 };
      }
      return { doc, score };
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ doc }) => ({ ...doc, excerpt: excerptFor(doc, terms) }));
}
