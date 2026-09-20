import type { APIRoute } from "astro";
import { docPath, orderedDocs } from "../lib/docs";
import type { SearchDocument } from "../lib/search";

export const GET: APIRoute = async () => {
  const docs = await orderedDocs();
  const index: SearchDocument[] = docs.map(doc => ({
    title: doc.data.title,
    description: doc.data.description,
    section: doc.data.section,
    url: docPath(doc),
    body: (doc.body ?? "")
      .replace(/```[^\n]*\n/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<\/?[A-Za-z][^>]*>/g, " ")
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " ")
      .replace(/[#*`|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }));
  return new Response(JSON.stringify(index), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
};
