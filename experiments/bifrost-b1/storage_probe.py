"""只输出实验 SQLite 表计数；数据库字节经 stdin，临时文件仅在独立测试容器。"""

import base64
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

files = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
    for name, value in files.items():
        if name not in ["platform.db", "platform.db-wal", "platform.db-shm"]:
            raise ValueError("不允许的实验数据库路径")
        Path(directory, name).write_bytes(base64.b64decode(value))
    database = Path(directory, "platform.db")
    if not database.exists():
        raise FileNotFoundError("没有读取到实际 config store 文件")
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    names = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    counts = {}
    for name in names:
        if name.startswith(("config_", "governance_model")) or "pricing" in name:
            safe = name.replace('"', '""')
            counts[name] = connection.execute(f'SELECT COUNT(*) FROM "{safe}"').fetchone()[0]
    print(json.dumps({"tableCounts": counts}))
    connection.close()
