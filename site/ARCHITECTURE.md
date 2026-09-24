# Tablaze 架构图

以下区分已发布的浏览器/Agent 主链路，与仍在本地开发的独立模型提取入口。官网演示页面是静态展示层，不参与真实浏览器任务执行。

```mermaid
flowchart LR
    U[使用者或上层应用]
    X[外部 Agent<br/>Codex 等 MCP 客户端]
    C[tablaze run<br/>内置 Agent CLI]

    subgraph Reasoning[规划与控制]
      P[显式选择的模型规划器<br/>Codex CLI / Anthropic / Ollama / 兼容接口]
      A[Agent 循环<br/>观察 → 决策 → 执行 → 验证]
      G[预算、暂停、恢复与备用模型切换]
    end

    subgraph Browser[Tablaze 浏览器执行层]
      M[MCP 工具服务<br/>stdio 或内存连接]
      V[参数校验、导航策略、密钥别名<br/>快照引用和会话隔离]
      E[BrowserEngine / Playwright]
      B[(自有 Chrome 上下文<br/>或显式连接 CDP)]
    end

    subgraph Outputs[结果与审计]
      Q[明确验收<br/>tab_verify / tab_act post_checks]
      K[检查点、调用计数与模型用量]
      R[录像、HAR、Trace、下载等可选产物]
    end

    U --> X -->|MCP 工具调用| M
    U --> C --> A
    A <-->|每步规划| P
    G --> A
    A -->|内存 MCP 工具调用| M
    M --> V --> E --> B
    B -->|观察和操作结果| E
    E --> Q --> A
    A --> K
    E --> R

    subgraph Extract[本地开发中：独立模型提取入口]
      I[调用方提供有界来源文本与 JSON Schema]
      D[单独选择的提取模型]
      F[Schema 与逐字段原文引用校验]
      O[结构化数据与来源位置]
      I --> D --> F --> O
    end

    U -.-> I
```

外部 MCP 模式由客户端决定下一步，Tablaze 只执行浏览器工具，不自行调用模型。`tablaze run` 则将显式配置的模型接入同一套浏览器工具；完成状态需要当前会话中的实际验收证据。浏览器写入在故障恢复时不会自动重放。独立提取入口读取调用方给出的文本，不自行打开来源网址；这条路径尚未并入 Agent 的页面任务流程。
