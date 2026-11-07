import type { FoodItem } from "./llm"

/**
 * 每样食物写成一条 HealthKit「food」关联记录，包含热量和三大营养素。
 * 第一次调用时系统会弹出健康权限请求。
 */
export async function saveFoodToHealth(item: FoodItem, date: Date): Promise<void> {
  const parts: { type: HealthQuantityType; value: number; unit: HealthUnit }[] = [
    { type: "dietaryEnergyConsumed", value: item.kcal, unit: HealthUnit.kilocalorie() },
    { type: "dietaryProtein", value: item.protein, unit: HealthUnit.gram() },
    { type: "dietaryCarbohydrates", value: item.carbs, unit: HealthUnit.gram() },
    { type: "dietaryFatTotal", value: item.fat, unit: HealthUnit.gram() },
  ]
  const samples: HealthQuantitySample[] = []
  for (const p of parts) {
    const sample = HealthQuantitySample.create({
      type: p.type,
      startDate: date,
      endDate: date,
      value: p.value,
      unit: p.unit,
    })
    if (!sample) throw new Error(`创建「${item.name}」的 ${p.type} 样本失败`)
    samples.push(sample)
  }
  const correlation = HealthCorrelation.create({
    type: "food",
    startDate: date,
    endDate: date,
    objects: samples,
    metadata: { foodName: item.name, source: "Calorie Camera" },
  })
  if (!correlation) throw new Error(`创建「${item.name}」的饮食记录失败`)
  await Health.saveCorrelation(correlation)
}
