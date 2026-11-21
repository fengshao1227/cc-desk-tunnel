# ccbot：让一个机器人指挥服务端上的会话

`ccbot` 让 Grok Bot 这类能跑命令的机器人，在用户不在电脑前时新建、继续、审批和停止 CC Desk Tunnel 的会话。
它不改服务端，也不新开端口：

- **读**：直接只读打开服务端的 `sessions.sqlite`（会话列表、每一轮的事件）。
- **写**：用服务凭据通过本机 `wss://127.0.0.1:<PROXY_PORT>/ws` 连上服务端，自称设备「Grok Bot」，只发
  `server.session.create`、`session.configure`、`message.send`、`approval.reply`、`run.cancel` 这几种命令。
  所以 GUI、ccdt 和网页工作台都能看到它做的一切，会话照常由服务端托管，断开连接不影响运行。
- **项目目录**：`ccbot new <项目>` 建的是服务端会话，在第一次运行前把它的工作目录
  `<data>/native/<root>` 做成指向 `CCDT_PROJECT_MAP` 里该项目服务器文件夹的软链接，和设备会话的做法一样，
  于是项目的 CLAUDE.md 和记忆都在。

## 机器人怎么调用

机器人在 Mac 上运行 `mac/ccbot`，它用一把专用 SSH 钥匙连服务器。服务器的 `authorized_keys` 把这把钥匙限定为
`restrict,command="~/.local/bin/ccbot-ssh"`：不能开终端、不能转发端口、只能运行 ccbot。
参数从 `SSH_ORIGINAL_COMMAND` 读，逐个校验（不许空格和 shell 字符），每次调用记进
`~/.local/state/ccbot/audit.log`（只记命令，不记标准输入里的正文）。

## 安装

服务器上（服务用户）：

```sh
sh custom/ccbot/install.sh                          # 装 ~/.local/bin/ccbot 与 ccbot-ssh
sh custom/ccbot/install.sh --key "$(cat bot.pub)"   # 再授权机器人的公钥，只能跑 ccbot
```

Mac 上：

```sh
ssh-keygen -t ed25519 -N '' -f ~/.ssh/ccbot_grok
cp custom/ccbot/mac/ccbot ~/.local/bin/ && chmod 755 ~/.local/bin/ccbot
printf 'CCBOT_HOST=claude@<服务器>\nCCBOT_PORT=<ssh 端口>\n' > ~/.config/ccbot/env
```

把 [GROK.md](GROK.md) 交给机器人当使用说明。新会话默认审批模式是 `default`（服务端环境变量
`CCBOT_DEFAULT_MODE` 可改），有风险的操作会停下来等审批，退出码 3。

## 测试

```sh
node --test custom/ccbot/test/*.test.mjs
```

用到服务端内部的两处约定，升级上游后要复核：`sessions`/`events` 两张表的结构，和
`<data>/native/<root>` 作为会话工作目录（`apps/server/src/claude.ts` 的 `nativeDirectory`）。
