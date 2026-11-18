#!/usr/bin/env node
/**
 * Preflight check ensuring no PII, local Windows paths, cookies, tokens, or
 * balance artifacts leak into the published npm tarball or package manifest.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectFiles(relTarget) {
  const full = path.join(ROOT, relTarget);
  if (!fs.existsSync(full)) return [];
  const stat = fs.statSync(full);
  if (stat.isFile()) return [relTarget];
  if (!stat.isDirectory()) return [];

  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const childRel = path.join(relTarget, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(childRel));
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

const FORBIDDEN_PATTERNS = [
  { name: "local username (Eric1)", re: /Eric1/i },
  { name: "Windows user path", re: /[A-Za-z]:\\{1,2}Users\\{1,2}/i },
  { name: "POSIX user path", re: /\/Users\/Eric/i },
  { name: "BDUSS cookie value", re: /BDUSS\s*=/i },
  { name: "bce-sessionid cookie value", re: /bce-sessionid\s*=\s*[^\s"'`;]{6,}/i },
  { name: "JWT bearer token", re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "account quota figure", re: /\b(38303|38700)\b/ },
];

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const declaredFiles = Array.isArray(pkg.files) ? pkg.files : [];

for (const entry of declaredFiles) {
  const normalized = String(entry).replace(/\\/g, "/");
  if (/rates-report\.json$/i.test(normalized) || /\.tgz$/i.test(normalized)) {
    console.error(`check-pii: forbidden entry in package.json "files": ${entry}`);
    process.exit(1);
  }
}

const targets = new Set(["package.json", "README.md", "LICENSE", "cordis.patch.yml", "lib"]);
for (const entry of declaredFiles) {
  targets.add(String(entry));
}

const filesToScan = [];
for (const rel of targets) {
  filesToScan.push(...collectFiles(rel));
}
const uniqueFiles = [...new Set(filesToScan.map((f) => f.replace(/\\/g, "/")))].sort();

const violations = [];
for (const rel of uniqueFiles) {
  if (/rates-report\.json$/i.test(rel) || /\.tgz$/i.test(rel)) {
    violations.push({ file: rel, line: 0, rule: "forbidden artifact in tarball set" });
    continue;
  }
  const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.re.test(lineText)) {
        violations.push({ file: rel, line: i + 1, rule: rule.name });
      }
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`check-pii: FAIL ${v.file}:${v.line} matched [${v.rule}]`);
  }
  process.exit(1);
}

console.log(`check-pii: OK (${uniqueFiles.length} published files verified)`);
