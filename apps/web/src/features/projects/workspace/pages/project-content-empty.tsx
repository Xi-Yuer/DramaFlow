import { Empty } from 'antd';
import { Film, FolderOpen } from 'lucide-react';
import styles from '../workspace.module.css';

export function ProjectContentEmpty({ kind }: { kind: 'videos' | 'assets' }) {
  const video = kind === 'videos';
  const Icon = video ? Film : FolderOpen;
  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1>{video ? '视频' : '素材'}</h1>
        <p>{video ? '项目的视频作品空间。' : '项目的创作素材空间。'}</p>
      </div>
      <div className={styles.empty}>
        <Empty
          image={<Icon size={48} aria-hidden />}
          styles={{ image: { height: 48, color: 'var(--muted)' } }}
          description={
            <>
              <p>{video ? '视频作品管理尚未开放' : '素材管理尚未开放'}</p>
              <span className={styles.description}>
                {video
                  ? '你可以先通过工作流组织创作步骤，当前生成结果在工作流运行中查看。'
                  : '当前可在工作流中查看生成结果，项目素材的上传与整理功能将在后续提供。'}
              </span>
            </>
          }
        />
      </div>
    </main>
  );
}
