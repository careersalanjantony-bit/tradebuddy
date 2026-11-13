/** Spec §25 — shown in the app. */
export const DISCLAIMER =
  'This tool gives analysis and calculations, not investment advice. Markets carry risk of loss. You decide and place every order yourself.';

export function Disclaimer() {
  return <footer class="disclaimer">{DISCLAIMER}</footer>;
}
