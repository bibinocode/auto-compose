# 发布到 VS Code Marketplace

## 首次上架

1. 使用 Microsoft 账号登录 [Publisher 管理页](https://marketplace.visualstudio.com/manage)。
2. 创建 Publisher，记录其 **ID**。ID 与显示名称不同，也不一定等于 GitHub 用户名。
3. 本项目正式 Publisher ID 为 `bbnocode`，`package.json` 的 `publisher` 必须填写这个字符串，不要填写后台显示的 UUID。`name` 保持 `auto-compose`，`version` 必须是未发布过的版本号。
4. 在项目目录执行：

   ```sh
   npm ci
   npm run check
   npm run format:check
   npm run package
   ```

5. 回到 Publisher 管理页，选择 **New extension → Visual Studio Code**，上传根目录生成的 `.vsix` 文件。
6. 等待 Marketplace 校验和发布，确认详情页中的图标、介绍、仓库链接与安装功能。

首次推荐网页上传，不需要在仓库或聊天中提供发布 Token。GitHub 推送和 Actions 打包不会自动上架。

## 后续更新

更新 `package.json` 与 `package-lock.json` 中的版本号、补充 CHANGELOG 后，重新运行检查及打包。在管理页选择已有扩展的更新操作上传新的 VSIX。

发布者 ID 与插件 name 共同决定扩展标识。正式发布后尽量保持不变。从开发版改成正式 Publisher 后，VS Code 会视为不同扩展，需要停用开发版；原开发版 SecretStorage 密钥不会自动迁移，请在正式版重新配置。

## 自动构建

仓库中的 GitHub Actions 会在 `main` 推送或拉取请求时运行类型检查、测试、格式检查及打包。成功后可在 Actions 的 Artifacts 下载安装包。流程不包含发布权限或密钥，也不自动修改 Marketplace。

如需自动发布，参照微软最新的身份认证指南配置 Microsoft Entra ID 工作负载身份，或使用当时仍受支持的凭据方案。不要把凭据提交到仓库。

官方文档：[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。
