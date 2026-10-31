// Copies the root LICENSE and README (and the docs with --docs) into the package in the
// current directory, so they ship to npm. Links that point outside the copied files are
// rewritten to GitHub, since npmjs.com would resolve them inside the package folder.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const packageDir = process.cwd();
const githubBlob = "https://github.com/Ez-Kits/sync/blob/main/";
const withDocs = process.argv.includes("--docs");

const copied = ["LICENSE", "README.md", ...(withDocs ? ["docs"] : [])];
const files = ["LICENSE", "README.md"];
if (withDocs) {
  rmSync(join(packageDir, "docs"), { recursive: true, force: true });
  for (const entry of readdirSync(join(root, "docs"), { recursive: true })) {
    const file = posix.join("docs", entry.split(sep).join("/"));
    if (statSync(join(root, file)).isFile()) files.push(file);
  }
}

const linkPattern = /\]\((?!https?:|mailto:|#)([^)\s#]+)(#[^)\s]*)?\)/g;

function rewriteLinks(markdown, file) {
  return markdown.replace(linkPattern, (link, target, hash = "") => {
    const path = posix.normalize(posix.join(posix.dirname(file), target));
    const isCopied = copied.some((entry) => path === entry || path.startsWith(`${entry}/`));
    return isCopied ? link : `](${githubBlob}${path}${hash})`;
  });
}

for (const file of files) {
  const source = join(root, file);
  const target = join(packageDir, file);
  mkdirSync(dirname(target), { recursive: true });
  if (file.endsWith(".md")) writeFileSync(target, rewriteLinks(readFileSync(source, "utf8"), file));
  else cpSync(source, target);
}
