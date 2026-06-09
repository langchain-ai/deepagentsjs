/**
 * Test data generators for swarm vs baseline evals.
 *
 * Each generator returns a Record<string, string> suitable for
 * `initialFiles` and a ground-truth manifest for scoring.
 */

// ---------------------------------------------------------------------------
// Pattern 1 — Classify-And-Act: support tickets
// ---------------------------------------------------------------------------

const TICKET_CATEGORIES = ["billing", "technical", "account", "other"] as const;

const TICKET_TEMPLATES: {
  category: (typeof TICKET_CATEGORIES)[number];
  urgency: "low" | "high";
  body: string;
}[] = [
  {
    category: "billing",
    urgency: "high",
    body: "I was charged twice for my subscription this month. Order #{{id}}. Please refund immediately.",
  },
  {
    category: "billing",
    urgency: "low",
    body: "Can you explain the line items on my last invoice? Order #{{id}}.",
  },
  {
    category: "technical",
    urgency: "high",
    body: "API returns 500 errors on every request since this morning. Blocking production deployment. Ref #{{id}}.",
  },
  {
    category: "technical",
    urgency: "low",
    body: "The dashboard takes 10+ seconds to load. Not urgent but annoying. Ref #{{id}}.",
  },
  {
    category: "account",
    urgency: "high",
    body: "I can't log in — password reset emails never arrive. Locked out of my account. User #{{id}}.",
  },
  {
    category: "account",
    urgency: "low",
    body: "How do I change the email address on my account? User #{{id}}.",
  },
  {
    category: "other",
    urgency: "low",
    body: "Do you have an affiliate program? Interested in partnering. Inquiry #{{id}}.",
  },
  {
    category: "other",
    urgency: "low",
    body: "Where can I find your public roadmap? Inquiry #{{id}}.",
  },
  {
    category: "technical",
    urgency: "high",
    body: "Webhook deliveries are failing with TLS handshake errors. Our integration is down. Ref #{{id}}.",
  },
  {
    category: "billing",
    urgency: "low",
    body: "I'd like to switch from monthly to annual billing. Order #{{id}}.",
  },
];

export interface TicketGroundTruth {
  id: string;
  path: string;
  category: (typeof TICKET_CATEGORIES)[number];
  urgency: "low" | "high";
}

export function generateTickets(n: number): {
  files: Record<string, string>;
  groundTruth: TicketGroundTruth[];
} {
  const files: Record<string, string> = {};
  const groundTruth: TicketGroundTruth[] = [];

  for (let i = 0; i < n; i++) {
    const template = TICKET_TEMPLATES[i % TICKET_TEMPLATES.length];
    const id = String(i + 1).padStart(3, "0");
    const path = `/tickets/ticket-${id}.json`;
    const body = template.body.replace("{{id}}", id);

    // NOTE: urgency is NOT written to the file — the agent must infer it
    // from the body text. Only category-relevant content is provided.
    files[path] = JSON.stringify({ id: `ticket-${id}`, body }, null, 2);

    groundTruth.push({
      id: `ticket-${id}`,
      path,
      category: template.category,
      urgency: template.urgency,
    });
  }

  return { files, groundTruth };
}

// ---------------------------------------------------------------------------
// Pattern 2 & 3 — Code files with seeded vulnerabilities
// ---------------------------------------------------------------------------

export interface VulnerabilityGroundTruth {
  file: string;
  vulnType: string;
  line: number;
  description: string;
}

/** Deterministic PRNG (mulberry32) — same seed always yields the same stream. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, arr: T[]): T =>
  arr[Math.floor(r() * arr.length)];
const randInt = (r: () => number, min: number, max: number): number =>
  min + Math.floor(r() * (max - min + 1));

const NOUNS = [
  "user", "order", "invoice", "account", "session", "payment", "report",
  "profile", "token", "record", "ticket", "asset", "device", "webhook",
  "job", "entry", "node", "message", "config", "subscription",
];
const VERBS = [
  "get", "list", "create", "update", "delete", "fetch", "load", "sync",
  "resolve", "validate", "render", "parse", "build", "handle", "process",
  "compute", "format", "map", "filter", "check", "export", "import",
];

function ident(r: () => number): string {
  const noun = pick(r, NOUNS);
  return pick(r, VERBS) + noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** Clean function templates — varied shapes, no vulnerabilities. */
