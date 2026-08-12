# 客服会话工作台浏览器回归

本仓库保存客服会话工作台回归材料和独立运行入口。artifacts目录包含任务附件，task目录包含题面正文，verification目录负责在Windows中运行浏览器业务场景。

在Node.js24环境执行npm run verify。程序安装锁文件依赖与Chromium后启动真实浏览器，核对角色范围、Socket事件、队列排序、详情、键盘焦点、SLA文案及输入保全。事件输入调整后，页面观察值应随业务数据变化。

GitHub工作流使用windows-2025和PowerShell。最终证据记录当前提交、运行编号、托管机信息、软件版本、四附件SHA-256、退出码和结构化结果。本地复跑会重新生成verification/evidence/windows-verification.json。
