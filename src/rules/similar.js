// 菜名查重：完全重名、包含关系（可乐鸡翅 / 可乐鸡翅根）、以及字形相近（番茄炒蛋 / 西红柿炒蛋）。

// 常见同义写法先归一化，否则「西红柿」和「番茄」算不出相似
const SYNONYMS = [
  [/西红柿|蕃茄/g, "番茄"],
  [/马铃薯/g, "土豆"],
  [/青椒|尖椒|柿子椒/g, "椒"],
  [/鸡蛋|蛋$/g, "蛋"],
  [/白砂糖|白糖/g, "糖"],
  [/酱油/g, "生抽"]
];

export function normalizeName(name) {
  let s = String(name == null ? "" : name).toLowerCase();
  s = s.replace(/的做法|做法|菜谱|recipe/g, "");
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  return s.replace(/[\s·・、,，.。!！?？"'“”‘’()（）\[\]【】\-_/\\]/g, "");
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function similarity(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const gx = bigrams(x);
  const gy = bigrams(y);
  if (!gx.size || !gy.size) return 0;
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit += 1;
  return (2 * hit) / (gx.size + gy.size);
}

// level: same（就是同一道）/ close（很接近）/ similar（有点像）
export function findSimilarRecipes(recipes, name, { limit = 5, threshold = 0.5 } = {}) {
  const out = [];
  for (const r of recipes) {
    const score = similarity(name, r.name);
    if (score < threshold) continue;
    out.push({
      recipe: r,
      score: Math.round(score * 100) / 100,
      level: score >= 1 ? "same" : score >= 0.8 ? "close" : "similar"
    });
  }
  out.sort((a, b) => b.score - a.score || (a.recipe.name > b.recipe.name ? 1 : -1));
  return out.slice(0, limit);
}
