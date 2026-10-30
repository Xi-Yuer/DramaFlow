'use client';

import { Film, FolderOpen, Workflow } from 'lucide-react';
import { useProjectWorkspace } from '../workspace-context';
import { WorkspaceLink } from '../workspace-link';
import styles from '../workspace.module.css';

export function ProjectOverview() {
  const { project } = useProjectWorkspace();
  const base = `/projects/${project.id}`;
  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1>项目概览</h1>
        <p>在「{project.name}」中展开你的视频创作，工作流负责组织生成步骤与运行。</p>
      </div>
      <div className={styles.cards}>
        <section className={styles.card}>
          <Film size={24} aria-hidden />
          <h2>视频</h2>
          <p className={styles.description}>
            创建视频作品、维护基础信息，并进入每个作品的独立空间。
          </p>
          <WorkspaceLink href={`${base}/videos`}>查看视频空间</WorkspaceLink>
        </section>
        <section className={styles.card}>
          <FolderOpen size={24} aria-hidden />
          <h2>素材</h2>
          <p className={styles.description}>项目的创作素材空间，素材管理功能尚未开放。</p>
          <WorkspaceLink href={`${base}/assets`}>查看素材空间</WorkspaceLink>
        </section>
        <section className={styles.card}>
          <Workflow size={24} aria-hidden />
          <h2>工作流</h2>
          <p className={styles.description}>
            管理项目中的多个工作流，分别编辑草稿、发布版本并查看运行结果。
          </p>
          <WorkspaceLink href={`${base}/workflows`}>查看工作流</WorkspaceLink>
        </section>
      </div>
    </main>
  );
}
