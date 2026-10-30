import { Empty } from 'antd';
import { FolderOpen } from 'lucide-react';
import styles from '../workspace.module.css';

export function ProjectAssets() {
  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1>素材</h1>
        <p>项目的创作素材空间。</p>
      </div>
      <div className={styles.empty}>
        <Empty
          image={<FolderOpen size={48} aria-hidden />}
          styles={{ image: { height: 48, color: 'var(--muted)' } }}
          description={
            <>
              <p>素材管理尚未开放</p>
              <span className={styles.description}>
                当前可在工作流中查看生成结果，项目素材的上传与整理功能将在后续提供。
              </span>
            </>
          }
        />
      </div>
    </main>
  );
}
