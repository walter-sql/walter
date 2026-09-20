import { getCollection, type CollectionEntry } from "astro:content";
import { sections } from "../content.config";

export type Doc = CollectionEntry<"docs">;

export const docPath = (doc: Doc) =>
  doc.id === "index" ? "/docs/" : `/docs/${doc.id}/`;

export async function orderedDocs(): Promise<Doc[]> {
  const docs = await getCollection("docs");
  return docs.sort(
    (a, b) =>
      sections.indexOf(a.data.section) - sections.indexOf(b.data.section) ||
      a.data.order - b.data.order
  );
}
