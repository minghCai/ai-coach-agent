# 数据口径与术语（跟随数据源最新版本）

> 本目录为「常驻底稿」。放进本目录的任意 `.md` 会按文件名前缀数字排序后整体注入分析上下文，无需改动任何代码。

## 指标口径

- `firstRate` = 登顶率
- `top3Rate` = 前三率
- `avgPlacement` = 平均名次（6 人局，均值 3.50）
- `avgLevel` = 平均等级
- `count` = 样本场次（样本量）

## 数据来源与局限

- 数据源：`api.datatft.com/wzwxq`，第三方非官方接口，无授权、无 SLA，随时可能失效。
- 榜单 `rows[].id` 仅为数字 ID，需经本地卡牌库（`data/cards/`）映射为名称/阵营/阶位。
- 条件概率（如阵容率）不等于真实胜率。

## 阵容榜（lineups）

- 阵容 = 一组英雄的固定组合；`lineupKey` 形如 `阵容人数|英雄id|英雄id|…`（英雄 id 升序）。
- `heroes` = 该阵容英雄全集；`coreHeroes` = 核心英雄子集；`commanders` = 常用棋手（自带各自场次与登场率）。
- `recommendedUnits` = 逐英雄出装推荐，`recommendationType` 取 `three_item`（三件套）/`single_item`（单件）/`none`。
- `appearanceRate` = 该阵容在阵容榜内的登场率，**不等于**单卡场次占比；`variantCount` = 该阵容的变体数。
- 采集：`POST /wzwxq/lineups/search`（GET 返回 405），单页上限 `pageSize=20`，落盘 `lineups-1.json` / `lineups-2.json`。
