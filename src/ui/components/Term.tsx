import type { ComponentChildren } from 'preact';
import { GLOSSARY } from '../glossary';

/** A label with a plain-language tooltip from the glossary. */
export function Term({ t, children }: { t: keyof typeof GLOSSARY | string; children?: ComponentChildren }) {
  const tip = GLOSSARY[t];
  return (
    <span class={tip ? 'term' : undefined} title={tip}>
      {children ?? t}
    </span>
  );
}
