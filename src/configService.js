// 咕咕：集中配置管理模块
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

let currentConfig = {};

/**
 * @description 初始化配置，加载 .env 和 config.custom.json
 * @returns {Promise<void>}
 */
async function init() {
    console.log('咕咕：ConfigService.init() 开始加载配置...');
    const envConfigPath = path.resolve(process.cwd(), 'config.env');
    let baseConfig = {};
    let customConfig = {};

    // 1. 加载 config.env
    try {
        if (fs.existsSync(envConfigPath)) {
            const envFileContent = fs.readFileSync(envConfigPath, { encoding: 'utf8' });
            baseConfig = dotenv.parse(envFileContent);
            console.log('咕咕：成功加载 config.env');
        } else {
            console.warn(`咕咕：警告 - config.env 文件未找到于 ${envConfigPath}，将使用空基础配置。`);
        }
    } catch (error) {
        console.error('咕咕：加载 config.env 出错:', error);
        // 即使 .env 加载失败，也继续尝试加载 custom config
    }

    // 2. 加载 config.custom.json
    const customConfigPath = path.resolve(process.cwd(), 'config.custom.json');
    try {
        if (fs.existsSync(customConfigPath)) {
            const customFileContent = fs.readFileSync(customConfigPath, { encoding: 'utf8' });
            customConfig = JSON.parse(customFileContent);
            console.log('咕咕：成功加载 config.custom.json');
        } else {
            console.warn(`咕咕：警告 - config.custom.json 文件未找到于 ${customConfigPath}，将视为空自定义配置。`);
        }
    } catch (error) {
        console.error('咕咕：加载或解析 config.custom.json 出错:', error);
        console.warn('咕咕：config.custom.json 内容无效或非JSON格式，将视为空自定义配置。');
        customConfig = {}; // 出错则视为空对象
    }

    // 3. 合并配置，customConfig 覆盖 baseConfig
    currentConfig = { ...baseConfig, ...customConfig };
    console.log('咕咕：配置加载并合并完成。当前配置键:', Object.keys(currentConfig).join(', '));
}

/**
 * @description 获取指定键的配置值
 * @param {string} key - 配置项的键
 * @param {any} [defaultValue] - 如果键不存在时返回的默认值
 * @returns {any} 配置值或默认值
 */
function get(key, defaultValue = undefined) {
    // 确保 init 完成后再获取
    if (Object.keys(currentConfig).length === 0) {
        // 理论上 init 应该在应用启动时调用，这里加个提醒
        console.warn('咕咕：警告 - 尝试在 ConfigService.init() 完成前调用 get()。可能导致配置不准确。');
    }
    return currentConfig.hasOwnProperty(key) ? currentConfig[key] : defaultValue;
}

/**
 * @description 获取所有配置项的副本
 * @returns {object} 当前所有配置项的副本
 */
function getAll() {
    // 确保 init 完成后再获取
    if (Object.keys(currentConfig).length === 0) {
        console.warn('咕咕：警告 - 尝试在 ConfigService.init() 完成前调用 getAll()。可能导致配置不准确。');
    }
    return { ...currentConfig }; // 返回副本
}

/**
 * @description 更新配置项 (占位符)
 * @param {object} newSettings - 新的配置对象
 * @returns {Promise<void>}
 */
async function update(newSettings) {
    console.log('咕咕：ConfigService.update() 被调用，参数:', newSettings);
    const customConfigPath = path.resolve(process.cwd(), 'config.custom.json');
    try {
        // 将新配置写入 config.custom.json 文件
        await fs.promises.writeFile(customConfigPath, JSON.stringify(newSettings, null, 2), { encoding: 'utf8' });
        console.log('咕咕：成功写入 config.custom.json');
        // 重新初始化配置以刷新内存中的 currentConfig
        await init();
        console.log('咕咕：内存配置已刷新');
    } catch (error) {
        console.error('咕咕：更新配置出错:', error);
        throw error;
    }
}

/**
 * @description 判断某个配置项的修改是否需要重启服务器 (占位符)
 * @param {string} key - 配置项的键
 * @returns {boolean}
 */
function isRestartRequired(key) {
    console.log('咕咕：ConfigService.isRestartRequired() 被调用，参数:', key);
    // 根据配置项生效方式列表，判断是否需要重启服务器
    return key === 'PORT';
}

module.exports = {
    init,
    get,
    getAll,
    update,
    isRestartRequired,
};