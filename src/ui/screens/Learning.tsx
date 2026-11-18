import type { Go } from '../App';
import { LearningCard } from '../components/Learning';

/** Home → Learning. */
export function LearningScreen({ go }: { go: Go }) {
  return (
    <div class="screen" data-testid="learning">
      <LearningCard go={go} full />
    </div>
  );
}
