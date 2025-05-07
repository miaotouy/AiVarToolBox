# 配置页面与动态配置管理实施计划

## 1. 目标

为项目添加一个Web配置页面，允许用户方便地修改应用配置。大部分配置项支持热更新（无需重启服务器即可生效），仅服务器端口等底层配置需重启。

## 2. 核心组件

### 2.1. 自定义配置文件 (`config.custom.json`)

*   **位置**: 项目根目录。
*   **格式**: JSON。
*   **用途**: 存储用户通过配置页面设定的所有配置项。此文件的配置将覆盖 `config.env` 中的同名配置。

### 2.2. 集中配置管理模块 (`src/configService.js`)

*   **职责**:
    *   **初始化加载**: 服务器启动时，加载 `config.env` 作为基础配置，然后加载 `config.custom.json` 并用其内容覆盖基础配置，形成最终的运行时配置。
    *   **配置读取**: 提供 `get(key, defaultValue)` 方法，供应用其他模块动态获取最新的配置值。
    *   **配置更新**: 提供 `update(newSettings)` 方法，接收来自配置页面的新配置对象，将其完整写入 `config.custom.json`，并立即刷新内存中的运行时配置。
    *   **配置查询**: 提供 `getAll()` 方法，返回当前所有运行时配置的副本。
    *   **(可选)** `isRestartRequired(key)`: 判断某个配置项的修改是否需要重启服务器。
*   **实现要点**:
    *   内部维护 `currentConfig` 对象存储运行时配置。
    *   `init()`: 完成初始加载和合并逻辑。
    *   `update()`: 保存到文件后，应重新执行加载和合并逻辑以更新 `currentConfig`。

## 3. 主要模块改造

### 3.1. 服务器入口 (`src/server.js`)

*   **启动流程**:
    1.  引入并调用 `configService.init()`。
    2.  使用 `configService.get('PORT', 3001)` 启动HTTP服务器。
*   **API接口**:
    *   `GET /api/config`:
        *   调用 `configService.getAll()`。
        *   (可选) 为每个配置项附加 `requiresRestart` 标记。
        *   返回配置对象给前端。
    *   `POST /api/config`:
        *   接收前端提交的完整配置对象 (`newSettings`)。
        *   调用 `configService.update(newSettings)`。
        *   返回成功响应，并指明哪些配置（如 `PORT`）若被修改则需要重启。
*   **页面路由**:
    *   `GET /config`: 提供 `public/config.html`。

### 3.2. 核心逻辑模块 (`src/workflow.js`, `src/apiHelper.js`)

*   **移除**模块顶层通过 `process.env.CONFIG_KEY` 读取配置的语句。
*   在模块顶部引入 `configService`。
*   在函数内部需要配置值时，**动态调用** `configService.get('CONFIG_KEY')`。
    *   例如，在 `workflow.js` 中获取模型名称、API密钥、提示词等。
    *   在 `apiHelper.js` 中构建API请求时，动态获取 `API_URL`, `API_Key` 等。

## 4. 前端配置页面

### 4.1. HTML (`public/config.html`)

*   包含一个表单，列出 `config.env.example` 中所有可配置项的输入字段。
*   提供“保存配置”按钮。
*   (可选) 考虑将配置项分组显示，提高可读性。

### 4.2. JavaScript (`public/js/config.js`)

*   **加载配置**:
    *   页面加载时，请求 `GET /api/config` 获取当前配置。
    *   将配置值填充到表单字段。
    *   根据 `requiresRestart` 标记，在需要重启的配置项旁显示提示。
*   **保存配置**:
    *   点击“保存”时，收集表单所有字段的值，构成 `newSettings` 对象。
    *   `POST /api/config` 发送 `newSettings`。
    *   根据后端响应，显示成功消息，并明确提示哪些更改需要重启服务器。

## 5. 配置项生效方式

*   **需重启生效**:
    *   `Port` (服务器监听端口)
*   **可热更新生效** (通过 `configService` 动态读取，修改后即时生效):
    *   `API_Key`, `API_URL`, `Image_Key`
    *   所有模型名称和参数 (e.g., `ThinkModel`, `ThinkModelTemp`)
    *   所有提示词 (e.g., `DeepResearchPrompt`, `VarEmojiPrompt`)
    *   所有自定义变量 (e.g., `VarCity`, `VarUser`)
    *   `Detector` 和 `SuperDetector` 系列
    *   `DeepLoopLimit`
    *   `Key` (中间层服务器输出鉴权)
    *   `Base64Cache` (或更名为 `ClearBase64ImageAfterProcessing`): 控制是否在处理后清除图像的Base64数据。

## 6. 实施步骤建议

1.  实现 `src/configService.js` 的基本框架 (加载、get、getAll)。
2.  修改 `src/server.js` 以集成 `configService`，实现 `GET /api/config` 和 `POST /api/config` (先不处理文件写入，仅更新内存)。
3.  创建基础的 `public/config.html` 和 `public/js/config.js`，实现配置的加载显示和提交。
4.  完善 `configService.js` 的 `update` 方法，实现写入 `config.custom.json` 和刷新内存配置。
5.  逐步改造 `src/workflow.js` 和 `src/apiHelper.js`，使其从 `configService` 动态读取配置。
6.  测试热更新效果和需重启项的提示。
7.  (可选) 优化配置页面的UI/UX，如配置项分组、更友好的提示等。

## 7. 关于 `Base64Cache` 的命名

考虑到其真实作用，建议在代码和配置页面中，将原 `Base64Cache` 考虑更名为 `ClearBase64ImageAfterProcessing` 或类似更准确的名称，以避免混淆。如果采纳新命名，`config.env.example` 和相关文档也应同步更新。在 `configService` 内部处理时，可以兼容旧名称的读取，但保存时统一使用新名称。