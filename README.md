# 客服会话工作台浏览器回归

本仓库保存QID10078的最终任务材料和独立运行入口。artifacts目录包含四个最终附件，task目录包含题面正文，verification目录从附件准备两套干净环境并检查浏览器产物。

在Node.js24环境执行npm run verify。程序安装锁文件依赖与Chromium后，在两个带中文和空格的目录启动真实浏览器，核对角色范围、Socket事件、队列排序、详情、键盘焦点、SLA文案及输入保全。程序还会调整一项事件输入，确认页面观察值随业务数据变化；缺少角色文件时，测试应返回非零且不留下报告或截图。

GitHub工作流使用windows-2025和PowerShell。最终证据记录当前提交、运行编号、托管机信息、软件版本、四附件SHA-256、退出码和结构化结果。本地复跑会重新生成verification/evidence/windows-verification.json。
