import type { APIRoute } from "astro";
import { sections } from "../content.config";
import { docPath, orderedDocs } from "../lib/docs";

export const GET: APIRoute = async ({ site }) => {
  const docs = await orderedDocs();
  const lines = [
    "# Walter",
    "",
    "> Walter maintains SQL query results from Postgres and streams snapshots and updates to your application server. These docs cover database setup, application integration, supported SQL, and deployment.",
    "",
    `Full documentation in one file: ${new URL("/llms-full.txt", site)}`
  ];
  for (const section of sections) {
    lines.push("", `## ${section}`, "");
    for (const doc of docs.filter(d => d.data.section === section)) {
      lines.push(
        `- [${doc.data.title}](${new URL(docPath(doc), site)}): ${doc.data.description}`
      );
    }
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};
