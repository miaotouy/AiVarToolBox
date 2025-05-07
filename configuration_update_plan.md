# 配置更新与热更新兼容性实施计划

## 目标

使 `VarEmojiPrompt` 中的端口号动态化，并确保整个占位符替换过程与配置热更新机制兼容。

## 核心问题

1.  根目录 `server.js` 中的 `replaceCommonVariables` 函数直接使用 `process.env` 获取配置值，这与 `src/configService.js` 提供的热更新机制不兼容。
2.  `replaceCommonVariables` 函数未处理 `{{Port}}` 占位符。
3.  需要确保 `VarEmojiPrompt` 内部的 `{{Port}}` 和 `{{Image_Key}}` 占位符在正确时机被解析。

## 实施步骤

### 步骤 1：核心改造 - 统一配置读取

*   **确认**：`src/configService.js` 是配置管理和热更新的权威组件。
*   **改造根目录 `server.js`**：
    *   引入 `src/configService.js`（例如 `const configService = require('./src/configService');`，路径可能需要调整）。
    *   确保 `configService` 在 `server.js` 中被正确初始化（如果需要调用 `configService.init()`）。
    *   修改 `server.js` 中所有直接读取 `process.env.CONFIG_KEY` 的地方（尤其是在 `replaceCommonVariables` 函数内部，以及顶层定义的如 `apiKey`、`apiUrl`、`port` 等变量），全部改为通过 `configService.get('CONFIG_KEY')` 获取。

### 步骤 2：增强 `replaceCommonVariables` 函数

*   **使用 `configService`**：将函数内部所有 `process.env` 读取改为 `configService.get()`。例如：
    *   `process.env[envKey]`（用于 `Varxxx`） -> `configService.get(envKey)`
    *   `process.env.Image_Key` -> `configService.get('Image_Key')`
    *   `emojiPromptTemplate = process.env.VarEmojiPrompt` -> `emojiPromptTemplate = configService.get('VarEmojiPrompt')`
*   **添加对 `{{Port}}` 的处理**：在函数内部（例如，在处理 `Varxxx` 之前或之后，但在 `VarEmojiPrompt` 被最终使用之前）加入逻辑：
    ```javascript
    const currentPort = configService.get('Port'); // 从 configService 获取
    if (currentPort && typeof processedText === 'string') { // 确保 processedText 是字符串
        processedText = processedText.replaceAll('{{Port}}', currentPort);
    }
    ```
*   **优化 `VarEmojiPrompt` 内部占位符的解析顺序**：
    *   当前的 `{{Varxxx}}` 循环会把 `{{VarEmojiPrompt}}` 替换为 `configService.get('VarEmojiPrompt')` 的原始字符串。
    *   然后，`{{EmojiPrompt}}` 的处理逻辑会使用这个原始字符串。
    *   我们需要确保在 `VarEmojiPrompt` 的内容被用于替换 `{{EmojiPrompt}}` **之前**，它内部的 `{{Port}}` 和 `{{Image_Key}}` 已经被正确解析。
    *   一种方法是，在 `replaceCommonVariables` 函数中，考虑进行多轮替换，或者调整各个替换块的顺序。例如：
        1.  先完成所有基础变量的替换（如 `Date`, `Time`, `Port`, `Image_Key`, `VarCity`, `VarUser` 等，但不包括 `VarEmojiPrompt` 这种本身是模板的）。
        2.  然后，获取 `VarEmojiPrompt` 的模板字符串 (`configService.get('VarEmojiPrompt')`)，并用步骤1中解析出的值**再次调用一个简化的替换函数**或直接替换其内部的 `{{Port}}` 和 `{{Image_Key}}`，得到一个 "完全解析的 `VarEmojiPrompt` 内容"。
        3.  然后，在处理 `{{VarEmojiPrompt}}` 占位符时，用这个 "完全解析的 `VarEmojiPrompt` 内容" 去替换。
        4.  最后，处理 `{{EmojiPrompt}}` 时，它引用的 `emojiPromptTemplate` (即 `VarEmojiPrompt`) 已经是完全解析过的了（除了内部的 `{{通用表情包}}`，那部分会按现有逻辑处理）。

### 步骤 3：修改配置文件

*   修改 [`config.env.example`](config.env.example:15) 和 [`.env`](.env:15) 文件，将 `VarEmojiPrompt` 修改为包含 `{{Port}}` 和 `{{Image_Key}}` 的形式：
    ```
    VarEmojiPrompt="注意:本客户端实现了表情包功能，表情包图床路径为(url:{{Port}}/pw={{Image_Key}}/images/通用表情包/)。使用方式示例输出如右 <img src=\"url:{{Port}}/pw={{Image_Key}}/images/通用表情包/阿库娅-一脸智障.jpg\" width=\"100\">。你可以灵活在你的输出内容里插入表情包，注意加入表情图的前后换行，注意用width参数(100-500)来控制表情包图的尺寸。目前的表情包文件有:{{通用表情包}}。"
    ```

## Mermaid 流程图

```mermaid
graph TD
    A[开始: 用户指出 server.js 中已有替换代码] --> B{分析根目录 server.js};
    B --> C{发现 replaceCommonVariables 函数及其现有逻辑};
    C --> D[主要问题: 直接使用 process.env 与 src/configService.js 的热更新机制冲突];
    D --> E[其他问题: {{Port}}未处理, VarEmojiPrompt内部占位符解析顺序];

    E --> F[步骤1: 核心改造 - 统一配置读取];
    F --> F1{确认 src/configService.js 为热更新权威来源};
    F --> F2{修改根目录 server.js: 引入并使用 src/configService};
    F2 --> F3["所有 process.env.KEY 读取改为 configService.get('KEY')"];

    E --> G[步骤2: 增强 replaceCommonVariables 函数];
    G --> G1[将内部所有 process.env 读取改为 configService.get()];
    G --> G2[添加对 {{Port}} 的替换 (使用 configService.get('Port'))];
    G --> G3[优化/确保 VarEmojiPrompt 内部 {{Port}}, {{Image_Key}} 的解析时机];
    G3 --> G4["确保在 VarEmojiPrompt 被用作替换值前,其内部占位符已用实时值解析"];
    
    E --> H[步骤3: 修改配置文件 (config.env.example, .env)];
    H --> H1["VarEmojiPrompt='...url:{{Port}}/pw={{Image_Key}}...'"];

    F3 --> I{调用时机: server.js 的 /v1/chat/completions 路由已正确调用 replaceCommonVariables};
    I --> J[完成: 动态化、热更新兼容的占位符替换];