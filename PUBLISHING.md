# 发布到 VS Code 插件市场（Visual Studio Marketplace）

本文把 **Keil MDK Tools**（`llllishuo.keil-mdk-tools`）发布到 VS Code 插件市场的完整流程写清楚：
一次性准备、首次发布、后续版本发布、GitHub Actions 自动化，以及常见报错处理。

> 官方文档：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

## 0. 前置条件

| 条件 | 说明 |
| --- | --- |
| Microsoft 账号 | 用于登录 Marketplace 管理后台（个人账号即可）。 |
| Publisher（发布者） | 在 Marketplace 上创建一个发布者，ID 建议用 `llllishuo`，必须与 `package.json` 的 `"publisher"` 一致。**Publisher ID 创建后不能修改**。 |
| Personal Access Token (PAT) | Azure DevOps 生成的令牌，`vsce` 用它上传扩展。 |
| Node.js ≥ 20 | `@vscode/vsce` 4.x 要求。本机已验证 Node 24。 |
| 扩展元数据 | `README.md`、`LICENSE`、`CHANGELOG.md`、`media/icon.png`（128×128 以上 PNG）、`repository` 字段。当前仓库均已具备。 |

## 1. 创建 Publisher

1. 打开 <https://marketplace.visualstudio.com/manage>，用 Microsoft 账号登录。
2. 点击 **Create publisher**：
   - **ID**：`llllishuo`（全小写，之后不可改）
   - **Name**：`llllishuo` 或 `Keil MDK Tools`
3. 创建完成后，页面会显示 `Publisher ID: llllishuo`。

> 如果你希望用别的 ID，请同时修改 `package.json` 的 `"publisher"`，否则上传会报 `Publisher ... not found`。

## 2. 创建 PAT（Azure DevOps）

1. 打开 <https://dev.azure.com> 并登录（与 Marketplace 相同的 Microsoft 账号）。
2. 右上角 **User settings → Personal access tokens → New Token**。
3. 设置：
   - **Name**：`vsce-publish`
   - **Organization**：**All accessible organizations**（必须，否则 vsce 会 401）
   - **Expiration**：按需（例如 90 天）
   - **Scopes**：勾选 **Marketplace → Manage**（只勾这一项即可）
4. 创建后**立即复制** token（只显示一次）。

## 3. 首次发布

在仓库根目录（`C:\Keil_v5\keil-vscode`）执行：

```powershell
# 1) 安装依赖、编译、跑单测
npm ci
npm run compile
npm test

# 2) 本地打包自测（生成 .vsix，不联网）
npx @vscode/vsce package --no-dependencies

# 3) 登录（粘贴上一步的 PAT）
npx @vscode/vsce login llllishuo

# 4) 发布
npx @vscode/vsce publish --no-dependencies
```

发布成功后：

- 管理页：<https://marketplace.visualstudio.com/manage/publishers/llllishuo>
- 商品页：<https://marketplace.visualstudio.com/items?itemName=llllishuo.keil-mdk-tools>
- 用户安装：`code --install-extension llllishuo.keil-mdk-tools`

> Marketplace 可能有几分钟的索引延迟；刚发布时搜索不到属正常现象。

## 4. 发布前检查清单

- [ ] `package.json` 中 `publisher` 与 Marketplace 发布者 ID 一致。
- [ ] `version` 未被占用（同一版本不能重复发布）。
- [ ] `README.md` 不包含本机绝对路径、内网地址、许可证密钥等敏感信息。
- [ ] `media/icon.png` 存在且 ≥128×128（当前 256×256）。
- [ ] `repository` / `bugs` / `homepage` 指向公开仓库。
- [ ] `npm run compile` 通过，`npm test` 全绿。
- [ ] `npx @vscode/vsce ls` 检查打包文件清单，确认没有 `node_modules`、源码、测试、`*.vsix`。
- [ ] 先 `vsce package` 安装本地 .vsix 自测一次：`code --install-extension .\keil-mdk-tools-0.1.0.vsix`。
- [ ] `engines.vscode` 不要低于实际使用的 API 版本。
- [ ] 若扩展有运行时依赖，确保已打包（本扩展无运行时依赖，只有 devDependencies）。

## 5. 后续版本发布

```powershell
# 方式 A：手动改版本 + 发布
npm version patch        # 0.1.0 -> 0.1.1（minor / major 同理）
git push --follow-tags
npx @vscode/vsce publish --no-dependencies

# 方式 B：让 vsce 自动递增并发布
npx @vscode/vsce publish patch --no-dependencies
```

`vsce publish` 会自动执行 `vscode:prepublish`（本仓库为 `npm run compile`），所以发布前**不需要**手动编译。

## 6. GitHub Actions 自动化（推荐）

仓库已包含两个工作流（见 `.github/workflows/`）：

- `ci.yml`：push / PR 时在 Windows 上编译 + 单测 + 打包 VSIX（作为 artifact）。
- `release.yml`：推送 `v*` 标签时创建 GitHub Release，并在配置了 `VSCE_PAT` 的情况下自动发布到 Marketplace。

启用自动发布：

1. 进入 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret**。
2. 名称：`VSCE_PAT`，值：第 2 步生成的 PAT。
3. 发布新版本：

```powershell
npm version patch
git push --follow-tags
```

工作流会执行 `npx @vscode/vsce publish --no-dependencies -p "$VSCE_PAT"`。

> 安全建议：PAT 仅放在 GitHub Secret 或本机凭据管理器，不要提交到仓库、不要写进 README。

## 7. 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| `401 Unauthorized` | PAT 过期、scope 没勾 **Marketplace → Manage**、Organization 没选 **All accessible organizations**。重新生成 PAT 后 `vsce login` 再试。 |
| `403 Forbidden` / `not a member` | PAT 所属账号不是该 publisher 的成员；确认登录账号。 |
| `Publisher 'xxx' not found` | `package.json` 的 `publisher` 与已创建发布者 ID 不一致。 |
| `Extension 'xxx' already exists` | 名字被占用（其他 publisher 已发布同名扩展）；只能改 `name`。 |
| `The personal access token verification has failed` | 令牌权限不足或已失效；重新生成。 |
| 上传后页面 404 | 索引延迟，等待几分钟；仍不行检查版本是否已存在。 |
| `Extension entrypoint(s) missing` | 忘记编译：确保 `out/extension.js` 存在（`npm run compile`）。 |
| 图标不显示 | 用 PNG（非 SVG），建议 256×256；路径 `media/icon.png`。 |
| `VSIX too large` | 检查 `.vscodeignore` 是否误打包 `node_modules`、`out` 之外的源码/测试。 |

## 8. 下架与回滚

```powershell
# 查看已发布版本
npx @vscode/vsce ls

# 下架某个版本（谨慎，用户将无法安装该版本）
npx @vscode/vsce unpublish llllishuo.keil-mdk-tools@0.1.0
```

回滚通常的做法是**发布一个更高的修复版本**，而不是删除旧版本。

## 9. 本仓库相关命令速查

```powershell
npm ci                              # 安装开发依赖
npm run compile                     # TypeScript -> out/
npm test                            # node --test out/test/core.test.js
npx @vscode/vsce package --no-dependencies   # 生成 .vsix
npx @vscode/vsce publish --no-dependencies   # 发布当前版本
npx @vscode/vsce login llllishuo             # 保存 PAT
```
