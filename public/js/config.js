// 页面加载时执行
document.addEventListener('DOMContentLoaded', async () => {
    // 加载配置
    try {
        const response = await fetch('/api/config');
        const configData = await response.json();
        
        // 填充表单字段
        const form = document.getElementById('configForm');
        for (const [key, value] of Object.entries(configData)) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                if (input.type === 'checkbox') {
                    input.checked = value === 'True' || value === true;
                } else {
                    input.value = value;
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

            const result = await response.json();
            alert(result.message || '配置已保存');
        } catch (error) {
            console.error('保存配置失败:', error);
            alert('保存配置失败，请检查服务器连接。');
        }
    });
});