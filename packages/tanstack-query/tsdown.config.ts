import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/**/*.ts",
  unbundle: true,
  format: "esm",
  fixedExtension: false,
  sourcemap: false,
  dts: true
});
