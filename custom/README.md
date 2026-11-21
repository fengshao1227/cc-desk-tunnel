# 让服务器上的 Claude 用上 Mac：代码、命令、浏览器

上游的设计里，Claude 只通过客户端连接期间建立的 `ssh device-*` 来操作电脑。本目录补充的是另一条常驻通道：Mac 主动建一条反向 SSH 隧道到服务器，服务器上的 Claude Code 通过它，把 **Mac 上运行的 MCP 服务器**（代码读写、语义检索、浏览器……）当作自己的工具来用。两条通道可以同时存在，由设备提示词（`deploy/native/device-prompt.example.md`）告诉 Claude 按任务选用哪条。

```text
Mac ── launchd: devlink-tunnel ── ssh -R 127.0.0.1:22022:127.0.0.1:22 ──▶ 服务器 devlink 用户
服务器 Claude Code ── mcp-over-ssh mac-home '<命令>' ── ssh 127.0.0.1:22022 ──▶ Mac 上的 MCP 服务器（stdio）
```

| 文件 | 放在哪 | 作用 |
| --- | --- | --- |
| `mac/devlink-tunnel` + `.plist.in` | Mac `~/.local/bin`、`~/Library/LaunchAgents` | 反向隧道，由 launchd 守护，一台服务器一份配置 |
| `mac/mac-workspace-mcp` + `-router` | Mac `~/.local/bin` | 代码 MCP：读、搜、精确替换（不匹配就失败）、带 sha256 的写入、执行命令；按 `projects.conf` 把服务器上的文件夹映射到 Mac 上的文件夹 |
| `mac/safe-edit` | Mac `~/.local/bin` | 通过 SSH 改代码时代替 sed：只替换唯一的精确匹配，可校验 sha256，原子写入 |
| `server/mcp-over-ssh` | 服务器 `~/.local/bin` | 把 Mac 上的任意 stdio MCP 服务器接到服务器上 |
| `server/mcp-resilient` | 服务器 `~/.local/bin` | 隧道断了自动重连 MCP 后端，并重放 `initialize`。交互式 Claude Code 自己不会重启已退出的 stdio MCP |
| `server/notify-device` | 服务器 `~/.local/bin` | Notification 钩子：Claude 等你时，在 Mac 上弹系统通知 |
| `server/sync-project-map` | 服务器 `~/.local/bin` | 定时汇总各台 Mac 的 `projects.conf`，生成 `CCDT_PROJECT_MAP` 用的映射表 |
| `mac/gui-helper.plist.in` + `mac/gui-helper-relay` | Mac | 让 launchd 在图形会话里拉起需要录屏或辅助功能权限的辅助程序，ssh 这边只做转发（见第 6 节） |
| `server/computer-use-mac` | 服务器 `~/.local/bin` | 桌面控制 MCP（blade-computer-use）的包装脚本，可设置应用白名单 |
| `ccbot/` | 服务器 `~/.local/bin`，Mac `~/.local/bin` | 让 Grok Bot 这类机器人新建、继续、审批、停止会话；机器人的 SSH 钥匙只能跑它（见 [ccbot/README.md](ccbot/README.md)） |
| `server/ccdt-cf-tunnel` | 服务器 `~/.local/bin`，crontab | 守着 Cloudflare Tunnel，让 Web 工作台不开端口、不用 root 就能挂到自己的域名上 |

## 1. 服务器：隧道专用账号

```bash
useradd -m -s /bin/bash devlink
install -d -m 700 -o devlink -g devlink ~devlink/.ssh
# 每台 Mac 一行公钥（ssh-keygen -t ed25519 -f ~/.ssh/devlink），并限制为只能做隧道：
echo 'no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA... mac-home' >> ~devlink/.ssh/authorized_keys
cat >> /etc/ssh/sshd_config <<'EOF'

# 及时清掉断开的隧道会话，让 Mac 重连时能拿回端口
Match User devlink
    ClientAliveInterval 15
    ClientAliveCountMax 3
    AllowTcpForwarding remote
    PermitTTY no
    X11Forwarding no
EOF
sshd -t && systemctl reload sshd
```

## 2. Mac：反向隧道

