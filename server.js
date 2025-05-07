// server.js
const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const lunarCalendar = require('chinese-lunar-calendar'); // 导入整个模块
const fs = require('fs').promises; // 使用 fs.promises 进行异步文件操作
const path = require('path');
const { Writable } = require('stream'); // 引入 Writable 用于收集流数据
const crypto = require('crypto'); // 新增：用于生成 UUID

// 加载环境变量
// 注意：configService.init() 内部也会加载 config.env，这里的调用可能主要用于填充 process.env 以兼容旧代码或第三方库。
// 项目的核心业务逻辑应优先使用 configService.get() 获取配置。
dotenv.config({ path: 'config.env' });

// 引入 configService
const configService = require('./src/configService');

// 初始化 configService
configService.init();

// --- 新增：图片转译和缓存相关 ---
// const imageModelName = configService.get('ImageModel'); // 冗余，translateImageAndCache 内动态获取
// const imagePromptText = configService.get('ImagePrompt'); // 冗余，translateImageAndCache 内动态获取
const imageCacheFilePath = path.join(__dirname, 'imagebase64.json');
let imageBase64Cache = {}; // 内存缓存
const imageModelOutputMaxTokens = parseInt(configService.get('ImageModelOutput', '1024'), 10); // 新增，带默认值
const imageModelThinkingBudget = parseInt(configService.get('ImageModelThinkingBudget', '0'), 10); // 新增, 可选
// const imageModelContentMax = parseInt(configService.get('ImageModelContent', '0'), 10); // 新增, 暂不直接使用于请求体
const enableBase64Cache = (configService.get('Base64Cache', 'True') || "True").toLowerCase() === "true"; // 新增，默认为True
// --- 图片转译和缓存相关结束 ---

// --- 读取系统提示词转换规则 ---
const detectors = [];
const envKeys = Object.keys(configService.getAll());
for (const key of envKeys) {
    if (/^Detector\d+$/.test(key)) {
        const index = key.substring(8); // 获取数字部分
        const outputKey = `Detector_Output${index}`;
        if (configService.get(outputKey)) {
            detectors.push({
                detector: configService.get(key),
                output: configService.get(outputKey)
            });
            console.log(`加载转换规则: "${configService.get(key)}" -> "${configService.get(outputKey)}"`);
        } else {
            console.warn(`警告: 找到 ${key} 但未找到对应的 ${outputKey}`);
        }
    }
}
if (detectors.length > 0) {
    console.log(`共加载了 ${detectors.length} 条系统提示词转换规则。`);
} else {
    console.log('未加载任何系统提示词转换规则。');
}
// --- 转换规则读取结束 ---

// --- 读取全局上下文转换规则 ---
const superDetectors = [];
for (const key of envKeys) {
    if (/^SuperDetector\d+$/.test(key)) {
        const index = key.substring(13); // 获取数字部分
        const outputKey = `SuperDetector_Output${index}`;
        if (configService.get(outputKey)) {
            superDetectors.push({
                detector: configService.get(key),
                output: configService.get(outputKey)
            });
            console.log(`加载全局上下文转换规则: "${configService.get(key)}" -> "${configService.get(outputKey)}"`);
        } else {
            console.warn(`警告: 找到 ${key} 但未找到对应的 ${outputKey}`);
        }
    }
}
if (superDetectors.length > 0) {
    console.log(`共加载了 ${superDetectors.length} 条全局上下文转换规则。`);
} else {
    console.log('未加载任何全局上下文转换规则。');
}
// --- 全局上下文转换规则读取结束 ---

const app = express();
const port = configService.get('PORT', 5890); // 从 configService 获取端口
// const apiKey = configService.get('API_Key'); // 将在路由处理器中动态获取
// const apiUrl = configService.get('API_URL'); // 将在路由处理器中动态获取
// const serverKey = configService.get('Key'); // 将在认证中间件中动态获取
// const systemInfo = configService.get('VarSystemInfo'); // 冗余, replaceCommonVariables 动态处理 {{VarSystemInfo}}
const weatherInfoPath = configService.get('VarWeatherInfo', 'Weather.txt'); // 从 configService 读取 VarWeatherInfo (路径通常固定)
// const weatherModel = configService.get('WeatherModel'); // 冗余, fetchAndUpdateWeather 内动态获取
// const weatherPromptTemplate = configService.get('WeatherPrompt'); // 冗余, fetchAndUpdateWeather 内动态获取
// const city = configService.get('VarCity'); // 冗余, replaceCommonVariables 动态处理 {{VarCity}}
// const emojiPromptTemplate = configService.get('VarEmojiPrompt'); // 冗余, replaceCommonVariables 动态获取 VarEmojiPrompt
// const userInfo = configService.get('VarUser'); // 冗余, replaceCommonVariables 动态处理 {{VarUser}}

let cachedWeatherInfo = ''; // 用于缓存天气信息的变量
const cachedEmojiLists = new Map(); // 使用 Map 存储所有表情包列表缓存

// 中间件：解析 JSON 和 URL 编码的请求体，增加大小限制以支持大型 Base64 数据
app.use(express.json({ limit: '300mb' })); // 将 JSON 限制增加到 300MB
app.use(express.urlencoded({ limit: '300mb', extended: true })); // 将 URL 编码限制增加到 300MB

// --- 提供静态图片文件 (修改为带鉴权) ---
// app.use('/images', express.static(path.join(__dirname, 'image'))); // 旧的无鉴权服务，将被移除或注释
// console.log(`图片服务已启动，访问路径: /images`);

