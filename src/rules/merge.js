// 三方合并：base 为最后同步成功的基线，local / remote 为两端各自的最新版。
// 规则：能自动合的自动合；同字段双方都改且不同 → 记为冲突、保留双方，等待用户选择。
// 不做「最后写入者获胜」，不静默覆盖。

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stableStringify(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") +
    "}"
  );
}

export function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function isIdArray(arr) {
  return arr.every((x) => isPlainObject(x) && typeof x.id === "string");
}

export function threeWayMerge(base, local, remote) {
  const conflicts = [];
  const merged = mergeValue(base, local, remote, "", conflicts);
  return { merged, conflicts };
}

function mergeValue(base, local, remote, path, conflicts) {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(base, local)) return remote;
  if (deepEqual(base, remote)) return local;

  const baseObj = isPlainObject(base) ? base : {};
  if (isPlainObject(local) && isPlainObject(remote)) {
    const out = {};
    const keys = new Set([...Object.keys(baseObj), ...Object.keys(local), ...Object.keys(remote)]);
    for (const k of keys) {
      out[k] = mergeValue(baseObj[k], local[k], remote[k], `${path}/${k}`, conflicts);
    }
    return out;
  }

  if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base)) {
    if (isIdArray(local) && isIdArray(remote) && isIdArray(base)) {
      return mergeCollections(base, local, remote, path, conflicts);
    }
  }

  conflicts.push({ path: path || "/", kind: "field", base, local, remote });
  return local;
}

function mergeCollections(baseArr, localArr, remoteArr, path, conflicts) {
  const toMap = (arr) => new Map(arr.map((r) => [r.id, r]));
  const b = toMap(baseArr);
  const l = toMap(localArr);
  const r = toMap(remoteArr);
  const ids = [...new Set([...b.keys(), ...l.keys(), ...r.keys()])];
  const out = [];

  for (const id of ids) {
    const bv = b.get(id);
    const lv = l.get(id);
    const rv = r.get(id);

    if (lv === undefined && rv === undefined) continue;

    if (lv === undefined) {
      if (bv === undefined) {
        // 本地本来就没有、基线也没有 → 远端新加的，直接采纳，不算冲突
        out.push(rv);
        continue;
      }
      if (deepEqual(bv, rv)) continue; // 只有本地删，远端没动 → 采纳删除
      conflicts.push({ path: `${path}/${id}`, kind: "delete-vs-modify", base: bv, local: null, remote: rv });
      out.push(rv);
      continue;
    }

    if (rv === undefined) {
      if (bv === undefined) {
        // 远端没有、基线也没有 → 本地新加的，留着，不算冲突
        out.push(lv);
        continue;
      }
      if (deepEqual(bv, lv)) continue; // 只有远端删，本地没动 → 采纳删除
      conflicts.push({ path: `${path}/${id}`, kind: "delete-vs-modify", base: bv, local: lv, remote: null });
      out.push(lv);
      continue;
    }

    out.push(mergeValue(bv, lv, rv, `${path}/${id}`, conflicts));
  }
  return out;
}
