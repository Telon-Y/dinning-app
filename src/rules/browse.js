// 食谱检索：食谱库页和「安排到某天」的选择页共用同一套匹配规则，
// 两边搜出来的结果要一致，不然会以为菜丢了。

import { isMealDish } from "./mealtags.js?v=4d701ad";

export const RECIPE_CATEGORIES = ["荤菜", "素菜", "主食", "汤", "早餐", "水产", "甜点", "饮品", "半成品", "调料", "其他"];

export function normalizeQuery(q) {
  return (q || "").trim().toLowerCase();
}

// 匹配范围：菜名、类目、标签都算。
// 所以搜「鸡」能搜到带鸡的菜，搜「家常菜」能一次列出所有可推荐的菜。
export function matchesRecipe(recipe, query) {
  const q = normalizeQuery(query);
  if (!q) return true;
  if ((recipe.name || "").toLowerCase().includes(q)) return true;
  if ((recipe.category || "").toLowerCase().includes(q)) return true;
  return (recipe.tags || []).some((t) => String(t).toLowerCase().includes(q));
}

export function browseRecipes(
  recipes,
  { query = "", category = "", limit = 30, includeDrafts = false, onlyMealDishes = false, preferMeal = false } = {}
) {
  let pool = (recipes || []).filter((r) => includeDrafts || r.status !== "draft");
  if (onlyMealDishes) pool = pool.filter(isMealDish);
  if (category) pool = pool.filter((r) => (r.category || "其他") === category);

  const matched = pool.filter((r) => matchesRecipe(r, query));
  // 排序保持原顺序（进库顺序），只在需要时把「会参与推荐」的菜提到前面
  const sorted = preferMeal
    ? [...matched].sort((a, b) => (isMealDish(a) ? 0 : 1) - (isMealDish(b) ? 0 : 1))
    : matched;

  return { items: sorted.slice(0, limit), total: sorted.length };
}
