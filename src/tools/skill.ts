import { dirname, resolve } from 'path';
import { z } from 'zod';
import { defineTool } from './define-tool.js';
import { getSkill, discoverSkills } from '../skills/index.js';

/**
 * Rich description for the skill tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const SKILL_TOOL_DESCRIPTION = `
Execute a skill to get specialized instructions for complex tasks.

## When to Use

- When the user's query matches an available skill's description
- For complex workflows that benefit from structured guidance (e.g., subscription audit, tax prep)
- When you need step-by-step instructions for a specialized task

## When NOT to Use

- For simple queries that don't require specialized workflows
- When no available skill matches the task
- If you've already invoked the skill for this query (don't invoke twice)

## Usage Notes

- Only invoke a skill when no standard tool (transaction_search, spending_summary, etc.) handles the query directly
- The skill returns instructions that you should follow to complete the task
- Use the skill name exactly as listed in Available Skills
- Pass any relevant arguments (like date ranges) via the args parameter
`.trim();

/**
 * Skill invocation tool.
 * Loads and returns skill instructions for the agent to follow.
 */
export const skillTool = defineTool({
  name: 'skill',
  description: 'Execute a skill to get specialized instructions for a task. Returns instructions to follow.',
  schema: z.object({
    skill: z.string().describe('Name of the skill to invoke (e.g., "subscription-audit")'),
    args: z.string().optional().describe('Optional arguments for the skill (e.g., date range)'),
  }),
  func: async ({ skill, args }) => {
    const skillDef = await getSkill(skill);

    if (!skillDef) {
      const available = discoverSkills().map((s) => s.name).join(', ');
      return `Error: Skill "${skill}" not found. Available skills: ${available || 'none'}`;
    }

    // Check if this is a gated paid skill (stub has no real instructions)
    const metadata = discoverSkills().find((s) => s.name === skill);
    if (metadata?.tier === 'paid') {
      const { hasLicense } = await import('../licensing/license.js');
      if (!hasLicense(skill)) {
        return `The **${skillDef.name}** workflow requires a license. Run \`/license\` for details or visit openaccountant.ai/pricing.`;
      }
    }

    // Return instructions with optional args context
    let result = `## Skill: ${skillDef.name}\n\n`;

    if (args) {
      result += `**Arguments provided:** ${args}\n\n`;
    }

    // Resolve relative markdown links to absolute paths so the agent's
    // read_file tool can find referenced files (e.g., category-taxonomy.md).
    const skillDir = dirname(skillDef.path);
    const resolved = skillDef.instructions.replace(
      /\[([^\]]+)\]\(([^)]+\.md)\)/g,
      (_match, label, relPath) => {
        if (relPath.startsWith('/') || relPath.startsWith('http')) return _match;
        return `[${label}](${resolve(skillDir, relPath)})`;
      },
    );

    result += resolved;

    return result;
  },
});
