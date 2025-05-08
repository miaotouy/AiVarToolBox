// 页面加载时执行
document.addEventListener('DOMContentLoaded', async () => {
    // 加载配置
    try {
        const response = await fetch('/api/config');
        const configData = await response.json();
        
        // 填充表单字段
        const form = document.getElementById('configForm');
        for (const [key, configItem] of Object.entries(configData)) {
            const input = form.querySelector(`[name="${key}"]`);
            const noticeElement = document.getElementById(`${key}_restart_notice`);

            if (input) {
                if (input.type === 'checkbox') {
                    // 后端 configService.get 返回的是字符串 "True" 或 "False" 或实际布尔值
                    // HTML input.checked 需要布尔值
                    input.checked = String(configItem.value).toLowerCase() === 'true';
                } else {
                    input.value = configItem.value !== null && configItem.value !== undefined ? configItem.value : '';
                }
            }

            if (noticeElement) {
                if (configItem.requiresRestart) {
                    noticeElement.textContent = '(需要重启)';
                } else {
                    noticeElement.textContent = '(热更新)';
                }
            }
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        alert('加载配置失败，请检查服务器连接。');
    }

    // 表单提交事件监听
    const form = document.getElementById('configForm');
    form.addEventListener('submit', async (event) => {
        event.preventDefault(); // 阻止默认提交行为

        // 收集表单数据
        const formData = new FormData(form);
        const configObject = Object.fromEntries(formData.entries());

        // 处理复选框的值
        for (const [key, value] of Object.entries(configObject)) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input && input.type === 'checkbox') {
                configObject[key] = input.checked ? 'True' : 'False';
            }
        }

        try {
            // 发送配置数据到后端
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(configObject),
            });

            const result = await response.json(); // result should contain { message: "...", restartNeededKeys: [] }
            let alertMessage = result.message || '配置保存操作已完成。';
            
            // 可以在这里更友好地展示需要重启的项，但 alert 功能有限
            // if (result.restartNeededKeys && result.restartNeededKeys.length > 0) {
            //    alertMessage += `\n以下配置项需要重启服务器才能生效: ${result.restartNeededKeys.join(', ')}`;
            // }
            alert(alertMessage);

            // 保存成功后重新加载配置以显示最新的状态（包括重启提示）
            // 触发一次自定义事件或直接调用加载函数
            document.dispatchEvent(new Event('configupdated'));

        } catch (error) {
            console.error('保存配置失败:', error);
            alert('保存配置失败，请检查服务器连接。');
        }
    });
});

// 监听配置更新事件，重新加载配置
document.addEventListener('configupdated', async () => {
    console.log('配置已更新，重新加载前端显示...');
    try {
        const response = await fetch('/api/config');
        const configData = await response.json();
        const form = document.getElementById('configForm');
        for (const [key, configItem] of Object.entries(configData)) {
            const input = form.querySelector(`[name="${key}"]`);
            const noticeElement = document.getElementById(`${key}_restart_notice`);
            if (input) {
                if (input.type === 'checkbox') {
                    input.checked = String(configItem.value).toLowerCase() === 'true';
                } else {
                    input.value = configItem.value !== null && configItem.value !== undefined ? configItem.value : '';
                }
            }
            if (noticeElement) {
                if (configItem.requiresRestart) {
                    noticeElement.textContent = '(需要重启)';
                } else {
                    noticeElement.textContent = '(热更新)';
                }
            }
        }
    } catch (error) {
        console.error('重新加载配置失败:', error);
    }
});