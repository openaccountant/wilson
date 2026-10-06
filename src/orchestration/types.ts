import type { ApprovalDecision, ToolApprovalRequest } from '../agent/types.js';

/**
 * Chain orchestration — sequential multi-step workflows.
 * Each step runs as a mini agent loop with its own tools and optional system prompt.
 */
export interface ChainStep {
  /** Unique step identifier */
  id: string;
  /** Optional system prompt override for this step */
  systemPrompt?: string;
  /** Tool names available to this step (resolved at runtime from registry) */
  tools?: string[];
  /** Model override for this step */
  model?: string;
  /** Max agent iterations for this step (default: 5) */
  maxIterations?: number;
}

export interface ChainDef {
  name: string;
  description: string;
  steps: ChainStep[];
  /** Content tier — defaults to 'free' */
  tier?: 'free' | 'paid';
}

/**
 * How chain steps and team members reach the parent agent's approval gate
 * (src/agent/approval-gate.ts). Every mutating tool call they make is asked
 * through `requestToolApproval`; without it, those calls are denied.
 */
export interface OrchestrationApprovalOptions {
  /** The parent agent's approval handler (the runner's approval card). */
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  /** The parent agent's session approvals, honoured and extended like the agent's own. */
  sessionApprovedTools?: Set<string>;
}

export interface ChainRunOptions extends OrchestrationApprovalOptions {
  /** Model to use (can be overridden per-step) */
  model?: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Called with progress updates */
  onStepComplete?: (stepId: string, output: string) => void;
}

/**
 * Team orchestration — dispatcher + parallel specialists.
 */
export interface TeamMember {
  /** Unique member identifier */
  id: string;
  /** Optional system prompt for this member */
  systemPrompt?: string;
  /** Tool names available to this member */
  tools?: string[];
  /** Model override for this member */
  model?: string;
  /** Max agent iterations (default: 5) */
  maxIterations?: number;
}

export interface TeamDef {
  name: string;
  description: string;
  dispatcher: {
    systemPrompt?: string;
    model?: string;
  };
  members: TeamMember[];
}

export interface TeamRunOptions extends OrchestrationApprovalOptions {
  /** Model to use for dispatcher and members (can be overridden) */
  model?: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Called when a member completes */
  onMemberComplete?: (memberId: string, output: string) => void;
}
