# 已迁移：findings 的事实源现在是 `docs/research/`

本目录的三份 findings 副本**已于 2026-09-22 废弃**，事实源迁至 **`docs/research/`**：

| 旧位置（本目录） | 新位置（唯一事实源） |
|---|---|
| `R1-api-mapping.md` | `docs/research/R1-api-mapping.md` |
| `R2-pickup-code-semantics.md` | `docs/research/R2-pickup-code-semantics.md` |
| `R3-open-gaps.md` | `docs/research/R3-open-gaps.md` |

## 为什么要迁

`.scratch/` 按仓库约定是 throwaway，但 findings 是**已关闭 D 票裁决的证据链**（D1–D5 的每条结论都指向它）。放在 throwaway 目录里，加上本目录与一次性分支 `research/r*` **双写**，已经造成过一次真实事故：

> ⚠️ 本目录的 `R1-api-mapping.md` 副本一度停在 **511 行**，正文仍把 `13.16` 积分明细标为「`[未明确]`，需联调确认」，而下游 **D4（`#8`）已复核推翻该结论**（字段形状就在 `API设计文档.md` §9.3 `:588-596`，是漏读）。照本目录行事的读者会重新得出一个**已被否决**的结论。

## 现在怎么读

**直接读 `docs/research/`**，不要读本目录（保留仅为不破坏历史链接）。

分支 `research/r1-api-mapping` / `research/r2-pickup-code-semantics` / `research/r3-open-gaps` / `research/d5-reservation-contract` 同样**仅作历史保留**，正文与 `docs/research/` 逐字一致。
