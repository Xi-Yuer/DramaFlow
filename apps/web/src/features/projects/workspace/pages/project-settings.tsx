'use client';

import { Alert, Button, Form, Input } from 'antd';
import { useRef } from 'react';
import { useProjectMetadata } from '@/features/workflow/editor/project/use-project-metadata';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import { useProjectNavigationGuard, useProjectWorkspace } from '../workspace-context';
import styles from '../workspace.module.css';

export function ProjectSettings() {
  const { project } = useProjectWorkspace();
  const graphSession = useRef(null);
  const metadata = useProjectMetadata(project, graphSession);
  const { requestLeave } = useLeaveGuard(
    metadata.dirty || metadata.saving || metadata.reloadingProject,
    '确认离开项目设置？',
    '未保存的项目名称或尚未确认的保存操作只保留在当前页面。',
  );
  useProjectNavigationGuard(requestLeave);

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1>项目设置</h1>
        <p>管理项目基本信息。</p>
      </div>
      <div className={styles.settings}>
        {metadata.projectError ? (
          <Alert
            showIcon
            type={metadata.conflict ? 'warning' : 'error'}
            title={metadata.conflict ? '项目信息已在其他页面更新' : '项目信息保存未确认'}
            description={`${metadata.projectError} 当前本地修改仍保留。`}
            action={
              <Button
                loading={metadata.reloadingProject}
                disabled={metadata.saving}
                onClick={metadata.reloadProject}
              >
                重新读取项目信息
              </Button>
            }
          />
        ) : null}
        <section className={styles.card} aria-label="项目基本信息">
          <Form layout="vertical" onFinish={() => void metadata.save()}>
            <Form.Item label="项目名称" htmlFor="project-name" required>
              <Input
                id="project-name"
                value={metadata.name}
                maxLength={80}
                onChange={(event) => metadata.setName(event.target.value)}
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={metadata.saving}
              disabled={!metadata.dirty || metadata.conflict || metadata.reloadingProject}
            >
              保存项目信息
            </Button>
          </Form>
        </section>
        <section className={styles.card} aria-label="删除项目">
          <h2>删除项目</h2>
          <p className={styles.description}>
            删除项目及其视频作品、工作流和运行数据，此操作不能撤销。
          </p>
          <Button
            danger
            onClick={metadata.removeProject}
            disabled={metadata.saving || metadata.reloadingProject}
          >
            删除项目
          </Button>
        </section>
      </div>
    </main>
  );
}
