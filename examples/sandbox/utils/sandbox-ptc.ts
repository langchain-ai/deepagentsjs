/* eslint-disable no-console */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VfsSandbox } from "@langchain/node-vfs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEPARTMENTS = [
  "Engineering",
  "Sales",
  "Marketing",
  "Finance",
  "Operations",
  "HR",
  "Legal",
  "Support",
];
const FIRST_NAMES = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Hank",
  "Iris",
  "Jack",
];
const LAST_NAMES = [
  "Smith",
  "Chen",
  "Patel",
  "Garcia",
  "Kim",
  "Müller",
  "Tanaka",
  "Silva",
  "Nguyen",
  "Lopez",
];

/**
 * Generate CSV data to analyze.
 */
export function generateCsv(n: number): string {
  const rows = ["id,name,age,department,years_at_company"];
  for (let i = 1; i <= n; i++) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last =
      LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length];
    rows.push(
      `${i},${first} ${last},${22 + ((i * 7) % 40)},${DEPARTMENTS[i % DEPARTMENTS.length]},${Math.max(1, (i * 3) % 25)}`,
    );
  }
  return rows.join("\n") + "\n";
}

/**
 * Load all SKILL.md files from the skills/ directory next to the examples
 * and return them as a record suitable for VfsSandbox `initialFiles`.
 * Skills are placed at `/skills/<name>/SKILL.md` inside the VFS.
 */
export function loadSkillFiles(): Record<string, string> {
  const skillsDir = path.resolve(__dirname, "..", "skills");
  const files: Record<string, string> = {};

  if (!fs.existsSync(skillsDir)) return files;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      files[`/skills/${entry.name}/SKILL.md`] = fs.readFileSync(
        skillMd,
        "utf8",
      );
    }
  }

  return files;
}

/**
 * Download deliverables from the sandbox into a local output folder.
 */
export async function downloadDeliverables(sandbox: VfsSandbox): Promise<void> {
  const outputDir = path.join(process.cwd(), "ptc-output");
  console.log(`\nDownloading deliverables to ${outputDir}/ ...`);

  const dirs = ["classifications", "analyst_reports"] as const;
  for (const dir of dirs) {
    const localDir = path.join(outputDir, dir);
    fs.mkdirSync(localDir, { recursive: true });

    const files = await sandbox.globInfo(`**/${dir}/*`, "/");
    if (files.length === 0) {
      const altFiles = await sandbox.globInfo(`**/*`, "/");
      const matching = altFiles.filter(
        (f) => f.path.includes(dir) || f.path.includes(dir.replace("_", "/")),
      );
      if (matching.length > 0) {
        for (const f of matching) {
          const downloaded = await sandbox.downloadFiles([`/${f.path}`]);
          if (downloaded[0]?.content) {
            const fileName = path.basename(f.path);
            fs.writeFileSync(
              path.join(localDir, fileName),
              downloaded[0].content,
            );
          }
        }
      }
      continue;
    }

    const paths = files.filter((f) => !f.is_dir).map((f) => `/${f.path}`);
    if (paths.length === 0) continue;

    const downloaded = await sandbox.downloadFiles(paths);
    for (const file of downloaded) {
      if (file.content) {
        const fileName = path.basename(file.path);
        fs.writeFileSync(path.join(localDir, fileName), file.content);
      }
    }
  }
}