const CLEAN_FUNCS: Array<(r: () => number, name: string) => string> = [
  (_r, n) => `export function ${n}(req: Request, res: Response): void {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  res.json({ id, ok: true });
}`,
  (r, n) => `export async function ${n}(input: { id: string }): Promise<Record<string, unknown>> {
  const rows = await db.select("*").from("${pick(r, NOUNS)}s").where({ id: input.id }).limit(1);
  if (rows.length === 0) throw new Error("not found");
  return rows[0];
}`,
  (_r, n) => `export function ${n}(values: number[]): number {
  return values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
}`,
  (_r, n) => `export function ${n}(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}`,
  (_r, n) => `export async function ${n}(items: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const it of items) {
    if (it && it.length <= 256) out.push(it.trim());
  }
  return out;
}`,
  (_r, n) => `export function ${n}(payload: Record<string, unknown>): boolean {
  const required = ["id", "type", "createdAt"];
  return required.every((k) => k in payload && payload[k] != null);
}`,
  (r, n) => `export function ${n}(a: number, b: number): number {
  const ratio = b === 0 ? 0 : a / b;
  return Math.round(ratio * ${randInt(r, 10, 1000)}) / ${randInt(r, 10, 1000)};
}`,
  (_r, n) => `export function ${n}(events: { ts: number; kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return counts;
}`,
];

/**
 * Vulnerable function templates. `vulnLine` is the 1-based offset of the
 * vulnerable line within the rendered function (used only for an
 * informational ground-truth line number; scoring matches on file + type).
 */
const VULN_FUNCS: Array<{
  vulnType: string;
  description: string;
  vulnLine: number;
  make: (r: () => number, name: string) => string;
}> = [
  {
    vulnType: "sql-injection",
    description: "User input concatenated into a SQL query",
    vulnLine: 3,
    make: (r, n) => `export async function ${n}(req: Request, res: Response): Promise<void> {
  const q = req.query.q as string;
  const rows = await db.raw("SELECT * FROM ${pick(r, NOUNS)}s WHERE name = '" + q + "'");
  res.json(rows);
}`,
  },
  {
    vulnType: "path-traversal",
    description: "User-controlled path used directly in a file read",
    vulnLine: 3,
    make: (_r, n) => `export function ${n}(req: Request, res: Response): void {
  const f = req.query.file as string;
  const data = fs.readFileSync("/data/" + f, "utf-8");
  res.send(data);
}`,
  },
  {
    vulnType: "xss",
    description: "Unescaped user input rendered into HTML",
    vulnLine: 3,
    make: (_r, n) => `export function ${n}(req: Request, res: Response): void {
  const name = req.query.name;
  res.send("<div class='welcome'>Hello " + name + "</div>");
}`,
  },
  {
    vulnType: "command-injection",
    description: "User input passed to a shell command",
    vulnLine: 3,
    make: (_r, n) => `export function ${n}(req: Request, res: Response): void {
  const host = req.query.host as string;
  const out = execSync("ping -c 1 " + host).toString();
  res.send(out);
}`,
  },
  {
    vulnType: "insecure-deserialization",
    description: "Prototype pollution via untrusted object merge",
    vulnLine: 4,
    make: (_r, n) => `export function ${n}(req: Request, res: Response): void {
  const body = req.body;
  const cfg = Object.assign({}, body);
  if (body.__proto__) Object.setPrototypeOf({}, body.__proto__);
  res.json({ ok: true, cfg });
}`,
  },
  {
    vulnType: "ssrf",
    description: "User-controlled URL fetched server-side",
    vulnLine: 3,
    make: (_r, n) => `export async function ${n}(req: Request, res: Response): Promise<void> {
  const url = req.query.url as string;
  const upstream = await fetch(url);
  res.send(await upstream.text());
}`,
  },
  {
    vulnType: "hardcoded-secret",
    description: "Hardcoded credential / API key in source",
    vulnLine: 2,
    make: (r, n) => `export function ${n}(): string {
  const apiKey = "sk_live_${Math.floor(r() * 1e9).toString(36)}f1e2d3c4b5a6";
  return apiKey;
}`,
  },
  {
    vulnType: "weak-crypto",
    description: "Weak hash (MD5) used for passwords",
    vulnLine: 3,
    make: (_r, n) => `export function ${n}(password: string): string {
  const crypto = require("crypto");
  return crypto.createHash("md5").update(password).digest("hex");
}`,
  },
];

const FILE_HEADER = `import { Request, Response } from "express";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { db } from "./db";
`;

/** Fixed base seed — generation is reproducible across runs and conditions. */
const CODE_SEED_BASE = 0x5eed;

/**
 * Generate `n` TypeScript modules with seeded vulnerabilities.
 *
 * Each file is procedurally composed from a seeded PRNG: 8-28 functions of
 * varied shape, with 0-3 distinct vulnerability types buried among
 * realistic clean code (~45% of files are clean). Output is deterministic
 * by file index — identical across conditions and reproducible run-to-run —
 * while every file looks different, so the model can't pattern-match.
 */
