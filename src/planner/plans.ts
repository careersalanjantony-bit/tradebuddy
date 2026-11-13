import { defaultPlanAlerts, newId } from '../alerts/rules';
import { mutateAlerts, mutatePlans } from '../alerts/engine';
import { createLogger } from '../lib/log';
import { getSettings } from '../storage/local';
import { istDate } from '../lib/time';
import type { TradePlan } from '../storage/schema';

const log = createLogger('plans');

export type NewPlan = Omit<TradePlan, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

/** Saves a plan (status "planned") and its default alerts (spec §11, §12). */
export async function savePlan(p: NewPlan, now = Date.now()): Promise<TradePlan> {
  const plan: TradePlan = { ...p, id: newId('P', now), status: 'planned', createdAt: now, updatedAt: now };
  // the ticket was built before the id existed
  plan.ticket = p.ticket.replace(/plan id \S+$/, `plan id ${plan.id}`);
  await mutatePlans((all) => [...all, plan]);
  if (plan.practice) {
    // practice trades are sold by the extension itself (background/practiceJobs.ts): no price alerts
    log.info(`Practice plan saved: ${plan.symbol} qty ${plan.qty} entry ${plan.entry}`, { id: plan.id });
    return plan;
  }
  const { alerts } = await getSettings();
  const rules = defaultPlanAlerts(
    { planId: plan.id, key: plan.key, symbol: plan.symbol, entry: plan.entry, stop: plan.stop, target: plan.target, targetMode: plan.targetMode ?? 'fixed', holdTarget: plan.holdTarget ?? null },
    alerts.cooldownMinutes,
    now,
  );
  await mutateAlerts((all) => [...all, ...rules]);
  log.info(`Plan saved: ${plan.symbol} qty ${plan.qty} entry ${plan.entry} stop ${plan.stop} target ${plan.target}`, { id: plan.id });
  return plan;
}

const FINAL: TradePlan['status'][] = ['closed', 'cancelled'];

export async function updatePlan(
  id: string,
  patch: Partial<Pick<TradePlan, 'status' | 'fillPrice' | 'exitPrice' | 'exitReason' | 'notes' | 'qty' | 'riskRupees' | 'rewardRupees'>>,
  now = Date.now(),
): Promise<void> {
  let found: TradePlan | undefined;
  await mutatePlans((all) =>
    all.map((p) => {
      if (p.id !== id) return p;
      found = { ...p, ...patch, updatedAt: now, ...(patch.status === 'open' && !p.openedDate ? { openedDate: istDate(now) } : {}) };
      return found;
    }),
  );
  if (!found) throw new Error('Plan not found');
  if (patch.status && FINAL.includes(patch.status)) {
    await mutateAlerts((all) => all.map((r) => (r.planId === id ? { ...r, active: false } : r)));
  }
  log.info(`Plan ${found.symbol} → ${found.status}`, { id, patch });
}

export async function deletePlan(id: string): Promise<void> {
  await mutatePlans((all) => all.filter((p) => p.id !== id));
  await mutateAlerts((all) => all.filter((r) => r.planId !== id));
}
