// 权限多选 UI 的共用逻辑：账户编辑页 / 权限组管理页都用它把权限目录变成可多选的模块
// （TDesign 的 t-checkbox-group 需要 options=[{label,value}] + value=[value] 这种形状）

// 目录 → 按模块分组的多选数据
function buildModules(catalog, selected) {
  const map = new Map();
  for (const p of catalog || []) {
    if (!map.has(p.module)) map.set(p.module, []);
    map.get(p.module).push(p);
  }
  const sel = new Set(selected || []);
  return [...map.entries()].map(([name, list]) => {
    const options = list.map((p) => ({ label: p.name, value: p.key }));
    return {
      name,
      options,
      keys: options.map((o) => o.value),
      selected: options.filter((o) => sel.has(o.value)).map((o) => o.value),
    };
  });
}

// 某个模块勾选变化 → 合并回全量已选列表（其它模块的勾选保持不动）
function mergeModuleKeys(selected, moduleKeys, checkedInModule) {
  const keys = moduleKeys || [];
  const rest = (selected || []).filter((k) => keys.indexOf(k) < 0);
  return rest.concat(checkedInModule || []);
}

// 已选列表变化 → 刷新各模块的 selected（供 WXML 直接绑定）
function refreshSelected(modules, selected) {
  const sel = new Set(selected || []);
  return (modules || []).map((m) => ({ ...m, selected: m.keys.filter((k) => sel.has(k)) }));
}

// 权限组 → 多选项
function buildGroupOptions(groups) {
  return (groups || []).map((g) => ({
    label: `${g.name}${g.permissions && g.permissions[0] === '*' ? '（全部权限）' : `（${(g.permissions || []).length} 项）`}`,
    value: g.key,
  }));
}

// 已选权限组的可读文案
function groupNamesText(keys, groups) {
  const map = new Map((groups || []).map((g) => [g.key, g.name]));
  return (keys || []).map((k) => map.get(k) || k).join('、');
}

module.exports = { buildModules, mergeModuleKeys, refreshSelected, buildGroupOptions, groupNamesText };