export function generateCodeFiles(n: number): {
  files: Record<string, string>;
  groundTruth: VulnerabilityGroundTruth[];
} {
  const files: Record<string, string> = {};
  const groundTruth: VulnerabilityGroundTruth[] = [];

  for (let i = 0; i < n; i++) {
    const r = makeRng(CODE_SEED_BASE + i);
    const id = String(i + 1).padStart(4, "0");
    const path = `/src/module-${id}.ts`;

    const funcCount = randInt(r, 8, 28);
    const vulnCount = r() < 0.45 ? 0 : randInt(r, 1, 3);

    // Distinct vuln types for this file (so (file, type) is unique in GT).
    const types = new Set<number>();
    while (types.size < vulnCount) types.add(randInt(r, 0, VULN_FUNCS.length - 1));
    // Which function slots are vulnerable.
    const slots = new Set<number>();
    while (slots.size < vulnCount) slots.add(randInt(r, 0, funcCount - 1));
    const slotList = [...slots];
    const typeList = [...types];

    const usedNames = new Set<string>();
    const nextName = (): string => {
      let nm: string;
      do {
        nm = ident(r);
      } while (usedNames.has(nm));
      usedNames.add(nm);
      return nm;
    };

    let body = FILE_HEADER + "\n";
    for (let f = 0; f < funcCount; f++) {
      const name = nextName();
      const slotIdx = slotList.indexOf(f);
      if (slotIdx !== -1) {
        const v = VULN_FUNCS[typeList[slotIdx]];
        const startLine = body.split("\n").length;
        groundTruth.push({
          file: path,
          vulnType: v.vulnType,
          line: startLine + v.vulnLine - 1,
          description: v.description,
        });
        body += v.make(r, name) + "\n\n";
      } else {
        body += pick(r, CLEAN_FUNCS)(r, name) + "\n\n";
      }
    }

    files[path] = body.trimEnd() + "\n";
  }

  return { files, groundTruth };
}

// ---------------------------------------------------------------------------
// Pattern 4 — Generate-And-Filter: auth module with edge cases
// ---------------------------------------------------------------------------

export function generateAuthModule(): { files: Record<string, string> } {
  return generateAuthModules(1);
}

/**
 * Generate `n` independent auth modules under `/src/`.
 *
 * The first is `/src/auth.ts`; subsequent ones are `/src/auth2.ts`,
 * `/src/auth3.ts`, etc. Every module exposes the same function set
 * (register, login, authMiddleware, changePassword, deleteUser) so the
 * generate-and-filter rubric applies at any scale. Because the modules
 * are near-identical, cross-module deduplication becomes the core
 * challenge as `n` grows.
 */
export function generateAuthModules(n: number): {
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const label = i === 0 ? "auth" : `auth${i + 1}`;
    files[`/src/${label}.ts`] = authModuleSource(label);
  }
  return { files };
}

/**
 * Render the source for a single auth module, tagged with `label` so each
 * generated file is textually distinct.
 */
function authModuleSource(label: string): string {
  return `\
// Module: ${label}
import { Request, Response, NextFunction } from "express";
import * as jwt from "jsonwebtoken";
import * as bcrypt from "bcrypt";

const JWT_SECRET = process.env.JWT_SECRET || "default-secret";
const TOKEN_EXPIRY = "24h";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user" | "viewer";
  loginAttempts: number;
  lockedUntil: Date | null;
}

const users = new Map<string, User>();

export async function register(
  email: string,
  password: string,
  role: "admin" | "user" | "viewer" = "user",
): Promise<User> {
  if (users.has(email)) {
    throw new Error("User already exists");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user: User = {
    id: Math.random().toString(36).slice(2),
    email,
    passwordHash,
    role,
    loginAttempts: 0,
    lockedUntil: null,
  };
  users.set(email, user);
  return user;
}

export async function login(
  email: string,
  password: string,
): Promise<{ token: string }> {
  const user = users.get(email);
  if (!user) {
    throw new Error("Invalid credentials");
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new Error("Account locked. Try again later.");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    user.loginAttempts += 1;
    if (user.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    }
    throw new Error("Invalid credentials");
  }

  user.loginAttempts = 0;
  user.lockedUntil = null;

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY },
  );

  return { token };
}

export function authMiddleware(requiredRole?: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new Error("Missing authorization header");
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
      role: string;
    };

    if (requiredRole && decoded.role !== requiredRole) {
      throw new Error("Insufficient permissions");
    }

    (req as any).user = decoded;
    next();
  };
}

export async function changePassword(
  email: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const user = users.get(email);
  if (!user) {
    throw new Error("User not found");
  }

  const valid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid current password");
  }

  if (newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters");
  }

  user.passwordHash = await bcrypt.hash(newPassword, 10);
}

export async function deleteUser(
  requesterId: string,
  targetEmail: string,
): Promise<void> {
  const requester = [...users.values()].find((u) => u.id === requesterId);
  if (!requester || requester.role !== "admin") {
    throw new Error("Only admins can delete users");
  }

  if (!users.has(targetEmail)) {
    throw new Error("User not found");
  }

  users.delete(targetEmail);
}
`;
}
