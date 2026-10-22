-- 把库里遗留的 PascalCase 表改成 lowercase snake_case，保留全部行。
-- 这些表不在当前 Prisma schema 中，既有迁移也未创建它们；新库没有这些表时本文件为空操作。
-- 不删除表、不改列、不改写已经执行过的历史迁移。
-- workflow、workflow_version、asset_version 已被现行表占用，不能直接占用这些名字。
-- user 是 PostgreSQL 保留字，不能作为无需双引号的表名；现行用户表已是 auth_user。
-- 因此这四张旧表改为 workspace_workflow、workspace_workflow_version、workspace_asset_version、workspace_user。

DO $$
DECLARE
  old_table text;
  new_table text;
  rest text;
  new_ident text;
  constraint_name text;
  index_name text;
  sequence_name text;
BEGIN
  FOR old_table, new_table IN
    SELECT *
    FROM (
      VALUES
        ('Account', 'account'),
        ('Asset', 'asset'),
        ('AssetVersion', 'workspace_asset_version'),
        ('ChatMessage', 'chat_message'),
        ('ContextTrace', 'context_trace'),
        ('Conversation', 'conversation'),
        ('ConversationSummary', 'conversation_summary'),
        ('HumanTask', 'human_task'),
        ('ModelConnection', 'model_connection'),
        ('NodeAttempt', 'node_attempt'),
        ('Operation', 'operation'),
        ('PluginInstallation', 'plugin_installation'),
        ('Run', 'run'),
        ('RunEvent', 'run_event'),
        ('Session', 'session'),
        ('Suggestion', 'suggestion'),
        ('User', 'workspace_user'),
        ('Verification', 'verification'),
        ('Workflow', 'workspace_workflow'),
        ('WorkflowVersion', 'workspace_workflow_version'),
        ('Workspace', 'workspace'),
        ('WorkspaceMember', 'workspace_member')
    ) AS mapping(old_name, new_name)
  LOOP
    IF to_regclass(format('public.%I', old_table)) IS NULL THEN
      CONTINUE;
    END IF;
    IF to_regclass(format('public.%I', new_table)) IS NOT NULL THEN
      RAISE EXCEPTION '表 % 已存在，拒绝把 % 重命名覆盖它', new_table, old_table;
    END IF;

    EXECUTE format('ALTER TABLE public.%I RENAME TO %I', old_table, new_table);

    FOR constraint_name IN
      SELECT con.conname
      FROM pg_constraint AS con
      WHERE con.conrelid = to_regclass(format('public.%I', new_table))
        AND con.conname !~ '^[a-z][a-z0-9_]*$'
      ORDER BY con.conname
    LOOP
      IF left(constraint_name, char_length(old_table) + 1) = old_table || '_' THEN
        rest := substring(constraint_name FROM char_length(old_table) + 1);
      ELSE
        rest := '_' || constraint_name;
      END IF;
      new_ident := lower(
        regexp_replace(
          regexp_replace(new_table || rest, '([a-z0-9])([A-Z])', '\1_\2', 'g'),
          '([A-Z]+)([A-Z][a-z])',
          '\1_\2',
          'g'
        )
      );
      IF char_length(new_ident) > 63 THEN
        RAISE EXCEPTION '约束名超过 63 字符：%', new_ident;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM pg_constraint AS existing
        WHERE existing.conname = new_ident
          AND existing.connamespace = 'public'::regnamespace
          AND existing.oid <> (
            SELECT current_constraint.oid
            FROM pg_constraint AS current_constraint
            WHERE current_constraint.conrelid = to_regclass(format('public.%I', new_table))
              AND current_constraint.conname = constraint_name
          )
      ) THEN
        RAISE EXCEPTION '约束名 % 已被占用', new_ident;
      END IF;
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        new_table,
        constraint_name,
        new_ident
      );
    END LOOP;

    FOR index_name IN
      SELECT index_relation.relname
      FROM pg_index AS indexed
      JOIN pg_class AS index_relation ON index_relation.oid = indexed.indexrelid
      WHERE indexed.indrelid = to_regclass(format('public.%I', new_table))
        AND index_relation.relname !~ '^[a-z][a-z0-9_]*$'
      ORDER BY index_relation.relname
    LOOP
      IF left(index_name, char_length(old_table) + 1) = old_table || '_' THEN
        rest := substring(index_name FROM char_length(old_table) + 1);
      ELSE
        rest := '_' || index_name;
      END IF;
      new_ident := lower(
        regexp_replace(
          regexp_replace(new_table || rest, '([a-z0-9])([A-Z])', '\1_\2', 'g'),
          '([A-Z]+)([A-Z][a-z])',
          '\1_\2',
          'g'
        )
      );
      IF char_length(new_ident) > 63 THEN
        RAISE EXCEPTION '索引名超过 63 字符：%', new_ident;
      END IF;
      IF to_regclass(format('public.%I', new_ident)) IS NOT NULL THEN
        RAISE EXCEPTION '索引名 % 已被占用', new_ident;
      END IF;
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', index_name, new_ident);
    END LOOP;

    FOR sequence_name IN
      SELECT sequence_relation.relname
      FROM pg_depend AS dependency
      JOIN pg_class AS sequence_relation
        ON sequence_relation.oid = dependency.objid
        AND sequence_relation.relkind = 'S'
      WHERE dependency.refobjid = to_regclass(format('public.%I', new_table))
        AND sequence_relation.relname !~ '^[a-z][a-z0-9_]*$'
      ORDER BY sequence_relation.relname
    LOOP
      IF left(sequence_name, char_length(old_table) + 1) = old_table || '_' THEN
        rest := substring(sequence_name FROM char_length(old_table) + 1);
      ELSE
        rest := '_' || sequence_name;
      END IF;
      new_ident := lower(
        regexp_replace(
          regexp_replace(new_table || rest, '([a-z0-9])([A-Z])', '\1_\2', 'g'),
          '([A-Z]+)([A-Z][a-z])',
          '\1_\2',
          'g'
        )
      );
      IF char_length(new_ident) > 63 THEN
        RAISE EXCEPTION '序列名超过 63 字符：%', new_ident;
      END IF;
      IF to_regclass(format('public.%I', new_ident)) IS NOT NULL THEN
        RAISE EXCEPTION '序列名 % 已被占用', new_ident;
      END IF;
      EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', sequence_name, new_ident);
    END LOOP;
  END LOOP;

  IF to_regclass('public.run_event') IS NOT NULL
    AND to_regclass('public.run_event_id_seq') IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.run_event ALTER COLUMN id SET DEFAULT nextval(%L)',
      'public.run_event_id_seq'
    );
  END IF;
END $$;
