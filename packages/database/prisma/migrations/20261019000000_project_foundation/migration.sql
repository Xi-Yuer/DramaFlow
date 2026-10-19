-- 仅移除本轮废弃的节点草稿与插件安装数据，保留项目和身份记录。
BEGIN;

ALTER TABLE "canvas_project"
  DROP COLUMN "definition",
  DROP COLUMN "nodeCount";

DROP TABLE "plugin_installation";

COMMIT;
