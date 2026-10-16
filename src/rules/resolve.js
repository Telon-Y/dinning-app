// 冲突解决：把某个冲突路径上的值换成用户选定的一方。
// 路径来自三方合并，形如 /settings/budget/weeklyPence 或 /meals/meal_x/actualServings；
// 数组那一段用的是记录 id，不是下标。

function child(container, key) {
  if (Array.isArray(container)) return container.find((x) => x && x.id === key) || null;
  return container && typeof container === "object" ? container[key] : null;
}

export function setAtPath(data, path, value, { deleteIfNull = false } = {}) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length) return data;
  const clone = structuredClone(data);
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = child(cur, parts[i]);
    if (cur == null) return clone;
  }
  const last = parts[parts.length - 1];

  if (deleteIfNull && value === null) {
    if (Array.isArray(cur)) {
      const idx = cur.findIndex((x) => x && x.id === last);
      if (idx >= 0) cur.splice(idx, 1);
    } else if (cur && typeof cur === "object") {
      delete cur[last];
    }
    return clone;
  }

  if (Array.isArray(cur)) {
    const idx = cur.findIndex((x) => x && x.id === last);
    if (idx >= 0) cur[idx] = value;
    else cur.push(value);
  } else if (cur && typeof cur === "object") {
    cur[last] = value;
  }
  return clone;
}

// 按选择表把一串冲突一次应用完。choices: { [path]: "local" | "remote" }
export function applyResolutions(data, conflicts, choices) {
  let next = data;
  for (const c of conflicts) {
    const choice = choices[c.path];
    if (!choice) continue;
    const value = choice === "remote" ? c.remote : c.local;
    next = setAtPath(next, c.path, value === undefined ? null : value, {
      deleteIfNull: c.kind === "delete-vs-modify"
    });
  }
  return next;
}
