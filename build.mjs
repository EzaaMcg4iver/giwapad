import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public/index.html", "dist/index.html");
cpSync("src/styles.css", "dist/styles.css");

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  outfile: "dist/bundle.js",
  logLevel: "info",
});
console.log("Built dist/ — serve with: npm run serve");
