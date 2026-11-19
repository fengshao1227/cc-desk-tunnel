# 本 fork 的定制内容

本仓库 fork 自 [sun168567/cc-desk-tunnel](https://github.com/sun168567/cc-desk-tunnel)，版本号与上游保持一致，客户端（GUI 和 ccdt）直接用上游发布页的同版本即可。相比上游多了下面这些。

## 服务端功能

三项都由环境变量开启，不设置时行为与上游完全一样：

| 功能 | 变量 | 代码 |
| --- | --- | --- |
| 默认审批模式（例如 bypassPermissions） | `CCDT_DEFAULT_PERMISSION_MODE` | `apps/server/src/permission-default.ts` |
| 用自己的模板替换设备提示词 | `CCDT_DEVICE_PROMPT` | `apps/server/src/device-prompt.ts` |
| 项目与服务器文件夹共用会话（GUI、ccdt 和直接运行的 `claude` 互通） | `CCDT_PROJECT_MAP` | `apps/server/src/project-links.ts` |

对上游文件的改动只有 `store.ts`、`server.ts`、`native-terminal.ts`、`claude.ts` 里的十几行接入代码，合并上游新版本时冲突很少。测试在 `apps/server/test/customizations.test.ts`。

## 部署与周边

- [deploy/native/](deploy/native/README.md)：不用 Docker 的原生部署（systemd），包括 CentOS 7 这类老系统；`install.sh` 用于首次安装，`upgrade.sh` 用于升级和回滚。
- [custom/](custom/README.md)：Mac 端的部分，包括反向隧道、通过 SSH 把 Mac 上的 MCP 服务器（代码、检索、浏览器）接到服务器上、断线自动重连、`safe-edit`、通知钩子，以及桌面控制（computer use），包括 ssh 拉起的辅助程序截不了屏的解决办法。

## 和上游保持同步

```bash
git remote add upstream https://github.com/sun168567/cc-desk-tunnel.git   # 只需一次
git fetch upstream --tags && git merge vX.Y.Z && npm test && git push origin main
# 然后在服务器上：bash deploy/native/upgrade.sh
```
