# weappdev-mcp

把一台或多台安卓手机接进任意 MCP 客户端。配置**一次**，之后 USB、模拟器、局域网都走同一份配置。

手机上的 **WeAppDev** 应用本身就是 MCP 服务端（64 个工具，覆盖小程序自动化、网络与 Native 抓包、
云开发、断点、DOM、WebSocket、插件）。本包是它前面的一层 **stdio 聚合器**：发现设备、给每台手机维持
一条 MCP 会话，再把调用路由到你指定的那台。

- 应用仓库（本体，不开源，只发 APK）：<https://github.com/RYF5584/weappdev>
- 配套 Skill（教 AI 怎么用这些工具）：<https://github.com/RYF5584/weappdev-skill>
- 官网文档：<https://weappdev.top>

没有常驻进程。客户端拉起它，会话结束它就退出，所以每个 AI 会话都有独立的设备注册表。

```
MCP 客户端 ──stdio──▶ weappdev-mcp ──HTTP──▶ 手机 A :9400/mcp
                          │            └────▶ 手机 B :9400/mcp  (局域网)
                          └──── adb forward tcp:0（USB / 模拟器，端口由 adb 分配）
```

## 快速开始

**1. 手机端**：安装并打开 WeAppDev。

**2. 客户端**：加一份配置，就这些。

```json
{
  "mcpServers": {
    "weappdev": {
      "command": "npx",
      "args": ["-y", "@ryf5584/weappdev-mcp"]
    }
  }
}
```

不需要一台手机一个条目，插新手机也不用改这里。

**3. 验证**：让 AI 调一次 `wad_devices`。能列出手机就通了，返回值里的 `device` 就是设备别名。

## 配套 Skill

MCP 只提供 64 个工具，不告诉 AI 该怎么组合使用。抓签名、断点求值、拼云开发请求这些流程都写在 Skill 里，
建议一起装：

```bash
npx -y skills add RYF5584/weappdev-skill
```

加 `-g` 装到全局，加 `-l` 只看不装。Skill 仓库：<https://github.com/RYF5584/weappdev-skill>。

装了 Skill 再配这个 MCP，AI 才知道先抓包还是先下断点、参数该怎么传。

## 环境要求

- **Node.js >= 22**（用到全局 `fetch`、`AbortSignal.timeout`、`node:dgram`）
- **adb** 在 `PATH` 里（USB / 模拟器发现用，可用 `ADB_BIN` 指定）
- 手机上 WeAppDev 已启动

## 选择设备

```
wad_devices                                  # 列出手机，device 字段就是别名
wad_device_use { "device": "0017f447" }      # 把默认设备固定到本次会话
wad_status                                   # 不传 device，用固定那台
wad_status { "device": "b96e8eee" }          # 单次指定
```

`device` 接受别名（`0017f447`）、持久安装 UUID（`wad-0017f44719ad...`）或 base URL
（`http://192.168.1.5:9400`）。

路由是确定的，不猜：调用里传的 `device` → 本次进程用 `wad_device_use` 固定的 → 只有一台在线就用它 →
多台在线又没指定就报 `E_AMBIGUOUS_DEVICE` 并列出全部设备。

## 端口

手机用**一个可配端口**同时提供 MCP（`/mcp`）、CDP（`/devtools/*`、`/json/*`）和内部 API（`/v1/*`），
默认 `9400`。在应用里的「调试配置」改。这里不用配端口：聚合器会读设备实际监听的那个，老版本会退化处理。

USB 转发用 `adb forward tcp:0 tcp:<设备端口>`，本地端口由 adb 挑，两个聚合器或两台手机不会撞车；
每个进程只清理自己建的那条。

## 设备发现

每轮四路并行，总预算 3 秒。

| 来源 | 默认 | 说明 |
|---|---|---|
| USB / 模拟器（`adb devices`） | 开 | 本地端口用 `tcp:0` 自动分配 |
| mDNS（`_weappdev._tcp`） | 开 | 可能被路由器 AP 隔离挡住 |
| `~/.weappdev/devices.json` | 开 | 跨网段 / 固定 IP 用 |
| 本地 /24 扫描 | 关（`--scan`） | 扫 9400–9411 |

种子文件格式：

```json
[
  { "url": "http://192.168.1.5:9400", "alias": "客厅" },
  { "host": "192.168.1.6", "port": 9400 },
  "http://192.168.1.7:9400"
]
```

按持久安装 UUID 去重：同一台手机同时被 USB 和局域网发现时只留一条，`transports` 为 `["usb","lan"]`，优先 USB。

## 命令行

```
npx -y @ryf5584/weappdev-mcp               # 正常使用
node src/cli.mjs --scan                    # 额外扫本地 /24（9400-9411）
node src/cli.mjs --no-mdns                 # 关掉 mDNS 发现
node src/cli.mjs --no-seed                 # 不读 ~/.weappdev/devices.json
node src/cli.mjs --no-usb                  # 关掉 adb 发现
node src/cli.mjs --debug                   # stderr 打详细日志
node src/cli.mjs --version                 # 版本号
```

环境变量：`ADB_BIN`（默认 `adb`）。

## 工具与兼容

`tools/list` 返回所有在线设备工具的**并集**，外加两个聚合器专用工具（`wad_devices`、`wad_device_use`）。
每个工具带 `_meta.devices`（哪些设备支持）和 `_meta.unsupportedBy`。

手机版本太旧、不支持某个工具时，报结构化错误而不是含糊失败：

```json
{
  "ok": false,
  "error": "E_UNSUPPORTED_BY_DEVICE",
  "message": "0017f447 does not support wad_xyz (phone MCP 1.0.0 / apiLevel 100)",
  "hint": "Call wad_tools {action:'list'} to see what it does support."
}
```

手机比本包**新**也没问题：多出来的工具从设备自己的工具列表里取；完全陌生的名字会转发给手机的
`wad_tools` 元工具。

版本有两个号，`initialize` 和 `/json/version` 都会返回：

| 字段 | 含义 |
|---|---|
| `version` | MCP 服务的 semver，只作展示 |
| `apiLevel` | 单调递增的能力代号（整数），兼容性判断只看它 |

不比较 semver 字符串，所以不会出现 `1.10 < 1.9` 这种错。

## 错误码

| Code | 含义 |
|---|---|
| `E_NO_DEVICE` | 什么都没发现（USB？应用开了？试 `--scan`） |
| `E_AMBIGUOUS_DEVICE` | 多台在线，没指定用哪台 |
| `E_UNKNOWN_DEVICE` | `device` 没匹配上，调 `wad_devices` |
| `E_UNSUPPORTED_BY_DEVICE` | 那台手机的版本没有这个工具 |
| `E_BAD_BASE_URL` | 这个 URL 不是 WeAppDev 网关 |
| `E_DEVICE_TIMEOUT` | 60 秒无响应，**不重试**，避免副作用跑两次 |
| `E_SESSION_LOST` | 重新附加也 404，设备多半在重启 |
| `E_DEVICE_HTTP` / `E_DEVICE_BAD_JSON` | 手机返回了意外响应 |

瞬时连接失败（`ECONNREFUSED` / `ECONNRESET`）和会话过期（HTTP 404）会重试**一次**；超时故意不重试。

## 开发

```bash
npm run check                                  # 语法检查
npm test                                       # node:test 单测，不需要设备
node scripts/validate-server-json.mjs
```

发布自动化：打 `v*` tag，`.github/workflows/release.yml` 跑测试、带 provenance 发 npm，再发布到官方 MCP Registry。

## License

MIT
