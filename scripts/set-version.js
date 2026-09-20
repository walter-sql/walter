import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: pnpm set-version <version>");
  process.exit(1);
}
for (const dir of readdirSync("packages")) {
  const path = `packages/${dir}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}
