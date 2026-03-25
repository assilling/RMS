# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本项目中工作时提供指导。

## 项目概述

这是一个 RCS（机器人控制系统）项目，用于管理仓库/物流自动化中的 3000+ 台 AGV/AGR 机器人。项目包含：

- **前端模板**：用于仓库管理的 HTML/CSS/JS 页面（日语界面）
- **产品规格**：SpecWeave 管理的需求和增量计划
- **架构**：大规模机器人调度控制系统

## 架构

### 前端（HTML 模板）
- 独立的 HTML 文件，内嵌 CSS/JS
- 日语界面
- 组件包括：布局、侧边栏、列表（容器、设备、位置、货架、区域、异常）、详情页面、波次管理
- 后端使用 Firebase 集成

### 产品规格（.specweave/）
- FEATURE.md：3000 台机器人 RCS 的完整系统规范
- Increments：模块化实施阶段（INC-001：核心框架）
- 包含：spec.md、plan.md、tasks.md、metadata.json

## 关键文件

| 文件 | 用途 |
|------|------|
| layout.html | 带侧边栏的主布局模板 |
| sidebar.html | 导航侧边栏组件 |
| *list.html | 列表视图（容器、设备、位置、货架、区域、异常） |
| *detail.html | 详情视图 |
| wave_management.html | 波次/批量任务管理 |
| .specweave/ | 产品需求和规划 |

## 命令

这是一个以前端和产品规格为主的项目：
- 无需构建命令 - 纯 HTML/CSS/JS
- 可直接在浏览器中打开 HTML 文件预览
- 可使用任何文本编辑器编辑（推荐 VS Code）

## 开发说明

- 界面为日语（RMS = 机器人管理系统）
- 使用原生 HTML/CSS/JS（无框架）
- 使用 Firebase 实现实时数据
- 专注于仓库/机器人管理 UI 组件
