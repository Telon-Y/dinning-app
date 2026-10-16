// 与具体 Ajv 实例解耦：浏览器传 window.Ajv，Node 测试传加载好的 Ajv。
// 手机与电脑复用同一份 schema 和同一个入口。

export function buildValidator(Ajv, schema) {
  const ajv = new Ajv({ allErrors: true, strict: false, jsonPointers: true });
  return ajv.compile(schema);
}

export function formatErrors(validateFn) {
  if (!validateFn.errors) return [];
  return validateFn.errors.map((e) => {
    const where = e.dataPath || e.instancePath || "";
    const extra = e.params && e.params.additionalProperty ? ` (${e.params.additionalProperty})` : "";
    return `${where} ${e.message}${extra}`.trim();
  });
}
