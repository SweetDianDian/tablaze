# Tablaze 架构图

以下展示浏览器/Agent 主链路，以及配置 `--extraction-model` 后接入 Agent 的独立模型提取流程。官网演示页面是静态展示层，不参与真实浏览器任务执行。

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
      V[参数校验、导航与文件策略<br/>密钥别名、快照引用和会话隔离]
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

    subgraph Extract[可选：独立模型提取]
      T[tab_extract_model<br/>只接受会话、任务、Schema 与选择器]
      I[tab_extract 读取真实页面文本与框架 URL]
      D[单独选择的提取模型]
      F[Schema 与逐字段原文引用校验]
      O[结构化数据与来源位置]
      T --> I --> D --> F --> O
    end

    A -.->|配置后可调用| T
    I -->|浏览器读取| M
    O -.-> A
```

外部 MCP 模式由客户端决定下一步，Tablaze 只执行浏览器工具，不自行调用模型。`tablaze run` 则将显式配置的模型接入同一套浏览器工具；完成状态需要当前会话中的实际验收证据。CLI 默认禁止模型读取任意本机上传文件，操作员可提供受信任文件清单或在启动时导入私有认证状态；这两项策略与检查点绑定。浏览器写入在故障恢复时不会自动重放。配置独立提取模型后，Agent 可调用 `tab_extract_model`，它从当前浏览器会话读取来源，不接受模型伪造的页面文本或 URL。提取结果的原文引用仅证明片段存在；Agent 仍需页面核验，业务语义与完整性还需应用验收。独立的 `tablaze-extract` 命令仍可处理调用方提供的多个来源文本。