// 新的图片访问鉴权中间件
const imageAuthMiddleware = (req, res, next) => {
    const pathSegmentWithKey = req.params.pathSegmentWithKey; // 例如 "pw=YOUR_IMAGE_KEY"
    const serverImageKeyForAuth = configService.get('Image_Key');

    if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
        const requestImageKey = pathSegmentWithKey.substring(3); // 提取 "pw=" 后面的部分
        if (requestImageKey === serverImageKeyForAuth) {
            next(); // Key 有效，继续处理请求
        } else {
            // console.warn(`图片访问鉴权失败: 提供的 Key "${requestImageKey}" 无效`);
            return res.status(401).type('text/plain').send('Unauthorized: Invalid key for image access.');
        }
    } else {
        // console.warn(`图片访问鉴权失败: 路径格式不正确 "${pathSegmentWithKey}"`);
        return res.status(400).type('text/plain').send('Bad Request: Invalid image access path format.');
    }
};

// 新的受保护的图片服务路由
// 匹配 /pw=KEY/images/* 格式
// :pathSegmentWithKey 会捕获 "pw=KEY" 这部分
app.use('/:pathSegmentWithKey/images', imageAuthMiddleware, express.static(path.join(__dirname, 'image')));
console.log(`受保护的图片服务已启动，访问路径格式: /pw=YOUR_IMAGE_KEY/images/...`);
// 旧的 /images 路径不再直接可用

// 中间件：记录所有传入请求
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] Received ${req.method} request for ${req.url} from ${req.ip}`);
    next(); // 继续处理请求
});
// 中间件：认证
app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    const currentServerKey = configService.get('Key'); // 动态获取
    if (!authHeader || authHeader !== `Bearer ${currentServerKey}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// --- 表情包列表更新与加载 (通用函数) ---
async function updateAndLoadAgentEmojiList(agentName, dirPath, filePath) {
    console.log(`尝试更新 ${agentName} 表情包列表...`);
    let newList = '';
    let errorMessage = ''; // 用于存储错误信息或最终列表
    try {
        const files = await fs.readdir(dirPath);
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
        newList = imageFiles.join('|');
        await fs.writeFile(filePath, newList);
        console.log(`${agentName} 表情包列表已更新并写入 ${filePath}`);
        errorMessage = newList; // 成功时，errorMessage 存储新列表
    } catch (error) {
        if (error.code === 'ENOENT') {
            errorMessage = `${agentName} 表情包目录 ${dirPath} 不存在，无法生成列表。`;
            console.error(errorMessage);
        } else {
            errorMessage = `更新或写入 ${agentName} 表情包列表 ${filePath} 时出错: ${error.message}`;
            console.error(errorMessage, error);
        }
        // 尝试创建包含错误信息的文件
        try {
            await fs.writeFile(filePath, errorMessage);
            console.log(`已创建空的 ${filePath} 文件，内容为错误信息。`);
        } catch (writeError) {
            console.error(`创建空的 ${filePath} 文件失败:`, writeError);
        }

        // 尝试读取旧文件（如果生成失败）
        try {
            const oldList = await fs.readFile(filePath, 'utf-8');
            // 只有当旧列表不是我们刚写入的错误信息时，才使用旧列表
            if (oldList !== errorMessage) {
                console.log(`从 ${filePath} 加载了旧的 ${agentName} 表情包列表。`);
                errorMessage = oldList; // 使用旧列表覆盖错误信息
            }
        } catch (readError) {
            if (readError.code !== 'ENOENT') {
                console.error(`读取旧的 ${agentName} 表情包列表 ${filePath} 失败:`, readError);
            }
            // 读取旧文件失败，保持 errorMessage (即生成时的错误信息)
        }
    }
    return errorMessage; // 返回生成的列表或错误信息或旧列表
}

