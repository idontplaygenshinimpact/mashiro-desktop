// Windows Toast 通知（WinRT via PowerShell）——安全实现
// 背景：旧实现把 title/message 直接拼进 PowerShell 脚本字符串（仅转义引号），
// 通知内容可含爬虫/网页内容 → 存在本地命令注入面（' 逃逸 / $( ) 执行）。
// 修复：参数经 base64（字符集 [A-Za-z0-9+/=] 无注入面）+ 脚本整体用
// -EncodedCommand（UTF-16LE base64）传递，title/message 完全不进命令行文本。
// 用法（widget.mjs / desktop/main.mjs 通用）：
//   const { buildToastScript, encodePowerShellCommand } = await import("../lib/win-toast.mjs");
//   spawn("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(buildToastScript(title, message))]);

/** 构造 WinRT ToastText02 通知脚本（title/message 以 base64 内嵌，无拼接注入面） */
export function buildToastScript(title, message) {
  const t = Buffer.from(String(title ?? ""), "utf8").toString("base64");
  const m = Buffer.from(String(message ?? ""), "utf8").toString("base64");
  return `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${t}'))
$m = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${m}'))
$textNodes.Item(0).AppendChild($template.CreateTextNode($t)) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode($m)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MianshiAgent').Show($toast)`;
}

/** 把 PowerShell 脚本编码为 -EncodedCommand 参数（UTF-16LE base64） */
export function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
