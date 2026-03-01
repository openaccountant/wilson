/**
 * Source of a skill definition.
 * - builtin: Shipped with Wilson (src/skills/builtin/)
 * - user: User-level skills (~/.agentwilson/skills/)
 * - project: Project-level skills (.agentwilson/skills/)
 */
export type SkillSource = 'builtin' | 'user' | 'project';

/**
 * Tier for gating paid content.
 * - free: Available to everyone
 * - paid: Requires a valid license key
 */
export type SkillTier = 'free' | 'paid';

/**
 * Skill metadata - lightweight info loaded at startup for system prompt injection.
 * Only contains the name and description from YAML frontmatter.
 */
export interface SkillMetadata {
  /** Unique skill name (e.g., "subscription-audit") */
  name: string;
  /** Description of when to use this skill */
  description: string;
  /** Absolute path to the SKILL.md file */
  path: string;
  /** Where this skill was discovered from */
  source: SkillSource;
  /** Content tier — defaults to 'free' */
  tier: SkillTier;
}

/**
 * Full skill definition with instructions loaded on-demand.
 * Extends metadata with the full SKILL.md body content.
 */
export interface Skill extends SkillMetadata {
  /** Full instructions from SKILL.md body (loaded when skill is invoked) */
  instructions: string;
}
