# Tablaze 架构图

下图描述当前代码中的真实运行链路。两种入口共用浏览器工具层：外部 Agent 自己决定下一步；`tablaze run` 使用显式配置的模型执行内置 Agent 循环。

```mermaid
flowchart TB
  U["使用者 / 上层应用"]

  subgraph Entry["入口"]
    EXT["外部 Agent<br/>Codex 等 MCP 客户端"]
    CLI["tablaze run<br/>内置 Agent CLI"]
  end

  subgraph Agent["内置 Agent 控制层"]
    LOOP["任务循环<br/>观察 → 规划 → 执行 → 验收"]
    MODEL["显式配置的规划模型<br/>Codex CLI / Anthropic / Ollama / 兼容接口"]
    CONTROL["预算、暂停与恢复<br/>检查点、重试与备用模型"]
    INIT["可信预设动作<br/>打开页面 / 新标签页 / 唯一名称点击"]
    EXTRACT["可选独立模型提取<br/>页面来源 → Schema / 原文引用校验"]
  end

  subgraph Tools["共用浏览器工具层"]
    MCP["MCP 工具服务<br/>打开 / 快照 / 操作 / 验证 / 提取"]
    GUARD["校验与策略<br/>会话、快照引用、导航、文件、密钥"]
  end

  subgraph Runtime["浏览器运行层"]
    ENGINE["BrowserEngine + Playwright"]
    CHROME["隔离的 Chrome 上下文<br/>或显式连接 CDP"]
    PAGE["目标网页<br/>DOM / iframe / 弹窗 / 下载"]
  end

  subgraph Output["结果与可选产物"]
    VERIFY["验收证据<br/>tab_act post_checks / tab_verify"]
    RESULT["任务状态、结构化结果<br/>调用次数与检查点"]
    ARTIFACT["可选录像、HAR、Trace"]
  end

  U --> EXT -->|"MCP 调用"| MCP
  U --> CLI --> LOOP
  LOOP <-->|"规划决策"| MODEL
  CONTROL --> LOOP
  CLI --> INIT -->|"模型规划前，逐项记录"| MCP
  LOOP -->|"内存 MCP 调用"| MCP
  LOOP -.->|"启用时"| EXTRACT
  EXTRACT -->|"读取真实页面"| MCP
  EXTRACT -.->|"校验后的数据"| LOOP
  MCP --> GUARD --> ENGINE --> CHROME --> PAGE
  PAGE -->|"观察与操作结果"| ENGINE
  ENGINE --> VERIFY --> LOOP
  LOOP --> RESULT
  ENGINE --> ARTIFACT
```

**验收边界：**浏览器工具执行成功不等于用户任务完成。内置 Agent 只有在当前会话的操作之后取得通过的验收证据，才可报告成功；跨页面跳转后的结果需要重新观察和验证。写入操作在恢复时不会自动重放。

**独立系统：**官网及演示视频是静态展示，不在任务执行链路内；`bench/comparison` 是独立的 Browser Use 对比基准，用相同任务、模型配置和服务端业务验收记录两侧结果。架构图表示已实现的模块，不表示已经达到 Browser Use 的功能或效率全面对等。