// 变量替换逻辑
// 注意：这个函数现在处理所有通用变量，包括 EmojiPrompt
async function replaceCommonVariables(text) {
    // 首先检查 text 是否为 null 或 undefined，如果是，则直接返回空字符串或进行其他适当处理
    if (text == null) {
        return ''; // 或者返回 text 本身，取决于期望的行为
    }
    let processedText = String(text); // 确保处理的是字符串
    const now = new Date();

    // {{Date}} - 日期
    const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Date\}\}/g, date);

    // {{Time}} - 时间
    const time = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Time\}\}/g, time);

    // {{Today}}
    const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Today\}\}/g, today);

    // {{Festival}}
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // getMonth() 返回 0-11，需要加 1
    const day = now.getDate();
    const lunarDate = lunarCalendar.getLunar(year, month, day); // 传递年、月、日
    let yearName = lunarDate.lunarYear.replace('年', ''); // 从 '乙巳年' 提取 '乙巳'
    let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`; // 拼接成 "乙巳蛇年四月初三"
    if (lunarDate.solarTerm) { // 检查实际的节气属性 solarTerm
        festivalInfo += ` ${lunarDate.solarTerm}`;
    }
    processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);

    // {{SystemInfo}} - 现在将通过下面的通用 Varxxx 逻辑处理
    // processedText = processedText.replace(/\{\{SystemInfo\}\}/g, systemInfo || '未配置系统信息'); // 由通用逻辑处理

    // {{WeatherInfo}} - 这个比较特殊，它不是 Var 开头，但也是动态替换
    processedText = processedText.replace(/\{\{WeatherInfo\}\}/g, cachedWeatherInfo || '天气信息不可用');

    // {{City}} - 由通用 {{VarCity}} 逻辑处理
    // processedText = processedText.replace(/\{\{City\}\}/g, city || '未配置城市');

    // {{User}} - 由通用 {{VarUser}} 逻辑处理
    // processedText = processedText.replace(/\{\{User\}\}/g, userInfo || '未配置用户信息');

    // --- 通用处理 {{Varxxx}} 占位符 ---
    // 这个循环应该在其他特定占位符（如 Date, Time, WeatherInfo）之后，但在表情包、日记等复杂逻辑之前
    const allConfig = configService.getAll();
    for (const envKey in allConfig) {
        if (envKey.startsWith('Var')) {
            const placeholder = `{{${envKey}}}`; // 例如 {{VarCity}}
            const value = allConfig[envKey];
            // 确保 value 不是 undefined 或 null，如果是，则使用空字符串或特定提示
            const replacementValue = (value === null || value === undefined) ? `未配置${envKey}` : String(value);
            processedText = processedText.replaceAll(placeholder, replacementValue);
        }
    }
    // --- {{Varxxx}} 处理结束 ---

   // --- 动态处理 {{xx表情包}} 占位符 ---
   const emojiPlaceholderRegex = /\{\{(.+?表情包)\}\}/g;
   let emojiMatch;
   while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
       const placeholder = emojiMatch[0]; // e.g., {{小克表情包}}
       const emojiName = emojiMatch[1]; // e.g., 小克表情包
       const emojiList = cachedEmojiLists.get(emojiName);
       processedText = processedText.replaceAll(placeholder, emojiList || `${emojiName}列表不可用`);
   }

   // {{EmojiPrompt}} - 动态生成通用 Emoji 提示 (现在依赖于 {{通用表情包}} 占位符)
   // 注意：此处的 emojiPromptTemplate 是从 configService.get('VarEmojiPrompt') 获取的原始模板
   // 它内部的 {{Port}} 和 {{Image_Key}} 将在后续步骤中被替换
   const currentEmojiPromptTemplate = configService.get('VarEmojiPrompt'); // 实时获取模板
   if (processedText.includes('{{EmojiPrompt}}')) {
       let finalEmojiPrompt = '';
       if (currentEmojiPromptTemplate) {
           // EmojiPrompt 模板现在应该包含 {{通用表情包}}
           // 我们需要先替换掉 EmojiPrompt 模板内的 {{通用表情包}}
           const generalEmojiList = cachedEmojiLists.get('通用表情包');
           finalEmojiPrompt = currentEmojiPromptTemplate.replace(/\{\{通用表情包\}\}/g, generalEmojiList || '通用表情包列表不可用');
       }
       // 使用正则表达式进行全局替换，以防原始文本中出现多个 {{EmojiPrompt}}
       processedText = processedText.replace(/\{\{EmojiPrompt\}\}/g, finalEmojiPrompt);
   }

// --- 处理 {{角色名日记本}} 占位符 ---
    const diaryPlaceholderRegex = /\{\{(.+?)日记本\}\}/g;
    // 使用一个临时变量来处理替换，避免在循环中修改正在迭代的字符串导致问题
    let tempProcessedText = processedText;
    const diaryMatches = tempProcessedText.matchAll(diaryPlaceholderRegex);

    // 使用 Set 存储已处理的角色名，避免重复读取同一角色的日记
    const processedCharacters = new Set();

    for (const match of diaryMatches) {
        const placeholder = match[0]; // e.g., {{小克日记本}}
        const characterName = match[1]; // e.g., 小克

        // 如果已处理过这个角色，跳过，因为 replaceAll 会处理所有实例
        if (processedCharacters.has(characterName)) {
            continue;
        }

        const diaryDirPath = path.join(__dirname, 'dailynote', characterName);
        let diaryContent = `[${characterName}日记本内容为空或不存在]`; // 默认内容

        try {
            const files = await fs.readdir(diaryDirPath);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
            // 按文件名（日期）排序，让日记按时间顺序排列
            txtFiles.sort();

            if (txtFiles.length > 0) {
                const fileContents = await Promise.all(
                    txtFiles.map(async (file) => {
                        const filePath = path.join(diaryDirPath, file);
                        try {
                            // 读取文件内容
                            const fileData = await fs.readFile(filePath, 'utf-8');
                            // 返回文件名（日期）和内容，方便后续格式化
                            return fileData; // 文件内容已包含 [日期] 头
                        } catch (readErr) {
                            console.error(`读取日记文件 ${filePath} 失败:`, readErr);
                            return `[读取文件 ${file} 失败]`; // 指示特定文件的错误
                        }
                    })
                );
                // 使用分隔符连接所有日记内容
                diaryContent = fileContents.join('\n\n---\n\n'); // 使用醒目的分隔符
            }
        } catch (error) {
            if (error.code !== 'ENOENT') { // ENOENT (目录未找到) 由默认消息处理
                console.error(`读取 ${characterName} 日记目录 ${diaryDirPath} 出错:`, error);
                diaryContent = `[读取${characterName}日记时出错]`;
            }
            // 如果是 ENOENT，则保持默认消息
        }
        // 替换所有该角色的日记本占位符
        tempProcessedText = tempProcessedText.replaceAll(placeholder, diaryContent);
        // 标记该角色已处理
        processedCharacters.add(characterName);
    }
    // 将处理完日记占位符的结果赋回
    processedText = tempProcessedText;
    // --- 日记本占位符处理结束 ---

    // --- 系统提示词转换 ---
    for (const rule of detectors) {
        // 确保 detector 和 output 都是字符串，并且 detector 不为空
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
             // 使用 replaceAll 进行全局替换
             processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }
    // --- 系统提示词转换结束 ---

    // --- 全局上下文转换 ---
    for (const rule of superDetectors) {
        // 确保 detector 和 output 都是字符串，并且 detector 不为空
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
             // 使用 replaceAll 进行全局替换
             processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }
    // --- 全局上下文转换结束 ---

    // 替换 VarEmojiPrompt 中可能引入的 {{API_Key}} 占位符
    // 这确保了如果 VarEmojiPrompt 的内容（其中包含 {{Image_Key}}）被注入到 processedText 中，
    // 这里的 {{Image_Key}} 会被替换成真实的 Image_Key 值。

    // --- 在所有 Varxxx 和 EmojiPrompt 处理完之后，再处理 Port 和 Image_Key ---
    // 这样可以确保如果 VarEmojiPrompt 模板是通过 {{VarEmojiPrompt}} 注入的，
    // 其内部的 {{Port}} 和 {{Image_Key}} 也能被替换。

    // 替换 {{Port}}
    const currentPort = configService.get('Port');
    if (currentPort && typeof processedText === 'string') {
        processedText = processedText.replaceAll('{{Port}}', currentPort);
    }

    // 替换 {{Image_Key}}
    const currentImageKey = configService.get('Image_Key');
    if (processedText && typeof processedText === 'string' && currentImageKey) {
        processedText = processedText.replaceAll('{{Image_Key}}', currentImageKey);
    }

    return processedText;
}

// --- 天气获取与缓存逻辑 ---
async function fetchAndUpdateWeather() {
    console.log('尝试获取最新的天气信息...');
    const currentApiUrl = configService.get('API_URL');
    const currentApiKey = configService.get('API_Key');
    const currentWeatherModel = configService.get('WeatherModel');
    const currentWeatherPromptTemplate = configService.get('WeatherPrompt');

    if (!currentApiUrl || !currentApiKey || !currentWeatherModel || !currentWeatherPromptTemplate) {
        console.error('获取天气所需的配置不完整 (API_URL, API_Key, WeatherModel, WeatherPrompt)');
        cachedWeatherInfo = '天气服务配置不完整';
        return;
    }

    try {
        // 替换 Prompt 中的变量 (只需要 Date 和 City)
        const now = new Date();
        const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        let prompt = currentWeatherPromptTemplate.replace(/\{\{Date\}\}/g, date);
        // WeatherPrompt 在 config.env 中已更新为 {{VarCity}}
        // 此处的替换逻辑将由 replaceCommonVariables 中的通用 {{Varxxx}} 处理
        // 因此，在调用 fetchAndUpdateWeather 之前，weatherPromptTemplate 应该已经被 replaceCommonVariables 处理过
        // 如果 fetchAndUpdateWeather 被独立调用（例如初始化时），则需要确保其 prompt 也能被正确替换
        // 为了安全起见，我们在这里保留对 {{VarCity}} 的显式替换，以防 weatherPromptTemplate 未被完全处理
        // 或者，更好的做法是确保 fetchAndUpdateWeather 接收的 prompt 已经是完全处理过的
        // 考虑到 fetchAndUpdateWeather 可能会在 replaceCommonVariables 之外被调用（例如初始化），
        // 并且其模板只包含 {{Date}} 和 {{VarCity}}，这里可以针对性处理。
        // 但更统一的做法是，让 replaceCommonVariables 处理所有模板。
        // 假设 weatherPromptTemplate 在这里已经是原始模板，需要替换
        prompt = prompt.replace(/\{\{VarCity\}\}/g, configService.get('VarCity', '默认城市'));

        // --- First API Call ---
        const weatherModelMaxTokens = parseInt(configService.get('WeatherModelMaxTokens', '0'), 10); // 读取配置
        const firstApiPayload = {
            model: currentWeatherModel,
            messages: [{ role: 'user', content: prompt }],
            tools: [
                {
                    "type": "function",
                    "function": {
                        "name": "google_search",
                        "description": "Perform a Google search to find information on the web.",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {
                                    "type": "string",
                                    "description": "The search query."
                                }
                            },
                            "required": ["query"]
                        }
                    }
                }
            ],
            tool_choice: "auto"
        };

        if (weatherModelMaxTokens && !isNaN(weatherModelMaxTokens) && weatherModelMaxTokens > 0) {
            firstApiPayload.max_tokens = weatherModelMaxTokens;
            console.log(`[WeatherFetch] 第一次天气 API 调用使用 MaxTokens: ${weatherModelMaxTokens}`);
        }

        let response = await fetch(`${currentApiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentApiKey}`,
            },
            body: JSON.stringify(firstApiPayload),
        });

        if (!response.ok) {
            throw new Error(`第一次天气 API 调用失败: ${response.status} ${response.statusText}`);
        }

        let data = await response.json();
        // Removed Raw data log

        const firstChoice = data.choices?.[0];
        const message = firstChoice?.message;

        // --- Check for Tool Calls ---
        if (firstChoice?.finish_reason === 'tool_calls' && message?.tool_calls) {
            // Removed log marker
            const toolCalls = message.tool_calls;

            // Prepare messages for the second API call
            const messagesForSecondCall = [
                { role: 'user', content: prompt }, // Original user prompt
                message, // Assistant's message requesting tool call(s)
            ];

            // Add tool results (we assume the proxy handles execution, send back arguments as placeholder result)
            for (const toolCall of toolCalls) {
                 if (toolCall.type === 'function' && toolCall.function.name === 'google_search') {
                     // Removed tool result log
                     messagesForSecondCall.push({
                         role: 'tool',
                         tool_call_id: toolCall.id,
                         // Since server.js doesn't execute the search, we send back the arguments
                         // The proxy at localhost:3000 should ideally use this or have already executed it.
                         content: `Tool call requested with arguments: ${toolCall.function.arguments}`,
                     });
                 }
            }

            // --- Second API Call ---
            // Removed log marker
            const secondApiPayload = {
                model: currentWeatherModel,
                messages: messagesForSecondCall,
            };

            // weatherModelMaxTokens is defined at the top of fetchAndUpdateWeather
            if (weatherModelMaxTokens && !isNaN(weatherModelMaxTokens) && weatherModelMaxTokens > 0) {
                secondApiPayload.max_tokens = weatherModelMaxTokens;
                console.log(`[WeatherFetch] 第二次天气 API 调用使用 MaxTokens: ${weatherModelMaxTokens}`);
            }

            response = await fetch(`${currentApiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentApiKey}`,
                },
                // Send the history including the tool call request and our constructed tool result
                // DO NOT send 'tools' or 'tool_choice' in the second call
                body: JSON.stringify(secondApiPayload),
            });

            if (!response.ok) {
                throw new Error(`第二次天气 API 调用失败: ${response.status} ${response.statusText}`);
            }

            data = await response.json();
            // Removed Raw data log
        } else {
             // Removed log marker
        }

        // --- Process Final Response ---
        let weatherContent = data.choices?.[0]?.message?.content || '';
        console.log('Final extracted content:', weatherContent); // Keep log for final content
        // Removed log marker

        const match = weatherContent.match(/\[WeatherInfo:(.*?)\]/s); // 使用 s 标志使 . 匹配换行符
        if (match && match[1]) {
            cachedWeatherInfo = match[1].trim();
            console.log('天气信息已更新并缓存。');
            try {
                await fs.writeFile(weatherInfoPath, cachedWeatherInfo);
                console.log(`天气信息已写入 ${weatherInfoPath}`);
            } catch (writeError) {
                console.error(`写入天气文件 ${weatherInfoPath} 失败:`, writeError);
            }
        } else {
            console.warn('从 API 返回结果中未能提取到 [WeatherInfo:...] 格式的天气信息。原始返回:', weatherContent);
            cachedWeatherInfo = '未能从API获取有效天气信息';
        }

    } catch (error) {
        console.error('获取或处理天气信息时出错:', error);
        cachedWeatherInfo = `获取天气信息时出错: ${error.message}`;
    }
}

// --- 日记处理函数 ---
// --- 修改：handleDailyNote 处理新的结构化格式 ---
async function handleDailyNote(noteBlockContent) {
    // console.log('[handleDailyNote] 开始处理新的结构化日记块...');
    const lines = noteBlockContent.trim().split('\n');
    let maidName = null;
    let dateString = null;
    let contentLines = [];
    let isContentSection = false;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('Maid:')) {
            maidName = trimmedLine.substring(5).trim();
            isContentSection = false; // 遇到新 Key，重置 Content 标记
        } else if (trimmedLine.startsWith('Date:')) {
            dateString = trimmedLine.substring(5).trim();
            isContentSection = false;
        } else if (trimmedLine.startsWith('Content:')) {
            isContentSection = true;
            // 如果 Content: 后面同一行有内容，也算进去
            const firstContentPart = trimmedLine.substring(8).trim();
            if (firstContentPart) {
                contentLines.push(firstContentPart);
            }
        } else if (isContentSection) {
            // Content: 之后的所有行都属于内容
            contentLines.push(line); // 保留原始行的缩进和格式
        }
    }

    const contentText = contentLines.join('\n').trim(); // 组合内容并去除首尾空白

    if (!maidName || !dateString || !contentText) {
        console.error('[handleDailyNote] 无法从日记块中完整提取 Maid, Date, 或 Content:', { maidName, dateString, contentText: contentText.substring(0,100)+ '...' });
        return;
    }

    // console.log(`[handleDailyNote] 提取信息: Maid=${maidName}, Date=${dateString}`);
    const datePart = dateString.replace(/[.-]/g, '.'); // 统一日期分隔符
    const dirPath = path.join(__dirname, 'dailynote', maidName);
    const baseFileNameWithoutExt = datePart; // e.g., "2025.5.2"
    const fileExtension = '.txt';
    let finalFileName = `${baseFileNameWithoutExt}${fileExtension}`; // Initial filename, e.g., "2025.5.2.txt"
    let filePath = path.join(dirPath, finalFileName);
    let counter = 1;

    // console.log(`[handleDailyNote] 准备写入日记: 目录=${dirPath}, 基础文件名=${baseFileNameWithoutExt}`);
    // console.log(`[handleDailyNote] 日记文本内容 (前100字符): ${contentText.substring(0, 100)}...`);

    try {
        // 确保目录存在
        // console.log(`[handleDailyNote] 尝试创建目录: ${dirPath}`);
        await fs.mkdir(dirPath, { recursive: true });
        // console.log(`[handleDailyNote] 目录已确保存在或已存在: ${dirPath}`);

        // 循环检查文件名是否存在，如果存在则尝试添加序号
        while (true) {
            try {
                await fs.access(filePath, fs.constants.F_OK); // 检查文件是否存在
                // 文件存在，生成下一个带序号的文件名
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`; // e.g., "2025.5.2(1).txt"
                filePath = path.join(dirPath, finalFileName);
                counter++;
                // console.log(`[handleDailyNote] 文件已存在，尝试下一个序号: ${finalFileName}`);
            } catch (err) {
                // 如果错误是 ENOENT (文件不存在)，说明找到了可用的文件名
                if (err.code === 'ENOENT') {
                    // console.log(`[handleDailyNote] 找到可用文件名: ${finalFileName}`);
                    break; // 跳出循环，使用当前的 filePath
                } else {
                    // 如果是其他访问错误，则抛出异常
                    console.error(`[handleDailyNote] 检查文件 ${filePath} 存在性时发生意外错误:`, err);
                    throw err; // 重新抛出未预期的错误
                }
            }
        }

        // 使用找到的最终文件名写入文件
        // console.log(`[handleDailyNote] 最终尝试写入文件: ${filePath}`);
        await fs.writeFile(filePath, `[${datePart}] - ${maidName}\n${contentText}`); // 在内容前添加 [日期] - 署名 头
        console.log(`[handleDailyNote] 日记文件写入成功: ${filePath}`); // 记录最终写入的文件路径
    } catch (error) {
        // 保持现有的详细错误日志记录
        console.error(`[handleDailyNote] 处理日记文件 ${filePath} 时捕获到错误 (最终尝试的文件路径):`); // 指明这是最终尝试的路径
        console.error(`  错误代码 (code): ${error.code}`);
        console.error(`  系统调用 (syscall): ${error.syscall}`);
        console.error(`  路径 (path): ${error.path}`);
        console.error(`  错误号 (errno): ${error.errno}`);
        console.error(`  错误信息 (message): ${error.message}`);
        console.error(`  错误堆栈 (stack): ${error.stack}`);
    }
}

