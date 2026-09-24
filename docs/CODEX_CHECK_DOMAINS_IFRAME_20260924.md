# iframe 检查范围：六组 Codex 配对复测

日期：2026-09-24。Tablaze 在干净提交 [`6dfa4ad`](https://github.com/SweetDianDian/tablaze/commit/6dfa4add7498e7e7d6047685e780215b7c26fa2a)（空工作树补丁 SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）上运行；Browser Use Python Agent 0.13.10 固定在 [`d8110c5`](https://github.com/browser-use/browser-use/tree/d8110c5ff87ccba887aaa726cdb780f2f84bef8d)。两侧使用已登录 Codex CLI `0.155.0-alpha.9.2`、`gpt-6-astra / ultra`、50,000 已报告 token 上限、40 步和 240 秒截止时间。Tablaze 开启任务中唯一网址的直开选项；Browser Use 保留默认任务后评审。六组种子 100–105 交替决定先跑哪一侧，每次使用独立 Chrome 与重置的本地服务端。

任务是在子 iframe 保存 `Vega`。独立服务端验收要求恰好一次正确写入，不接受重复写入。下表每格为 **全程秒数 / Agent 完成秒数 / 模型调用次数**；Browser Use 的全程和模型调用次数包括默认任务后评审，Agent 完成时间不包括。两种计时的起点也不同。

| 种子 | Tablaze | Browser Use | Tablaze 验收路径 |
| ---: | ---: | ---: | --- |
| 100 | 42.247 / 42.100 / 2 | 53.318 / 38.021 / 3 | 同次 `post_checks` |
| 101 | 38.937 / 38.780 / 2 | 70.992 / 51.008 / 3 | 同次 `post_checks` |
| 102 | 36.824 / 36.674 / 2 | 69.930 / 50.054 / 3 | 同次 `post_checks` |
| 103 | 50.625 / 50.479 / 3 | 80.246 / 53.813 / 3 | 单独 `tab_verify` |
| 104 | 61.073 / 60.909 / 3 | 68.016 / 38.923 / 3 | 单独 `tab_verify` |
| 105 | 42.389 / 42.225 / 2 | 60.235 / 41.372 / 3 | 同次 `post_checks` |

双方均 **6/6** 通过服务端业务验收、Agent 完成与截止时间检查；每次恰好一次正确写入，零重复。Tablaze 六次都在第 0 步打开任务网址，且 **0/6** 次把输入值误当成页面正文检查。四次在 `tab_act` 同次通过字段值与可见保存状态检查，用两次模型调用完成；另两次先操作，再单独 `tab_verify`，用三次模型调用。验证引擎没有删除或改写任何请求的检查。

六组 Agent 完成时间中位数为 **42.162 秒 Tablaze 对 45.713 秒 Browser Use**；全程中位数为 **42.318 对 68.973 秒**，后者包含 Browser Use 默认评审。种子 104 的 Tablaze Agent 仍明显慢于 Browser Use（**60.909 对 38.923 秒**），不能只用中位数声称稳定领先。Browser Use 的三次模型调用通常包括任务后评审，不能直接和 Tablaze 的规划调用数相减。

前一版同任务的三个种子 100–102 中，Tablaze [三次都提交了无效的输入值正文检查](CODEX_DIRECT_TASK_URL_20260924.md)，再等待约五秒并额外规划；本次同三个种子及新增的三个种子均未再出现该检查。这与模型可见的 `text` / `value` 范围说明改动方向一致，但两批运行发生在不同时间、没有同时随机分配旧版与新版，因此不构成严格因果证明。两个新增种子仍未预先声明同次验收条件。可见合成页面、六组样本和 Codex CLI 的逐次输出控制限制了外推范围；p95、生产应用、其他 Browser Use 产品形态及整体优势尚未验证。

未改写的 [运行器结果](evidence/check-domains-iframe-20260924/results.json) SHA-256 为 `6338e6dce078538d606d1d0b3077b66fc65d3d21fc82ad2e0105633fe9836eea`。[轨迹索引](evidence/check-domains-iframe-20260924/README.md)链接全部 12 条原始轨迹。
