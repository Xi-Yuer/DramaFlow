BEGIN;
ALTER TABLE "node_run" DROP CONSTRAINT "node_run_lifecycle";
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_lifecycle" CHECK (
  ("status" = 'running' AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
  ("status" = 'completed' AND "completedAt" IS NOT NULL AND "inputs" IS NOT NULL AND "outputs" IS NOT NULL AND "error" IS NULL) OR
  ("status" = 'failed' AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NOT NULL) OR
  ("status" = 'cancelled' AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NULL)
);
ALTER TABLE "child_execution" DROP CONSTRAINT "child_execution_lifecycle";
ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_lifecycle" CHECK (
  ("status" = 'running' AND "completedAt" IS NULL AND "error" IS NULL) OR
  ("status" IN ('completed', 'cancelled') AND "completedAt" IS NOT NULL AND "error" IS NULL) OR
  ("status" = 'failed' AND "completedAt" IS NOT NULL AND "error" IS NOT NULL)
);
-- ChildExecution 已有终态保护；NodeRun 同样不能被迟到写回覆盖。
CREATE FUNCTION "guard_node_run_terminal"() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'NodeRun terminal record is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_run_terminal_guard" BEFORE UPDATE ON "node_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_node_run_terminal"();
COMMIT;
