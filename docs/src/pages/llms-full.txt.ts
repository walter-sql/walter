import type { APIRoute } from "astro";
import { orderedDocs } from "../lib/docs";

export const GET: APIRoute = async () => {
  const docs = await orderedDocs();
  const body = docs
    .map(doc => `# ${doc.data.title}\n\n${doc.body?.trim()}`)
    .join("\n\n---\n\n");
  return new Response(body + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};
