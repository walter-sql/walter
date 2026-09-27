import type { APIRoute } from "astro";
import { render } from "astro:content";
import { docPath, orderedDocs } from "../lib/docs";
import type { SearchDocument } from "../lib/search";

function searchableText(html: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return html
    .replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")
    .replace(
      /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (_, entity: string) => {
        const key = entity.toLowerCase();
        if (!key.startsWith("#")) return entities[key];
        return String.fromCodePoint(
          key.startsWith("#x")
            ? parseInt(key.slice(2), 16)
            : parseInt(key.slice(1), 10)
        );
      }
    )
    .replace(/\s+/g, " ")
    .trim();
}

export const GET: APIRoute = async () => {
  const docs = await orderedDocs();
  const index: SearchDocument[] = [];
  for (const doc of docs) {
    const { headings } = await render(doc);
    const bodies = doc
      .rendered!.html.split(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/g)
      .map(searchableText);
    const url = docPath(doc);
    index.push({
      title: doc.data.title,
      description: doc.data.description,
      section: doc.data.section,
      url,
      body: bodies[0]
    });
    headings.forEach((heading, i) => {
      index.push({
        title: heading.text,
        description: "",
        section: doc.data.title,
        url: `${url}#${heading.slug}`,
        body: bodies[i + 1]
      });
    });
  }
  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
