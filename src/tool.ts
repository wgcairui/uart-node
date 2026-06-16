/**
 * tool.ts — 工具类占位
 *
 * 历史：
 *   - PR #3: ATParse() 拆到 src/services/at-parse.ts（纯函数 + Result 类型）
 *   - PR #4: NodeInfo() 拆到 src/services/dtu-info.ts（PR #2 落地 + PR #4 main.ts 切换）
 *
 * 保留空文件是为 import 路径不破坏（tool.ts 文件还在 git 历史里，未来可能用作 base64/buffer helper 等通用工具），
 * 实际已无可用方法。
 *
 * 新代码不要 import 这个文件。需要 AT 解析用 `services/at-parse`，
 * 需要 nodeInfo 用 `services/dtu-info`。
 */

export default class tool {
  // 故意保持空 — 旧方法全部外迁
}
