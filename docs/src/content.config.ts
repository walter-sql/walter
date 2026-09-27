import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const sections = [
  "Start here",
  "Build your app",
  "Operations",
  "Reference",
  "Background"
] as const;

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(sections),
    order: z.number(),
    parent: z.string().optional(),
    diagram: z
      .enum(["data-path", "read-write", "scaling", "subscription"])
      .optional()
  })
});

export const collections = { docs };
