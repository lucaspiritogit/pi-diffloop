import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bump = process.argv[2] ?? "patch";
const notesIndex = process.argv.indexOf("--notes");
const notes = notesIndex >= 0 ? process.argv.slice(notesIndex + 1).join(" ").trim() : "";

if (!["patch", "minor", "major"].includes(bump)) {
  console.error(`Invalid bump "${bump}". Use patch, minor, or major.`);
  process.exit(1);
}

execSync("npm run check", { stdio: "inherit" });
execSync(`npm version ${bump} -m "chore(release): v%s"`, { stdio: "inherit" });

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;

execSync("npm publish --access public", { stdio: "inherit" });

const releaseCommand = notes
  ? `gh release create ${tag} --title ${JSON.stringify(tag)} --notes ${JSON.stringify(notes)}`
  : `gh release create ${tag} --title ${JSON.stringify(tag)} --generate-notes`;

execSync(releaseCommand, { stdio: "inherit" });
execSync("git push origin HEAD --tags", { stdio: "inherit" });

console.log(`Released ${tag} to npm and GitHub.`);
