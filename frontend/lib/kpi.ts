export function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function marginPct(revenue: number, profit: number): number {
  return revenue > 0 ? (profit / revenue) * 100 : 0;
}

export function computeBudgetKpis(totalBudget: number, spentToDate: number, timeBudget: number, timeSpent: number) {
  const budgetRemaining = totalBudget - spentToDate;
  const pctSpent = totalBudget > 0 ? (spentToDate / totalBudget) * 100 : 0;
  const pctRemaining = totalBudget > 0 ? (budgetRemaining / totalBudget) * 100 : 0;
  const timeRemaining = timeBudget - timeSpent;
  const pctTimeSpent = timeBudget > 0 ? (timeSpent / timeBudget) * 100 : 0;
  const pctTimeRemaining = timeBudget > 0 ? (timeRemaining / timeBudget) * 100 : 0;
  return { budgetRemaining, pctSpent, pctRemaining, timeRemaining, pctTimeSpent, pctTimeRemaining };
}

export function summarizeRevenueCostProfit<T>(rows: T[], getRevenue: (row: T) => number, getCost: (row: T) => number) {
  return rows.reduce(
    (acc, row) => {
      const revenue = toNumber(getRevenue(row));
      const cost = toNumber(getCost(row));
      acc.revenue += revenue;
      acc.cost += cost;
      acc.profit += revenue - cost;
      return acc;
    },
    { revenue: 0, cost: 0, profit: 0 },
  );
}