```bash
cp custom/mac/devlink-tunnel ~/.local/bin/ && chmod 755 ~/.local/bin/devlink-tunnel
mkdir -p ~/.config/devlink && cat > ~/.config/devlink/server1.env <<'EOF'
RELAY=devlink@<服务器地址>
RELAY_SSH_PORT=22
REMOTE_PORT=22022          # 第二台 Mac 用 22023，依此类推
KEY=$HOME/.ssh/devlink
EOF
sed -e "s|@NAME@|server1|g" -e "s|@HOME@|$HOME|g" custom/mac/devlink-tunnel.plist.in \
  > ~/Library/LaunchAgents/local.devlink-tunnel.server1.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.devlink-tunnel.server1.plist
```

先手动 `ssh -p <端口> devlink@<服务器地址> true` 一次，把服务器的主机指纹存进 known_hosts，因为隧道是以 BatchMode 运行的。日志在 `~/Library/Logs/devlink/tunnel-server1.log`。同一台 Mac 要连多台服务器，就各写一份 `.env` 和 plist。

## 3. 服务器上的用户访问 Mac

在服务器上给运行 Claude 的用户（如 `claude`）生成一把专用密钥，再把公钥加进 Mac 的 `~/.ssh/authorized_keys`，并**限制它只能从隧道进来**：

```text
from="127.0.0.1,::1",no-agent-forwarding,no-X11-forwarding,no-port-forwarding ssh-ed25519 AAAA... server1-claude
```

服务器上 `~/.ssh/config` 里给 Mac 起个别名：

```text
Host mac-home
    HostName 127.0.0.1
    Port 22022
    User <Mac 用户名>
    IdentityFile ~/.ssh/id_ed25519_mac
    IdentitiesOnly yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ControlMaster auto
    ControlPersist 10m
    ControlPath ~/.cache/devlink/control-%C
```

Mac 需要在"系统设置 → 通用 → 共享"里打开"远程登录"。上游客户端自带的那条设备通道不需要它，这条常驻隧道需要。

## 4. 把 Mac 上的 MCP 服务器接到服务器上

```bash
cp custom/server/{mcp-over-ssh,mcp-resilient} ~/.local/bin/
# 代码 MCP：{cwd} 会被替换成服务器上当前的真实路径，由 router 找到对应的 Mac 文件夹
claude mcp add -s user mac-workspace -- ~/.local/bin/mcp-over-ssh mac-home \
  '~/.local/bin/mac-workspace-mcp-router --remote-root {cwd}'
# 其他任意 stdio MCP 都可以这样接，比如在 Mac 上跑的语义检索
claude mcp add -s user fast-context-mac -- ~/.local/bin/mcp-over-ssh mac-home \
  'PATH=/opt/homebrew/bin:$PATH npx -y fast-context-mcp@latest'
```

要点：
- 非交互的 ssh 只有一个很精简的 PATH，所以命令里要写全路径，或者像上面那样手动补上 PATH。
- `mcp-resilient` 负责断线重连：在途的调用会收到"请重试"的错误；断开期间发来的调用会排队，最多等 90 秒；首次启动失败会报出真实原因，而不是卡到超时。日志在 `~/.cache/mcp-resilient.log`。
- `projects.conf` 每行写 `Mac 文件夹|服务器文件夹`，router 和 `CCDT_PROJECT_MAP` 用的是同一份。

## 5. 浏览器

做法和上面一样：浏览器 MCP 跑在 Mac 上，服务器通过 `mcp-over-ssh` 调用它，这样操作的就是你 Mac 上已经登录好的浏览器。可以用的方案（具体参数以各项目自己的文档为准）：

- **Claude in Chrome**（Anthropic 官方扩展）：按官方方式使用，需要 claude.ai 账号登录。
- **Chrome DevTools MCP**（`chrome-devtools-mcp`，Google 开源）：连接一个开了远程调试端口的 Chrome。
- **Playwright MCP**（`@playwright/mcp`，微软开源）：可以自己启动浏览器，也可以通过它的扩展连接你现有的浏览器。

例子：

```bash
claude mcp add -s user mac-browser -- ~/.local/bin/mcp-over-ssh mac-home \
  'PATH=/opt/homebrew/bin:$PATH npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222'
```

本仓库不包含任何修改 Claude Code 或官方扩展、绕过其登录要求的东西。

## 6. 桌面控制（computer use）

