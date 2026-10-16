// 能不能被推荐，只看这两个标签：同时有「家常菜」和「正餐」才进推荐池。
// 口径（哪道菜有什么标签）在 tools/recipe-tags.mjs 里，改那儿再跑 apply-recipe-tags.mjs。
// 这样韭菜盒子、煮鸡蛋、葱烧海参这类就不会被推上来当正餐了。

export const MEAL_TAGS = ["家常菜", "正餐"];

export function isMealDish(recipe) {
  if (!recipe) return false;
  const tags = recipe.tags || [];
  return MEAL_TAGS.every((t) => tags.includes(t));
}

export function missingMealTags(recipe) {
  const tags = (recipe && recipe.tags) || [];
  return MEAL_TAGS.filter((t) => !tags.includes(t));
}
