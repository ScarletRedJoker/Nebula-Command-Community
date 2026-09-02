import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const path of ["src", "public", "migrations", "package.json", "README.md", "LICENSE"]) await cp(path, `dist/${path}`, { recursive: true });
console.log("Built dist/");