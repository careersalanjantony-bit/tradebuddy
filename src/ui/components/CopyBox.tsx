import { useState } from 'preact/hooks';

export function CopyBox({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class="copybox">
      <code>{value}</code>
      <button class="btn small" type="button" onClick={copy}>
        {copied ? 'Copied' : label}
      </button>
    </div>
  );
}
