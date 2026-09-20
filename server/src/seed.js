/**
 * 初始演示数据：
 * - App（根）/ Editor / Code Editor / Terminal
 * - 包含：正常绑定、子级覆盖祖先（shadow）、同层重复（duplicate）、
 *   同层前缀冲突（Code Editor 的 G D 系列）、跨层前缀冲突（Terminal 的 G / G L）
 */

let seqId = 0;
const command = (contextId, name, sequence, description = '') => ({
  id: `cmd-${++seqId}`,
  contextId,
  name,
  sequenceRaw: sequence,
  sequenceTokens: sequence
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase()),
  sequenceLabel: sequence,
  description,
});

const contexts = [
  { id: 'ctx-app', parentId: null, name: 'App', description: '整个应用（全局快捷键）' },
  { id: 'ctx-editor', parentId: 'ctx-app', name: 'Editor', description: '通用编辑器上下文' },
  { id: 'ctx-code', parentId: 'ctx-editor', name: 'Code Editor', description: '代码编辑器（支持多光标/LSP）' },
  { id: 'ctx-terminal', parentId: 'ctx-editor', name: 'Terminal', description: '内嵌终端上下文' },
];

const commands = [
  // 全局
  command('ctx-app', '打开命令面板', 'ctrl+shift+p', '全局命令面板'),
  command('ctx-app', '快速打开文件', 'ctrl+p', ''),
  command('ctx-app', '保存', 'ctrl+s', ''),
  command('ctx-app', '聚焦下一个面板', 'ctrl+j', ''),

  // Editor：前缀冲突链（同层）g / g d / g d d …… 放到 Code Editor 更典型
  command('ctx-editor', '撤销', 'ctrl+z', ''),
  command('ctx-editor', '查找', 'ctrl+f', ''),
  command('ctx-editor', '转到行', 'ctrl+g', ''),
  command('ctx-editor', '跳转…', 'g', 'Vim 风格跳转前缀，在子上下文会被覆盖'),
  command('ctx-editor', '复制整行', 'ctrl+c', ''),

  // Code Editor：同层前缀冲突 G（单键）/ G D / G D D
  command('ctx-code', '跳转定义…', 'g', '跳转前缀（与 G D、G D D 形成前缀冲突）'),
  command('ctx-code', '跳到类型定义', 'g d', ''),
  command('ctx-code', '跳到声明', 'g d d', ''),
  command('ctx-code', '重命名符号', 'f2', ''),
  command('ctx-code', '向下添加光标', 'ctrl+alt+d', ''),

  // Terminal：子级覆盖祖先 G，并与自己的 G L 构成前缀冲突；G H 同层重复两次
  command('ctx-terminal', '清屏前缀（覆盖祖先）', 'g', '覆盖 Editor 的“跳转…”（最近祖先规则）'),
  command('ctx-terminal', '清屏', 'g l', '与 G 构成前缀冲突（跨层前缀链中的一段）'),
  command('ctx-terminal', '清屏并回顶部', 'g h', ''),
  command('ctx-terminal', '清屏并回底部', 'g h', '同层重复绑定，演示 duplicate 冲突'),
  command('ctx-terminal', '新建终端', 'ctrl+`', ''),
];

module.exports = { contexts, commands };