浏览器之外，还可以让服务器上的 Claude 操作 Mac 上的应用：截图、读界面元素（AX 树）、点击、输入、按键、滚动。这里用的是开源的 [blade-computer-use](https://github.com/echoVic/blade-computer-use)（MIT）。它由一个 Node MCP 服务和一个常驻的 Swift 辅助程序组成，截图、读界面元素、发送键鼠事件都由辅助程序来做。

**坑：ssh 拉起的辅助程序截不了屏。** macOS 的隐私权限（TCC）判断的是"负责进程"。经 ssh 启动的进程，负责进程是 `sshd-keygen-wrapper`，所以"录屏"会被拒绝。这时候 MCP 照样显示 Connected，但截图一定失败。

**办法：让 launchd 在图形会话里拉起辅助程序，ssh 这边只做转发。**

```bash
# Mac：辅助程序改由 launchd 按连接拉起（inetd 模式，一个连接一个进程），权限就算在辅助程序自己头上
cp custom/mac/gui-helper-relay ~/.local/bin/
mkdir -p -m 700 ~/.local/state/blade-computer-use
B=~/src/blade-computer-use   # blade 的源码目录，先按它的 README 编译好 native helper
sed -e "s|@NAME@|blade|g" -e "s|@HOME@|$HOME|g" \
    -e "s|@PROGRAM@|$B/native/BladeComputerUseHelper/.build/release/BladeComputerUseHelper|" \
    -e "s|@SOCKET@|$HOME/.local/state/blade-computer-use/helper.sock|" \
    custom/mac/gui-helper.plist.in > ~/Library/LaunchAgents/local.gui-helper.blade.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.gui-helper.blade.plist
```

然后在"系统设置 → 隐私与安全性"里，给 `BladeComputerUseHelper` 打开"录屏与系统录音"和"辅助功能"。如果没有提示，就手动添加上面那个路径。辅助程序是 ad-hoc 签名的，每次重新编译后都要重新授权。

```bash
# 服务器：blade 的 Node 服务经 ssh 启动，通过 gui-helper-relay 连到 launchd 拉起的那个辅助程序
cp custom/server/{computer-use-mac,mcp-resilient} ~/.local/bin/
CUA_HOST=mac-home CUA_APPS=com.apple.TextEdit claude mcp add -s user computer-use-mac -- ~/.local/bin/computer-use-mac
```

更稳妥的做法是把 `CUA_HOST`、`CUA_BLADE_DIR`、`CUA_APPS` 这几个变量直接写进脚本开头。`CUA_APPS` 填应用的 bundle id，多个用逗号隔开；填 `all` 表示所有应用（blade 仍然会禁止操作锁屏界面和系统授权弹窗）。在 bypass 模式下放开所有应用，就等于让 Claude 能以你的身份操作这台 Mac 上的任何应用，请自己想清楚再开。

**验证：不要把 Connected 当作成功。** 新建一个测试文档，用 TextEdit 打开，依次 observe（确认返回的 PNG 确实是这个窗口）→ click 文本区 → observe → type_text → observe，最后确认输入的文字出现在 AX 树里。`ax_tree` 返回的是缩进文本，比如 `[2] AXTextArea value=...`，传给 `element_index` 的就是方括号里的数字。每次 observe 拿到的 revision 只能用于一次动作。

## 7. 其他

- **通知**：先把 `custom/server/notify-device` 放到 `~/.local/bin/`，再在服务器的 `~/.claude/settings.json` 里加上下面这段。`NOTIFY_HOST` 写在 `~/.claude/settings.json` 的 `env` 里，或者写进服务的环境：

  ```json
  "hooks": { "Notification": [ { "matcher": "permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input",
    "hooks": [ { "type": "command", "command": "~/.local/bin/notify-device", "timeout": 20 } ] } ] }
  ```

  Claude 回复完你 60 秒没输入，或者有审批等了 6 秒，Mac 上就会弹通知。你在终端前时不会弹。
- **项目映射表**：在 crontab 里加 `*/2 * * * * SYNC_HOSTS="mac-home mac-air" ~/.local/bin/sync-project-map`。
- **安全**：服务器能通过隧道以你的 Mac 用户身份做任何事。服务器、`PROXY_TOKEN` 和这几把密钥，都要按"等于这台 Mac 的控制权"来保管。
