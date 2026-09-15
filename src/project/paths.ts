/** Windows 工作区 URI 可能保留大写盘符，而文件 URI 使用小写；比较时不能误判跨根目录。 */
export function withinRoot(file: string, root: string): boolean {
  const comparable = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  return comparable(file).startsWith(comparable(root).replace(/\/$/, '') + '/');
}
