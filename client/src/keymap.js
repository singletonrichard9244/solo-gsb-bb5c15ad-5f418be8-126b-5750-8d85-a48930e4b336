const MOD_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/** 将浏览器 KeyboardEvent.key/code 归一为引擎使用的 token */
export function eventToToken(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');

  let key = e.key;
  if (MOD_KEYS.has(key)) return null; // 单按修饰键不计入
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Escape';
  else if (key === 'Backspace') key = 'Backspace';
  else if (key === 'Enter') key = 'Enter';
  else if (key === 'Tab') key = 'Tab';
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else key = key.toLowerCase();

  // 修饰键与主键重复（如 Shift+Shift）时去除
  const modSet = new Set(mods);
  if (modSet.has(key)) return null;
  return [...mods, key].join('+');
}

/** token -> 展示用 pretty（g -> G, ctrl+k -> Ctrl+K） */
export function prettyToken(token) {
  const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return token
    .split('+')
    .map((p) => (MOD_PRETTY[p] ? MOD_PRETTY[p] : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}
