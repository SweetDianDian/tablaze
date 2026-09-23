# Codex 跨来源授权弹窗开发任务

日期：2026-09-23。**Tablaze 与 Browser Use 在本次可见开发任务中各完整成功一次；Browser Use 的全程时间略短。一次配对不能证明稳定速度或整体功能优势。**

任务使用两个独立的本地 HTTP 来源：主页面打开授权弹窗，弹窗向提供方服务提交一次授权，再通过限定来源的 `postMessage` 通知原标签页；主页面收到凭据后才能完成一次提交。独立服务端评审要求 **授权 1 次、正确提交 1 次、重复写入 0 次**。这是合成的登录返回流程，不是生产 OAuth、真实账户持久化或安全性认证。

| 指标 | Tablaze | Browser Use |
| --- | ---: | ---: |
| 独立业务验收 / Agent 成功 / 期限内返回 | 全部通过 | 全部通过 |
| 授权 / 正确写入 / 重复写入 | 1 / 1 / 0 | 1 / 1 / 0 |
| 全程耗时 | 123.719 秒 | 119.515 秒 |
| 模型调用 / 工具调用 | 8 / 7 | 6 / 6 |
| 输入 / 输出 tokens | 127,014 / 1,245 | 111,839 / 1,517 |

全程耗时从共同外部期限开始，包含启动、Agent 返回、清理、独立验收和网关收尾。Browser Use 保留默认模型评审；其中输入 17,186、输出 228 tokens **已包含在总量中**。Tablaze 使用 `follow-single` 弹窗策略、`initializeUrl=false`；两框架工具和结束后处理不同，不能把时间差解释为浏览器引擎效率差。旧五任务、订单复测和虚拟列表任务的结果保持独立，不与本次拼接成功率。

双方使用同一 `gpt-6-astra`、`ultra` 推理设置、Codex CLI `0.155.0-alpha.9.2` 连接层、250,000-token 网关预算、240 秒期限、本地 Chrome、1280×800 视口。Browser Use 固定版本 `0.13.10`，commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`；它的默认评审未关闭。CLI 连接层含自身固定指令，温度与每次输出上限没有经过验证；这不是直接模型 API 对比。两侧各运行一次，没有置信区间。

[公开 JSON 证据](evidence/codex-auth-return-smoke-v1.json)记录服务端判断、完成轴、计时、用量、运行配置和源码哈希。完整本机结果 `artifacts/comparison/auth-return-matched-v1/results.json` 的 SHA-256 为 `eaa4ba80a475000734bdfce0a175918bb71575ccbce3dcd8c8f3f6daae3b7ac1`，并保留两侧轨迹。测量时的基础 commit 为 `57ce6aedf05845bd1bfed265d759f1411669d4a9`，工作区 patch SHA-256 为 `20fb1752d18e2a59fb7ae8d36881ecd4d8a514e39830a05b1e85d38476bc0014`；报告不冒充后续提交的重新测量。

依照[对比运行说明](https://github.com/SweetDianDian/tablaze/blob/main/bench/comparison/README.md)准备固定版本后，可用新目录复测：

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /private/tmp/tablaze-comparison-env/bin/python \
  --tasks auth-return --repeat 1 --max-steps 40 --max-tool-calls 150 \
  --timeout-ms 240000 --token-budget 250000 \
  --tablaze-initialize-url false --tablaze-popup-policy follow-single \
  --browser-use-judge true --output artifacts/comparison/a-new-output-directory
```
