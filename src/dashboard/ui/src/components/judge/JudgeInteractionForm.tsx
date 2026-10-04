import { useState } from 'react';
import { useDeclarativeTool } from '@/agent/useDeclarativeTool';
import { AgentFilledBanner } from '@/components/agent/AgentFilledBanner';

/**
 * "Agent judgement": the declarative WebMCP tool `propose_judgment`, below the human rating controls. Only an
 * agent can submit it: a person's submit is always blocked with a message (the routing table says a proposal form
 * is for agents), so a human label can never come from here. The agent's submit becomes a proposal, which waits for
 * its approval card unless the user allowed proposals; either way it only lands in the Judge queue as `proposed`.
 * The human rating controls above never carry a tool name, and this form never auto-submits.
 */
export function JudgeInteractionForm({ interactionId, onSettled }: { interactionId: number; onSettled: () => void }) {
  const [rating, setRating] = useState('');
  const [preference, setPreference] = useState('');
  const [rationale, setRationale] = useState('');
  const [judgeModel, setJudgeModel] = useState('');

  const declarative = useDeclarativeTool({
    tool: 'propose_judgment',
    onAgentCleared: () => {
      setRating('');
      setPreference('');
      setRationale('');
      setJudgeModel('');
    },
    // The agent's call ended (approved, rejected, expired...): the queue and the stats may have changed. Refresh once the
    // agent has its answer, never mid-call.
    onSettled,
  });

  const field =
    'bg-surface border border-border rounded px-2 py-1 text-xs text-text focus:outline-none focus:border-green';

  return (
    <div className="border-l-2 border-yellow pl-3 space-y-2" data-testid="judge-interaction-form">
      <div className="text-[10px] uppercase tracking-wide font-medium text-yellow">Agent judgement</div>
      {declarative.agentTouched && <AgentFilledBanner />}
      <form key={declarative.formKey} className="flex flex-wrap items-end gap-3" aria-label="Agent judgement" {...declarative.formProps}>
        <input type="number" name="interaction_id" step="any" value={interactionId} readOnly aria-label="Interaction" className={`${field} w-20 font-mono`} {...declarative.field('interaction_id')} />
        <label className="text-xs text-text-muted">
          <span className="block mb-0.5">Rating</span>
          <select name="rating" value={rating} onChange={(e) => setRating(e.target.value)} className={field} {...declarative.field('rating')}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-muted">
          <span className="block mb-0.5">Preference</span>
          <select name="preference" value={preference} onChange={(e) => setPreference(e.target.value)} className={field} {...declarative.field('preference')}>
            <option value="">—</option>
            <option value="chosen">chosen</option>
            <option value="rejected">rejected</option>
            <option value="neutral">neutral</option>
          </select>
        </label>
        <label className="text-xs text-text-muted">
          <span className="block mb-0.5">Judge model</span>
          <input type="text" name="judge_model" value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} maxLength={64} className={`${field} w-36 font-mono`} {...declarative.field('judge_model')} />
        </label>
        <label className="text-xs text-text-muted flex-1 min-w-[220px]">
          <span className="block mb-0.5">Rationale</span>
          <textarea name="rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} maxLength={600} className={`${field} w-full resize-none`} {...declarative.field('rationale')} />
        </label>
        <button type="submit" className="bg-surface-raised border border-border text-text-secondary text-xs font-medium px-3 py-1.5 rounded-md cursor-pointer hover:text-text">
          Submit judgement (agents only)
        </button>
      </form>
      {declarative.blockedMessage && (
        <p role="status" className="text-xs text-yellow m-0">
          {declarative.blockedMessage}
        </p>
      )}
    </div>
  );
}
