# Two-page initial-action evidence

The [default-judge paired results](results-paired.json) contain the original runner report for seeds 120–122 on clean Tablaze commit `5b6f26ace7ffb2c6ae7983343e80597488f4ee4e`. The [judge-disabled paired results](results-no-judge.json) use the same seeds on clean commit `2d431178e2bb1515c03c3acf54e868ff206a0a6c` with the same source tree. The 50,000-token [pilot](results-pilot-50k.json) is separate and excluded from both paired summaries. All pages and codes are synthetic fixture data. `tracePath` in the unmodified runner reports is the original local capture path; the portable copies are linked below.

| Seed | Tablaze trace | Browser Use trace |
| ---: | --- | --- |
| 120 | [raw](seed-120-tablaze.trace.json) | [raw](seed-120-browser-use.trace.json) |
| 121 | [raw](seed-121-tablaze.trace.json) | [raw](seed-121-browser-use.trace.json) |
| 122 | [raw](seed-122-tablaze.trace.json) | [raw](seed-122-browser-use.trace.json) |
| 110 pilot | [raw](seed-110-tablaze-pilot.trace.json) | [raw](seed-110-browser-use-pilot.trace.json) |

With Browser Use's optional post-task judge disabled:

| Seed | Tablaze trace | Browser Use trace |
| ---: | --- | --- |
| 120 | [raw](seed-120-tablaze-nojudge.trace.json) | [raw](seed-120-browser-use-nojudge.trace.json) |
| 121 | [raw](seed-121-tablaze-nojudge.trace.json) | [raw](seed-121-browser-use-nojudge.trace.json) |
| 122 | [raw](seed-122-tablaze-nojudge.trace.json) | [raw](seed-122-browser-use-nojudge.trace.json) |