// --- 代理路由 ---

// --- 新增：保存图片缓存到文件 ---
async function saveImageCache() {
    try {
        await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
        // console.log(`图片 Base64 缓存已保存到 ${imageCacheFilePath}`); // 可以取消注释以进行调试
    } catch (error) {
        console.error(`保存图片 Base64 缓存到 ${imageCacheFilePath} 失败:`, error);
    }
}

// --- 新增：图片转译和缓存核心逻辑 ---
async function translateImageAndCache(base64DataWithPrefix, imageIndexForLabel) {
    // 提取纯 Base64 数据
    const base64PrefixPattern = /^data:image\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const imageMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:image/jpeg;base64,'])[0].replace('base64,', '');

    // --- 修改：处理新的缓存结构 ---
    const cachedEntry = imageBase64Cache[pureBase64Data];
    if (cachedEntry) {
        const description = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry.description;
        console.log(`[ImageCache] 命中缓存 (ID: ${typeof cachedEntry === 'object' ? cachedEntry.id : 'N/A - old format'})，图片 ${imageIndexForLabel + 1}`);
        return `[IMAGE${imageIndexForLabel + 1}Info: ${description}]`;
    }
    // --- 缓存结构处理结束 ---

    console.log(`[ImageTranslate] 开始转译图片 ${imageIndexForLabel + 1}，调用 API...`);
    const currentImageModelName = configService.get('ImageModel');
    const currentImagePromptText = configService.get('ImagePrompt');
    const currentApiKey = configService.get('API_Key');
    const currentApiUrl = configService.get('API_URL');

    if (!currentImageModelName || !currentImagePromptText || !currentApiKey || !currentApiUrl) {
        console.error('图片转译所需的配置不完整 (ImageModel, ImagePrompt, API_Key, API_URL)');
        return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译服务配置不完整]`;
    }

    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
        attempt++;
        console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1}，尝试 #${attempt}`);
        try {
            const payload = {
                model: currentImageModelName,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: currentImagePromptText },
                            { type: "image_url", image_url: { url: `${imageMimeType}base64,${pureBase64Data}` } }
                        ]
                    }
                ],
                max_tokens: parseInt(configService.get('ImageModelOutput', '1024'), 10), // 动态获取
            };
            
            // 添加 thinking_config 如果 ImageModelThinkingBudget 有效
            const currentImageModelThinkingBudget = parseInt(configService.get('ImageModelThinkingBudget', '0'), 10); // 动态获取
            if (currentImageModelThinkingBudget && !isNaN(currentImageModelThinkingBudget) && currentImageModelThinkingBudget > 0) {
                payload.extra_body = { // 确保是 extra_body
                    thinking_config: {
                        thinking_budget: currentImageModelThinkingBudget
                    }
                };
                console.log(`[ImageTranslate] 使用 Thinking Budget: ${currentImageModelThinkingBudget}`);
            }


            const fetchResponse = await fetch(`${currentApiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentApiKey}`,
                },
                body: JSON.stringify(payload),
            });

            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                throw new Error(`API 调用失败 (尝试 ${attempt}): ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
            }

            const result = await fetchResponse.json();
            const description = result.choices?.[0]?.message?.content?.trim();

            if (description && description.length >= 50) { // 新增：检查描述长度
                console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 转译成功且内容足够 (尝试 #${attempt})。长度: ${description.length}`);
                
                // 清理描述中的潜在非法JSON字符 (移除U+0000-U+0008, U+000B, U+000C, U+000E-U+001F)
                const cleanedDescription = description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
                if (description.length !== cleanedDescription.length) {
                    console.warn(`[ImageTranslate] 清理了描述中的特殊字符。原长度: ${description.length}, 清理后长度: ${cleanedDescription.length}. Base64Key (头30): ${pureBase64Data.substring(0,30)}`);
                }

                // --- 修改：保存为新的缓存结构 ---
                const newCacheEntry = {
                    id: crypto.randomUUID(),
                    description: cleanedDescription, // 使用清理后的描述
                    timestamp: new Date().toISOString()
                };
                imageBase64Cache[pureBase64Data] = newCacheEntry;
                // --- 缓存结构修改结束 ---
                await saveImageCache(); // 异步保存到文件
                return `[IMAGE${imageIndexForLabel + 1}Info: ${description}]`;
            } else if (description) { // 如果有描述但太短
                lastError = new Error(`描述过短 (长度: ${description.length}, 少于50字符) (尝试 ${attempt})。内容: ${description.substring(0,100)}...`);
                console.warn(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} ${lastError.message}`);
            } else { // 如果完全没有描述
                lastError = new Error(`转译结果中未找到描述 (尝试 ${attempt})。原始返回: ${JSON.stringify(result)}`);
                console.warn(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} ${lastError.message}`);
            }
        } catch (error) {
            lastError = error; // API 调用本身的错误
            console.error(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 转译时出错 (尝试 #${attempt}):`, error.message);
        }

        if (attempt < maxRetries) {
            console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1}，将在500ms后重试...`);
            await new Promise(resolve => setTimeout(resolve, 500)); // 延迟500ms
        }
    }

    console.error(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 在 ${maxRetries} 次尝试后转译失败。最后错误: ${lastError ? lastError.message : '未知错误'}`);
    return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译在 ${maxRetries} 次尝试后失败: ${lastError ? lastError.message.substring(0,150) : '未知错误'}...]`;
}


app.post('/v1/chat/completions', async (req, res) => {
    try {
        const originalBody = req.body;
        let globalImageIndexForLabel = 0; // 用于生成 IMAGE1Info, IMAGE2Info 标签

        // --- 图片转译和缓存处理 (根据 Base64Cache 开关决定是否执行) ---
        const currentEnableBase64Cache = (configService.get('Base64Cache', 'True') || "True").toLowerCase() === "true"; // 动态获取
        if (currentEnableBase64Cache) {
            console.log('[Base64Cache] 功能已启用，开始处理图片...');
            if (originalBody.messages && Array.isArray(originalBody.messages)) {
                for (let i = 0; i < originalBody.messages.length; i++) {
                    const msg = originalBody.messages[i];
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    const imagePartsToTranslate = [];
                    const contentWithoutImages = []; // 用于重建消息内容

                    for (const part of msg.content) {
                        if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' && part.image_url.url.startsWith('data:image')) {
                            imagePartsToTranslate.push(part.image_url.url);
                        } else {
                            contentWithoutImages.push(part);
                        }
                    }

                    if (imagePartsToTranslate.length > 0) {
                        const translationPromises = imagePartsToTranslate.map((base64Url) =>
                            translateImageAndCache(base64Url, globalImageIndexForLabel++)
                        );
                        const translatedImageTexts = await Promise.all(translationPromises);

                        let userTextPart = contentWithoutImages.find(p => p.type === 'text');
                        if (!userTextPart) {
                            userTextPart = { type: 'text', text: '' };
                            contentWithoutImages.unshift(userTextPart); // 加到最前面
                        }
                        // 将所有图片信息追加到文本末尾
                        userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') + '[检测到多模态数据，Var工具箱已自动提取图片信息，信息元如下——]\n' + translatedImageTexts.join('\n');
                        msg.content = contentWithoutImages; // 更新消息内容，移除图片，保留（或添加）文本
                        }
                    }
                }
            }
            console.log('[Base64Cache] 图片处理完成。');
        } else {
            console.log('[Base64Cache] 功能已禁用，跳过图片转译和缓存处理。');
        }
        // --- 图片转译和缓存处理结束 ---

        // 处理 messages 数组中的变量替换 (现有逻辑)
        if (originalBody.messages && Array.isArray(originalBody.messages)) {
            originalBody.messages = await Promise.all(originalBody.messages.map(async (msg) => {
                const newMessage = JSON.parse(JSON.stringify(msg)); // 深拷贝
                if (newMessage.content && typeof newMessage.content === 'string') {
                    newMessage.content = await replaceCommonVariables(newMessage.content);
                } else if (Array.isArray(newMessage.content)) {
                    newMessage.content = await Promise.all(newMessage.content.map(async (part) => {
                        if (part.type === 'text' && typeof part.text === 'string') {
                            const newPart = JSON.parse(JSON.stringify(part));
                            newPart.text = await replaceCommonVariables(newPart.text);
                            return newPart;
                        }
                        return part;
                    }));
                }
                return newMessage;
            }));
        }
        // 注意：如果 messages 数组不存在或格式不正确，这里不再自动创建或修改
        // API 服务器应该处理无效的请求结构

        // 转发请求到 API 服务器
        const currentApiUrl = configService.get('API_URL'); // 动态获取
        const currentApiKey = configService.get('API_Key'); // 动态获取
        const response = await fetch(`${currentApiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentApiKey}`, // 使用动态获取的 API 服务器的 Key
                // 传递原始请求中的其他相关头部（如果需要的话），例如 User-Agent
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                ...(req.headers['accept'] && { 'Accept': req.headers['accept'] }),
                // 注意：不要转发 Host 或 Content-Length 等由 fetch 自动管理的头
            },
            body: JSON.stringify(originalBody), // 发送处理过的请求体
        });

        // 将 API 服务器的响应头复制到我们的响应中，过滤掉不需要的头
        res.status(response.status);
        response.headers.forEach((value, name) => {
            // 过滤掉可能导致问题的头信息
            // 'connection' 通常由 Node.js 或代理处理
            // 'content-length' 会根据响应体重新计算
            // 'keep-alive' 通常与 'connection' 相关
            if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                 res.setHeader(name, value);
            }
        });

        // --- 修改开始：恢复流式转发，同时在服务器端缓存以供检查 ---
        const chunks = []; // 用于在服务器端缓存响应

        // 监听数据块
        response.body.on('data', (chunk) => {
            chunks.push(chunk); // 缓存数据块
            res.write(chunk);   // 同时将数据块流式转发给客户端
        });

        // 监听流结束
        response.body.on('end', () => {
            res.end(); // 结束客户端的响应流

            // --- 在流结束后处理日记 (修改：先处理 SSE) ---
            const responseBuffer = Buffer.concat(chunks);
            const responseString = responseBuffer.toString('utf-8');
            // console.log('[DailyNote Check] 原始响应字符串 (前10000字符):', responseString.substring(0, 10000)); // Commented out raw string log

            let fullAiResponseText = '';
            let successfullyParsed = false;

            // --- Step 1: 尝试解析为 SSE 流 ---
            const lines = responseString.trim().split('\n');
            let sseContent = '';
            // 检查是否可能是 SSE 流 (至少包含 'data: ' 行)
            const looksLikeSSE = lines.some(line => line.startsWith('data: '));

            if (looksLikeSSE) {
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(5).trim();
                        if (jsonData === '[DONE]') continue;
                        try {
                            const parsedData = JSON.parse(jsonData);
                            const contentChunk = parsedData.choices?.[0]?.delta?.content || parsedData.choices?.[0]?.message?.content || '';
                            if (contentChunk) {
                                sseContent += contentChunk;
                            }
                        } catch (e) {
                            // 忽略无法解析的行, 可能是非 JSON 数据或注释
                        }
                    }
                }
                if (sseContent) {
                    fullAiResponseText = sseContent;
                    successfullyParsed = true;
                    console.log('[DailyNote Check] 成功从 SSE 流中提取内容。');
                }
            }

            // --- Step 2: 如果不是 SSE 或 SSE 解析未提取到内容，尝试解析为 JSON ---
            if (!successfullyParsed) {
                try {
                    const parsedJson = JSON.parse(responseString);
                    // 尝试从标准 OpenAI 格式提取内容
                    const jsonContent = parsedJson.choices?.[0]?.message?.content;
                    if (jsonContent && typeof jsonContent === 'string') {
                        fullAiResponseText = jsonContent;
                        successfullyParsed = true;
                        console.log('[DailyNote Check] 成功从 JSON 响应中提取内容。');
                    } else {
                        console.warn('[DailyNote Check] JSON 响应格式不符合预期，无法提取 message.content。');
                    }
                } catch (e) {
                    // 只有在看起来不像 SSE 的情况下才记录这个警告，避免 SSE 流结束时的 [DONE] 导致误报
                    if (!looksLikeSSE) {
                        console.warn('[DailyNote Check] 响应不是有效的 JSON 对象。无法提取内容。原始响应 (前500字符):', responseString.substring(0, 500));
                    } else {
                        // 如果看起来像 SSE 但 sseContent 为空，说明可能只有 [DONE] 或无效数据
                        console.log('[DailyNote Check] SSE 流解析未提取到有效内容。');
                    }
                }
            }

            // --- Step 3: 在提取到的文本上匹配日记标记 ---
            let match = null; // 初始化 match 为 null
            if (successfullyParsed && fullAiResponseText) {
                // console.log('[DailyNote Check] 提取到的 AI 回复文本 (前10000字符):', fullAiResponseText.substring(0, 10000));
                const dailyNoteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/s;
                // console.log('[DailyNote Check] 在提取文本上使用正则表达式:', dailyNoteRegex);
                match = fullAiResponseText.match(dailyNoteRegex); // 在这里进行匹配
            } else if (!successfullyParsed) {
                console.log('[DailyNote Check] 未能成功解析响应内容，跳过日记标记检查。');
            }

            if (match && match[1]) {
                const noteBlockContent = match[1].trim(); // 提取并去除首尾空白
                console.log('[DailyNote Check] 找到结构化日记标记，准备处理...'); // 简化找到标记的日志
                // 异步处理日记保存
                handleDailyNote(noteBlockContent).catch(err => {
                    console.error("处理结构化日记时发生未捕获错误:", err);
                });
            } else {
                 console.log('[DailyNote Check] 未找到结构化日记标记。'); // 简化未找到标记的日志
            }
            // --- 日记处理逻辑修改结束 ---

            // 原有的 JSON 解析逻辑已被包含在上面的 SSE 处理中或不再需要，故移除/注释
        });

        // 监听流错误
        response.body.on('error', (err) => {
            console.error('API 响应流错误:', err);
            // 尝试结束响应，如果尚未结束
            if (!res.writableEnded) {
                res.status(500).end('API response stream error');
            }
        });
        // --- 修改结束 ---

    } catch (error) {
        console.error('处理请求或转发时出错:', error);
        // 避免在已经发送头信息后再次发送错误 JSON
        if (!res.headersSent) {
             res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else {
             console.error("Headers already sent, cannot send error JSON.");
             // 尝试结束响应流，如果适用
             res.end();
        }
    }
});

// --- 初始化和定时任务 ---
async function initialize() {
    console.log('开始初始化表情包列表...');
    const imageDir = path.join(__dirname, 'image');
    try {
        const entries = await fs.readdir(imageDir, { withFileTypes: true });
        const emojiDirs = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('表情包'));

        if (emojiDirs.length === 0) {
            console.warn(`警告: 在 ${imageDir} 目录下未找到任何以 '表情包' 结尾的文件夹。`);
        } else {
            console.log(`找到 ${emojiDirs.length} 个表情包目录，开始加载...`);
            await Promise.all(emojiDirs.map(async (dirEntry) => {
                const emojiName = dirEntry.name;
                const dirPath = path.join(imageDir, emojiName);
                const filePath = path.join(__dirname, `${emojiName}.txt`);
                console.log(`正在处理 ${emojiName}... 目录: ${dirPath}, 列表文件: ${filePath}`);
                try {
                    const listContent = await updateAndLoadAgentEmojiList(emojiName, dirPath, filePath);
                    cachedEmojiLists.set(emojiName, listContent);
                    console.log(`${emojiName} 列表已加载并缓存。`);
                } catch (loadError) {
                    console.error(`加载 ${emojiName} 列表时出错:`, loadError);
                    cachedEmojiLists.set(emojiName, `${emojiName}列表加载失败`);
                }
            }));
            console.log('所有表情包列表加载完成。');
        }
    } catch (error) {
        console.error(`读取 image 目录 ${imageDir} 时出错:`, error);
    }
    console.log('表情包列表初始化结束。');

    // --- 新增：加载图片 Base64 缓存 ---
    console.log('开始初始化图片 Base64 缓存...');
    try {
        const data = await fs.readFile(imageCacheFilePath, 'utf-8');
        imageBase64Cache = JSON.parse(data);
        console.log(`从 ${imageCacheFilePath} 加载了 ${Object.keys(imageBase64Cache).length} 条图片缓存。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${imageCacheFilePath} 文件不存在，将创建新的缓存。`);
            imageBase64Cache = {}; // 初始化为空对象
            try {
                await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
                console.log(`已创建空的 ${imageCacheFilePath} 文件。`);
            } catch (writeError) {
                console.error(`创建空的 ${imageCacheFilePath} 文件失败:`, writeError);
            }
        } else {
            console.error(`读取图片缓存文件 ${imageCacheFilePath} 失败:`, error);
            imageBase64Cache = {};
        }
    }
    console.log('图片 Base64 缓存初始化结束。');
    // --- 图片 Base64 缓存加载结束 ---

    // 启动时尝试加载一次缓存的天气信息
    try {
        cachedWeatherInfo = await fs.readFile(weatherInfoPath, 'utf-8');
        console.log(`从 ${weatherInfoPath} 加载了缓存的天气信息。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${weatherInfoPath} 文件不存在，将尝试首次获取天气信息。`);
            await fetchAndUpdateWeather();
        } else {
            console.error(`读取天气文件 ${weatherInfoPath} 失败:`, error);
            cachedWeatherInfo = '读取天气缓存失败';
        }
    }

    // 安排每天凌晨4点更新天气
    schedule.scheduleJob('0 4 * * *', fetchAndUpdateWeather);
    console.log('已安排每天凌晨4点自动更新天气信息。');
}

// 启动服务器
app.listen(port, async () => {
    console.log(`中间层服务器正在监听端口 ${port}`); // port 通常固定，顶层获取可接受
    // console.log(`API 服务器地址: ${apiUrl}`); // apiUrl 现在在路由中动态获取，此处日志可移除或改为动态
    console.log(`API 服务器地址 (启动时): ${configService.get('API_URL')}`); // 日志中显示启动时的值
    await initialize(); // 初始化天气信息、表情包列表和定时任务
});