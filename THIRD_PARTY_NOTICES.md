# Third-party notices

The MIT licence in [LICENSE](LICENSE) covers this repository's own work: the organ kernel, the plugins
under `workspace/plugins/` written for this project, the scripts, and the documentation.

Several parts of this repository are not our work and keep their upstream terms:

| Path | What it is | Terms |
| --- | --- | --- |
| `app/` | A vendored checkout of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (host source + build output) | See [`app/LICENSE`](app/LICENSE) and [`app/THIRD_PARTY_NOTICES.md`](app/THIRD_PARTY_NOTICES.md) |
| `workspace/plugins/dsh-quant` | Quant toolkit | Upstream terms, kept in the plugin directory |
| `workspace/plugins/dsh-usage` | Usage/balance panel | Upstream terms, kept in the plugin directory |
| `guizang-social-card-skill` | Social card design system | Upstream terms, kept in the directory |
| `workspace/plugins/dsh-crawl4ai` | Legacy crawler (kept for rollback) | Upstream terms, kept in the plugin directory |
| `workspace/plugins/dsh-web-crawl/vendor/` | Vendored Python dependencies for the crawler | Individual package licences under `vendor/` |

Plugins that are **ports** of upstream projects say so in their `package.json` description and in their
own README; their upstream licence ships alongside them.

If you redistribute this repository, keep these notices with it and replace `data/` (which is ignored and
holds live credentials) with your own configuration.
