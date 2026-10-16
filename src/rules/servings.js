// 份数换算：统一使用「基础食材量 × 实际份数 / 基础份数」。
// 每餐只存一个 actualServings（实际制作份数），不做「双份」这类额外开关。

export function scaleAmount(baseAmount, baseServings, actualServings) {
  if (!(baseServings > 0)) throw new Error("baseServings 必须大于 0");
  return (baseAmount * actualServings) / baseServings;
}

export function scaleIngredients(ingredients, baseServings, actualServings) {
  return ingredients.map((ing) => ({
    ...ing,
    amount: scaleAmount(ing.amount, baseServings, actualServings)
  }));
}

// 一餐的份数：优先用该餐自己的 actualServings，没设就取家庭人数。
// 想吃隔天午饭，就把那一餐的份数直接调大（例如 2 人吃、这一餐设 4 份），多做出来的部分记为剩菜。
export function resolveMealServings(meal, householdServings) {
  return meal && meal.actualServings != null ? meal.actualServings : householdServings;
}
