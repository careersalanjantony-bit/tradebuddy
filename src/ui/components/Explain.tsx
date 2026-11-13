import { useMemo, useState } from 'preact/hooks';
import { explainSnapshot, type Verdict } from '../../advisor/explain';
import { buildStudyPrompt, type StudyPromptInput } from '../../advisor/studyPrompt';
import type { TechSnapshot } from '../../indicators/snapshot';

const VERDICT_TIP: Record<Verdict, string> = {
  'Good setup': 'Matches a playbook setup and is not stretched. Still check the results date and plan the risk.',
  Wait: 'Interesting, but not now: stretched after a run, or the trend is not confirmed yet.',
  Avoid: 'Below the 200-day average or in a downtrend — the playbook says no swing buys.',
  'No setup': 'Nothing to do with this stock right now.',
  'Check data': 'The price history may be wrong — check the stock page before trusting any number.',
};

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const tone = verdict === 'Good setup' ? 'good' : verdict === 'Wait' ? 'wait' : verdict === 'Avoid' || verdict === 'Check data' ? 'bad' : 'neutral';
  return (
    <span class={`chip verdict ${tone}`} title={VERDICT_TIP[verdict]} data-verdict={verdict}>
      {verdict}
    </span>
  );
}

/** Plain-English reading of a stock (top of the stock page). */
export function ExplainCard({ symbol, snap }: { symbol: string; snap: TechSnapshot }) {
  const e = useMemo(() => explainSnapshot(symbol, snap), [symbol, snap]);
  return (
    <section class={`card explain ${e.tone}`} data-testid="explain">
      <div class="row">
        <h2 style={{ margin: 0 }}>In plain words</h2>
        <span class="spacer" />
        <VerdictChip verdict={e.verdict} />
      </div>
      <p style={{ marginBottom: '4px' }}>{e.summary}</p>
      {e.entryHint && (
        <p class="small" style={{ margin: '4px 0' }}>
          <b>What to do:</b> {e.entryHint}
        </p>
      )}
      <ul class="small points">
        {e.points.map((p) => (
          <li>{p}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Study with Claude" — copies a ready-made question (with this tool's numbers) for Claude chat,
 * which the owner's subscription already covers. No API call, no extra billing.
 */
export function StudyButton({ input, label = 'Copy study question for Claude' }: { input: StudyPromptInput | null; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [show, setShow] = useState(false);
  const prompt = useMemo(() => (input ? buildStudyPrompt(input) : ''), [input]);
  if (!input) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setState('copied');
    } catch {
      setState('failed');
      setShow(true);
    }
  };
  return (
    <div class="study" data-testid="study">
      <div class="row">
        <button class="btn small" type="button" onClick={() => void copy()}>
          {state === 'copied' ? '✓ Copied' : label}
        </button>
        <a class="btn small" href="https://claude.ai/new" target="_blank" rel="noreferrer">
          Open Claude chat
        </a>
        <button class="link-btn" type="button" onClick={() => setShow(!show)}>
          {show ? 'hide' : 'show'} question
        </button>
      </div>
      <p class="tiny muted">
        Paste it into Claude chat: Claude searches the web for the latest results, news and risks and gives a Strong / Acceptable / Weak / Avoid verdict. Free with your Claude
        subscription.{state === 'failed' ? ' Copy did not work — select the text below and copy it.' : ''}
      </p>
      {show && <textarea class="prompt" readOnly rows={10} value={prompt} data-testid="study-prompt" />}
    </div>
  );
}
