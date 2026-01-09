---
name: skill-creator
description: "Guide for creating effective skills that extend agent capabilities with specialized knowledge, workflows, or tool integrations. Use this skill when the user asks to: create a skill, make a skill, build a skill, set up a skill, initialize a skill, scaffold a skill, update or modify an existing skill, validate a skill, learn about skill structure, understand how skills work, or get guidance on skill design patterns."
---

# Skill Creator

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained packages that extend agent capabilities by providing
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific
domains or tasks—they transform a general-purpose agent into a specialized agent
equipped with procedural knowledge and domain expertise.

### Skill Location for Deepagents

In deepagents CLI, skills are stored in `~/.deepagents/<agent>/skills/` where `<agent>` is your agent configuration name (default is `agent`). For example, with the default configuration, skills live at:

```txt
~/.deepagents/agent/skills/
├── skill-name-1/
│   └── SKILL.md
├── skill-name-2/
│   └── SKILL.md
└── ...
```

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with everything else the agent needs: system prompt, conversation history, other Skills' metadata, and the actual user request.

**Default assumption: The agent is already very capable.** Only add context the agent doesn't already have.

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

```txt
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter metadata (required)
│   │   ├── name: (required)
│   │   └── description: (required)
│   └── Markdown instructions (required)
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (TypeScript/JavaScript/etc.)
    ├── references/       - Documentation intended to be loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts, etc.)
```

## Skill Creation Process

Skill creation involves these steps:

1. Understand the skill with concrete examples
2. Plan reusable skill contents (scripts, references, assets)
3. Initialize the skill (run init_skill.ts)
4. Edit the skill (implement resources and write SKILL.md)
5. Validate the skill (run quick_validate.ts)
6. Iterate based on real usage

### Step 3: Initializing the Skill

When creating a new skill from scratch, run the `init_skill.ts` script:

```bash
npx tsx scripts/init_skill.ts <skill-name> --path <output-directory>
```

For deepagents, use the agent's skills directory:

```bash
npx tsx scripts/init_skill.ts <skill-name> --path ~/.deepagents/agent/skills
```

### Step 5: Validate the Skill

Once development of the skill is complete, validate it:

```bash
npx tsx scripts/quick_validate.ts <path/to/skill-folder>
```

The validation script checks:

- YAML frontmatter format and required fields
- Skill naming conventions (hyphen-case, max 64 characters)
- Description completeness (max 1024 characters)
- Required fields: `name` and `description`
