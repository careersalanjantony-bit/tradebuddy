export function Placeholder({ title, milestone, about }: { title: string; milestone: string; about: string }) {
  return (
    <section class="card">
      <h2>{title}</h2>
      <p class="muted">Arrives in {milestone}.</p>
      <p>{about}</p>
    </section>
  );
}
