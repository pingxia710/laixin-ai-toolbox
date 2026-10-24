import type { MenuItemConstructorOptions } from 'electron'

/** 生产环境精简中文应用菜单:⛔ reload / 强制刷新 / devtools 快捷键(Cmd+R 整页 reload
 * 会打断安装与登录流程);编辑角色齐全保证中文输入、复制粘贴可用;退出走系统
 * before-quit(桌面层负责保存窗口)。开发模式不调用,保留默认菜单方便调试。 */
export function applicationMenuTemplate(platform: string): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = { label: '编辑', submenu: [
    { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
    { role: 'cut', label: '剪切' }, { role: 'copy', label: '拷贝' }, { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' }
  ] }
  const view: MenuItemConstructorOptions = { label: '显示', submenu: [
    { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }
  ] }
  const window: MenuItemConstructorOptions = { label: '窗口', submenu: [
    { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'close', label: '关闭窗口' }
  ] }
  if (platform !== 'darwin') return [edit, view, window]
  const appMenu: MenuItemConstructorOptions = { label: '来信 AI 工具箱', submenu: [
    { role: 'about', label: '关于来信 AI 工具箱' },
    { type: 'separator' },
    { role: 'hide', label: '隐藏来信 AI 工具箱' },
    { role: 'hideOthers', label: '隐藏其他' },
    { role: 'unhide', label: '全部显示' },
    { type: 'separator' },
    { role: 'quit', label: '退出来信 AI 工具箱' }
  ] }
  return [appMenu, edit, view, window]
}
