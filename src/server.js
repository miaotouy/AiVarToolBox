// 加载环境变量
const path = require('path'); // 确保 path 模块在 dotenv 之前引入
require('dotenv').config({ path: path.resolve(__dirname, '../config.env') }); // 使用绝对路径加载 .env
const configService = require('./configService'); // 引入配置服务模块
configService.init(); // 初始化配置服务，加载配置

const express = require('express');
// const path = require('path'); // path 已在上面引入
const workflow = require('./workflow'); // 引入工作流逻辑

const app = express();
const port = configService.get('PORT', 3001); // 使用配置服务获取端口号，默认值为 3001

// 中间件
app.use(express.json()); // 解析 JSON 请求体
app.use(express.static(path.join(__dirname, '../public'))); // 提供 public 目录下的静态文件

// API 路由
app.post('/api/chat', async (req, res) => {
    const userMessage = req.body.message;
    console.log('Received message from frontend:', userMessage);

    if (!userMessage) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        // 调用核心工作流逻辑处理用户消息
        let aiReply = await workflow.handleMessage(userMessage);
        console.log('Initial workflow reply:', aiReply);

        // --- 自动推进工作流 ---
        // 检测特定的回复模式以触发后续步骤，直到回复稳定或流程结束
        while (
            aiReply.includes('[[DeepResearchStart]]') || // 明确的启动信号
            aiReply.includes('正在生成关键词...') ||     // 中间状态提示
            aiReply.includes('正在搜索下一个关键词:') || // 中间状态提示
            aiReply.includes('正在进行深度判断...') ||   // 中间状态提示
            aiReply.includes('将根据指示继续搜索新关键词:') || // 中间状态提示
            aiReply.includes('正在生成最终报告...') ||     // 正常进入报告生成
            aiReply.includes('正在尝试生成最终报告...') || // 出错后尝试进入报告生成
            aiReply.includes('强制生成最终报告...')       // 新增：达到深度上限时强制进入报告生成
           ) {
             // 如果是这些中间状态，我们再次调用 handleMessage (不带用户输入) 来驱动流程
             console.log(`Workflow indicates progression. Triggering next step... (Previous reply ended with: "...${aiReply.slice(-30)}")`);
             // 注意：传递 null 或特定内部信号作为 userMessage 可能更好，
             // 但当前 workflow.js 设计在非 INITIAL_CHAT 状态下会忽略 userMessage
             aiReply = await workflow.handleMessage(null); // 传递 null 表示内部驱动
             console.log('Next workflow step reply:', aiReply);
             // 添加一个小的延迟避免潜在的无限循环或过快请求 (可选)
             // await new Promise(resolve => setTimeout(resolve, 100));
        }
        // --- 工作流自动推进结束 ---

        const finalResponse = { reply: aiReply };
        // 检查工作流最终状态，如果完成且有报告，则添加标记
        if (workflow.getCurrentState() === 'FINISHED' && workflow.getLatestReport()) {
            finalResponse.reportReady = true;
            console.log('Report is ready, adding flag for frontend.');
        }

        console.log('Final reply to frontend:', finalResponse);
        res.json(finalResponse);

    } catch (error) {
        console.error('Error processing chat message in server:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 新增：报告下载路由
app.get('/api/download-report', (req, res) => {
    const reportContent = workflow.getLatestReport();
    if (reportContent) {
        // 设置响应头，告诉浏览器这是一个要下载的文件
        res.setHeader('Content-Disposition', 'attachment; filename="research_report.md"');
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.send(reportContent);
    } else {
        res.status(404).send('No report available for download.');
    }
});


// 根路由，提供 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// 配置页面路由，提供 config.html
app.get('/config', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'config.html'));
});

// 获取当前配置 API
app.get('/api/config', (req, res) => {
    const allConfig = configService.getAll();
    // 暂时不处理 requiresRestart 标记，因为 configService.isRestartRequired 是占位符
    res.json(allConfig);
});

// 更新配置 API (目前仅更新内存)
app.post('/api/config', (req, res) => {
    const newSettings = req.body;
    configService.update(newSettings)
        .then(() => {
            res.json({ message: "配置更新已启动 (目前仅在内存中生效)。" });
        })
        .catch(error => {
            console.error('更新配置时出错:', error);
            res.status(500).json({ error: '更新配置失败。' });
        });
});

// 启动服务器
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    console.log('API Key:', configService.get('API_Key') ? 'Loaded' : 'Not Loaded!'); // 检查 API Key 是否加载
    console.log('API URL:', configService.get('API_URL'));
    console.log('Think Model:', configService.get('ThinkModel'));
    console.log('Fast Model:', configService.get('FastModel'));
});