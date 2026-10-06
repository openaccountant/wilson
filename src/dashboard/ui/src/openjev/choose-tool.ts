/**
 * The app's `chooseTool` for the hybrid chat (Round 4, R4-6): turns the host's no-wait
 * `choose()` into a ToolChoice over the five read tools. Pure apart from the injected host.
 * Never throws; every "no" is null (the client then hands off as router-none).
 */
import { OPEN_JEV_ROUTE_OPTIONS, OPEN_JEV_ROUTE_QUESTION, isRouteTool, type ToolChoice } from '../hybrid/openjev-route.js';
import { CHOOSE_MAX_STATE_CHARS, type PrelabelPins } from '../prelabel/protocol.js';
import type { ChooseOptions, OpenJevHost } from './host.js';

export async function chooseToolWithHost(
  host: Pick<OpenJevHost, 'configure' | 'choose'>,
  req: { question: string; pins: PrelabelPins; signal?: ChooseOptions['signal'] },
): Promise<ToolChoice | null> {
  try {
    const state = req.question.trim().slice(0, CHOOSE_MAX_STATE_CHARS);
    if (state === '') return null;
    host.configure(req.pins);
    const out = await host.choose(
      {
        state,
        question: OPEN_JEV_ROUTE_QUESTION,
        // The five read tools and nothing else: `none` is never offered (the rule gate does that job).
        options: Object.keys(OPEN_JEV_ROUTE_OPTIONS),
        descriptions: { ...OPEN_JEV_ROUTE_OPTIONS },
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    if (!out || !isRouteTool(out.choice)) return null;
    return { tool: out.choice, p1: out.p1, p2: out.p2, margin: out.margin, top2: out.top2 };
  } catch {
    return null;
  }
}
